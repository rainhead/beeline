import type { DuckDBConnection } from "@duckdb/node-api";
import { matchCollectors, type MatchedCollector } from "../collector-match.js";
import { upsertCorrections, type CorrectionEvent } from "../corrections.js";
import { withPrintRunLock } from "../print-run.js";
import { isWriteConflict } from "../write-conflict.js";
import { mirrorCorrectionsOn } from "./correction-store.js";

/**
 * Staff correcting who collected a sample (beeline-kgyd.4.5): adding,
 * removing and reordering its collectors, the first included, for the API and
 * the samples upload (beeline-kgyd.4). No page offers it yet (Peter,
 * 2026-11-18).
 *
 * The list is `sample_collector`, position 1 being the primary collector,
 * whose numbering the sample's number is (AGENTS.md). The names are matched
 * by src/collector-match.ts, the rule the trap form uses too; a list that
 * reads exactly as the sample's does now is unchanged without being matched,
 * so an upload row that repeats the sample's collectors is never refused over
 * a name. Nobody is created here.
 *
 * Where the correction is kept, by what the sample was built from:
 *
 * - From the old Beeline's records: one `recordedBy` event per record in the
 *   corrections file, the display names joined with " | " as the export
 *   writes them, mirrored into the store's correction tables, so the
 *   legacy-format export and `legacy:compare-export` read the records as
 *   corrected. Never `firstName` or `lastName`: promotion groups records into
 *   samples by them, and so do the tools still reading the old records on
 *   production (ingest/promote-legacy.sql says which), so changing them could
 *   have carry-over make a second sample under the old collector.
 * - Entered in Beeline, or made from an observation: `sample_collector` alone.
 *
 * What the first collector carries, and so what changing it is refused for:
 *
 * - `observation_tied`: the sample cites an observation, or one claims it
 *   (`sample_claiming_observation`), or an unlinked observation of the old or
 *   new first collector carries its number on its dates. Minting and account
 *   harvesting find a sample through its first collector's iNaturalist
 *   account (schema/108, ingest/harvest-inat-accounts.sql), so the trap's
 *   other observation, which minting deliberately passed over, could be
 *   minted as a new sample and its pins labelled twice. That case waits for
 *   minting to key on the observer (beeline-kgyd.4.7).
 * - `number_taken`: the new first collector already has a sample with this
 *   number on this start date, since the number is theirs for the day.
 *
 * Refused whatever changes while a print run that has not printed holds the
 * sample (`in_print_run`), since the run froze the collector line its labels
 * carry. Labels on paper name the old collectors, so the answer says how many
 * (`reprint_needed`) and staff ask for the reprint; nothing is requested here.
 *
 * The write is one transaction on the print connection, behind the print
 * runs' lock, as the trap form's and a staff point's are: the app's own
 * connection is shared by every request, so a transaction there would take
 * other requests' statements into it. The reads that decide the answer,
 * matching and the observation checks among them, run before the lock; the
 * lock then asks again what a print run or another writer could have changed.
 * The transaction ends by asking `sample_primary_collector_invalid`
 * (schema/116), and rolls back if the sample has no head or two. Callers run
 * it in the sample's queue turn (src/app/sample-queue.ts) and record the
 * history after it.
 */

export interface CollectorsInput {
  /** Names or references in order, the first being the primary collector. Blank entries are left out. */
  collectors: readonly string[];
  note: string;
  /** iNat login of whoever is acting: the events' author. */
  author: string;
  /** Work out the answer and write nothing. */
  dryRun: boolean;
}

export interface CollectorLine {
  position: number;
  person_id: number;
  name: string;
}

export type CollectorsResult =
  | {
      outcome: "saved" | "planned";
      collectors: CollectorLine[];
      first_changed: boolean;
      /** Labels on paper that print the old list: what a reprint would replace. */
      reprint_needed: number;
      /** What follows from the change, in sentences for staff. */
      warnings: string[];
    }
  | { outcome: "unchanged"; collectors: CollectorLine[] }
  | { outcome: "not_found" }
  | { outcome: "unavailable" }
  | { outcome: "invalid"; problem: string }
  | { outcome: "in_print_run" | "number_taken" | "observation_tied" }
  /** The list changed between working out the answer and writing it; nothing was done. */
  | { outcome: "changed" }
  /** The store write lost a write conflict and nothing was recorded anywhere. */
  | { outcome: "write_conflict" }
  /** The corrections file holds the change, but the store write lost a write conflict. */
  | { outcome: "not_applied" };

export interface CollectorsDeps {
  /** The app's connection, for an instance with no print connection of its own. */
  conn?: DuckDBConnection;
  /** The connection the write's transaction runs on. */
  printWriter?: DuckDBConnection;
  correctionsPath: string;
}

interface SampleRow {
  sample_number: string;
  date_start: string;
  date_end: string;
  inat_observation_id: bigint | null;
}

async function rows<T>(conn: DuckDBConnection, sql: string, params: unknown[] = []): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql, params as never);
  return reader.getRowObjectsJS() as T[];
}

async function exists(conn: DuckDBConnection, sql: string, params: unknown[]): Promise<boolean> {
  return (await rows<{ e: boolean }>(conn, `SELECT EXISTS (${sql}) AS e`, params))[0]?.e === true;
}

/** What the checks read of the sample: its number, its dates and the observation it cites. */
async function sampleRow(conn: DuckDBConnection, sampleId: number): Promise<SampleRow | undefined> {
  return (
    await rows<SampleRow>(
      conn,
      `SELECT sample_number, strftime(date_start, '%Y-%m-%d') AS date_start, strftime(date_end, '%Y-%m-%d') AS date_end, inat_observation_id
       FROM sample WHERE entity_id = $1`,
      [sampleId],
    )
  )[0];
}

/** The sample's collectors as they stand, in order. */
async function currentList(conn: DuckDBConnection, sampleId: number): Promise<MatchedCollector[]> {
  return (
    await rows<{ person_id: number; display_name: string }>(
      conn,
      `SELECT c.person_id, p.display_name FROM sample_collector c JOIN person p ON p.entity_id = c.person_id
       WHERE c.sample_id = $1 ORDER BY c.position`,
      [sampleId],
    )
  ).map((r) => ({ person_id: Number(r.person_id), display_name: r.display_name }));
}

const sameIds = (a: readonly MatchedCollector[], b: readonly MatchedCollector[]) =>
  a.length === b.length && a.every((c, i) => c.person_id === b[i]!.person_id);

const lines = (list: readonly MatchedCollector[]): CollectorLine[] =>
  list.map((c, i) => ({ position: i + 1, person_id: c.person_id, name: c.display_name }));

/** Whether labels for this sample are in a print run that has not printed. */
const heldByUnprintedRun = (conn: DuckDBConnection, sampleId: number) =>
  exists(conn, `SELECT 1 FROM sample_label_in_progress WHERE sample_id = $1 AND printing_count > 0`, [sampleId]);

/** Whether the new first collector already has a sample with this number on this start date. */
const numberTaken = (conn: DuckDBConnection, sampleId: number, sample: SampleRow, personId: number) =>
  exists(
    conn,
    `SELECT 1 FROM sample s JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
     WHERE pc.person_id = $1 AND s.sample_number = $2 AND s.date_start = $3::DATE AND s.entity_id <> $4`,
    [personId, sample.sample_number, sample.date_start, sampleId],
  );

/**
 * Whether an observation is tied to the sample through its first collector:
 * one it cites, one that claims it, or an unlinked one of the old first
 * collector's that minting matches to it. And for the new first collector, an
 * unlinked one of theirs with its number on its dates, which sample_mint_match
 * cannot answer while they are not first yet.
 */
async function observationTied(conn: DuckDBConnection, sampleId: number, sample: SampleRow, newFirst: number): Promise<boolean> {
  if (sample.inat_observation_id !== null) return true;
  if (await exists(conn, `SELECT 1 FROM sample_claiming_observation WHERE sample_id = $1`, [sampleId])) return true;
  if (await exists(conn, `SELECT 1 FROM sample_mint_match WHERE sample_id = $1`, [sampleId])) return true;
  return exists(
    conn,
    `SELECT 1 FROM sample_mint_group g
     WHERE g.person_id = $1 AND g.sample_number = $2 AND g.observed_on BETWEEN $3::DATE AND $4::DATE`,
    [newFirst, sample.sample_number, sample.date_start, sample.date_end],
  );
}

/** The old records the sample was built from, with what each says now; none for a sample not built from them. */
async function oldRecords(conn: DuckDBConnection, sampleId: number): Promise<{ _id: string; recordedBy: string | null }[]> {
  const promoted = await exists(conn, `SELECT 1 FROM duckdb_tables() WHERE table_name = 'legacy_specimen_number' AND NOT temporary`, []);
  if (!promoted) return [];
  return rows(
    conn,
    `SELECT o._id, o."recordedBy" AS "recordedBy" FROM legacy_specimen_number n JOIN legacy_occurrence o ON o._id = n._id
     WHERE n.sample_id = $1 ORDER BY o._id`,
    [sampleId],
  );
}

function warningsFor(before: readonly MatchedCollector[], after: readonly MatchedCollector[], sample: SampleRow, reprints: number): string[] {
  const out: string[] = [];
  const names = (list: readonly MatchedCollector[]) => list.map((c) => c.display_name).join(", ");
  if (before[0]!.person_id !== after[0]!.person_id) {
    out.push(
      `${after[0]!.display_name} is now the first collector, in place of ${before[0]!.display_name}: sample ${sample.sample_number} of ${sample.date_start} is numbered as theirs, its labels are mailed to them, and an iNaturalist observation of theirs with this number on these dates would be linked to it.`,
    );
  }
  const added = after.filter((c) => !before.some((b) => b.person_id === c.person_id));
  const removed = before.filter((c) => !after.some((a) => a.person_id === c.person_id));
  if (added.length > 0) {
    out.push(`${names(added)} now ${added.length === 1 ? "has" : "have"} what its collectors have: they see where it was collected even where iNaturalist hides that, and may correct it.`);
  }
  if (removed.length > 0) {
    out.push(
      `${names(removed)} ${removed.length === 1 ? "is" : "are"} no longer among its collectors, so that no longer lets them see where it was collected where iNaturalist hides that, or correct it (whoever entered a sample may still edit it on the trap form until it prints).`,
    );
  }
  if (reprints > 0) out.push(`${reprints} label${reprints === 1 ? "" : "s"} on paper print the old collectors: ask for a reprint once the change is made.`);
  return out;
}

export async function setStaffCollectors(deps: CollectorsDeps, sampleId: number, input: CollectorsInput): Promise<CollectorsResult> {
  // Read on the app's connection, write on the print connection: every
  // statement on the print connection is made behind the lock, so nothing
  // read there can land inside another writer's transaction.
  const conn = deps.conn ?? deps.printWriter;
  const writer = deps.printWriter ?? deps.conn;
  if (conn === undefined || writer === undefined) return { outcome: "unavailable" };
  const sample = await sampleRow(conn, sampleId);
  if (sample === undefined) return { outcome: "not_found" };
  const before = await currentList(conn, sampleId);
  const given = input.collectors.map((n) => n.trim()).filter((n) => n !== "");
  // Before the shortcut below, which a sample with no collectors at all would otherwise take (CodeRabbit).
  if (given.length === 0) return { outcome: "invalid", problem: "At least one collector is needed." };
  // The list as it reads now is no change, and needs no name matched.
  if (given.length === before.length && given.every((n, i) => n === before[i]!.display_name)) {
    return { outcome: "unchanged", collectors: lines(before) };
  }
  const matched = await matchCollectors(conn, given);
  if ("problem" in matched) return { outcome: "invalid", problem: matched.problem };
  const after = matched.collectors;
  if (sameIds(before, after)) return { outcome: "unchanged", collectors: lines(before) };

  const firstChanged = before.length === 0 || before[0]!.person_id !== after[0]!.person_id;
  if (firstChanged && (await observationTied(conn, sampleId, sample, after[0]!.person_id))) return { outcome: "observation_tied" };
  if (firstChanged && (await numberTaken(conn, sampleId, sample, after[0]!.person_id))) return { outcome: "number_taken" };
  if (await heldByUnprintedRun(conn, sampleId)) return { outcome: "in_print_run" };

  const recordedBy = after.map((c) => c.display_name).join(" | ");
  const reason = input.note.trim() !== "" ? input.note.trim() : "edited in Beeline";
  const events: CorrectionEvent[] = (await oldRecords(conn, sampleId)).map((r) => ({
    _id: r._id,
    field: "recordedBy",
    base_value: r.recordedBy ?? "",
    new_value: recordedBy,
    author: input.author,
    reason,
  }));
  const reprints = Number(
    (await rows<{ n: number }>(conn, `SELECT count(*)::INTEGER AS n FROM specimen_on_paper WHERE sample_id = $1`, [sampleId]))[0]?.n ?? 0,
  );
  const answer = {
    collectors: lines(after),
    first_changed: firstChanged,
    reprint_needed: reprints,
    warnings: before.length === 0 ? [] : warningsFor(before, after, sample, reprints),
  };
  if (input.dryRun) return { outcome: "planned", ...answer };

  return withPrintRunLock(async (): Promise<CollectorsResult> => {
    // Asked again under the lock: a run may have been prepared, or the trap
    // form may have saved, since the answer was worked out.
    if (await heldByUnprintedRun(writer, sampleId)) return { outcome: "in_print_run" };
    if (!sameIds(await currentList(writer, sampleId), before)) return { outcome: "changed" };
    // So were the number, the dates and the link the checks above read: the
    // trap form or the nightly's free link may have changed them (CodeRabbit).
    const now = await sampleRow(writer, sampleId);
    const same = (k: keyof SampleRow) => String(now?.[k] ?? "") === String(sample[k] ?? "");
    if (now === undefined || !(["sample_number", "date_start", "date_end", "inat_observation_id"] as const).every(same)) return { outcome: "changed" };
    if (firstChanged && (await numberTaken(writer, sampleId, sample, after[0]!.person_id))) return { outcome: "number_taken" };
    // Durability before immediacy: if the file write fails, nothing applied.
    if (events.length > 0) await upsertCorrections(deps.correctionsPath, events);
    await writer.run("BEGIN TRANSACTION");
    try {
      await writer.run(`DELETE FROM sample_collector WHERE sample_id = $1`, [sampleId] as never);
      for (const [i, c] of after.entries()) {
        await writer.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES ($1, $2, $3)`, [sampleId, c.person_id, i + 1] as never);
      }
      await mirrorCorrectionsOn(writer, events);
      // One head, exactly (schema/116); the engine cannot say so itself.
      if (await exists(writer, `SELECT 1 FROM sample_primary_collector_invalid WHERE sample_id = $1`, [sampleId])) {
        throw new Error(`sample ${sampleId} would not have exactly one first collector`);
      }
      await writer.run("COMMIT");
    } catch (err) {
      await writer.run("ROLLBACK").catch(() => undefined);
      // The old records' events are in the file by now; nothing else is recorded anywhere.
      if (isWriteConflict(err)) return { outcome: events.length > 0 ? "not_applied" : "write_conflict" };
      throw err;
    }
    return { outcome: "saved", ...answer };
  });
}
