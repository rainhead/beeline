import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import {
  applySampleOverlay,
  currentHostOf,
  resolveOldRecordSample,
  resolveObservationSample,
} from "../apply-sample-overlay.js";
import { readInatTaxon, type InatTaxonAnswer } from "../fetch-inat-taxa.js";
import {
  legacyRecordRef,
  NO_HOST,
  observationRef,
  parseSampleRef,
  readSampleOverlay,
  upsertSampleOverlay,
  type SampleOverlayRow,
} from "../sample-overlay.js";

/**
 * A staff member setting a sample's floral host from its page or the API
 * (beeline-hlay), on the locality's terms: kept in the sample overlay, applied
 * at once, replayed by every promotion, and standing over the observation
 * until staff choose to follow iNaturalist again. The reason is required, as a
 * hold's is.
 *
 * The plant is an iNaturalist taxon, given by its page address or its number
 * and read from iNaturalist as the form is submitted, so the page can show its
 * name and rank at once and Beeline can check it is a vascular plant. The read
 * is `readInatTaxon`: it touches no store, and is made before the sample's
 * turn, so a slow answer holds up nobody's correction of the sample. Nothing
 * is written to the taxon cache here; the nightly step reads the stored host
 * id from its worklist (inat_taxon_uncached), and until then the page shows
 * the name without a family or a common name, which sample_host already
 * allows.
 */

/** Vascular plants: the taxon every host must have in its lineage, as qc_rule_non_tracheophyte_host tests it. */
export const TRACHEOPHYTA = 211194;

/** Reads one taxon from iNaturalist. Injected, so a test never calls iNaturalist. */
export type HostTaxonReader = (id: number) => Promise<InatTaxonAnswer | null>;

/** iNaturalist's API, unauthenticated and with a short timeout, as the add-person lookup is. */
export const inatHostTaxonReader: HostTaxonReader = (id) => readInatTaxon(id, { timeoutMs: 10_000 });

/** A taxon staff may set as a host: what iNaturalist called it when they set it. */
export interface HostTaxon {
  id: number;
  name: string;
  rank: string;
}

/** Why a plant cannot be set as the host, or that iNaturalist could not be asked. */
export type HostProblem = "reason" | "taxon_needed" | "both" | "address" | "unknown" | "inactive" | "not_vascular" | "unchanged";

/**
 * The taxon an iNaturalist page address or a bare number names: the id in
 * `https://www.inaturalist.org/taxa/53439-Eriophyllum-lanatum`, `…/taxa/53439`
 * or `53439`. Null for anything else; a name is not accepted, since names are
 * ambiguous.
 */
export function parseTaxonRef(raw: string): number | null {
  const s = raw.trim();
  if (/^[1-9]\d{0,11}$/.test(s)) return Number(s);
  const link = /^(?:https?:\/\/)?(?:www\.)?inaturalist\.org\/taxa\/([1-9]\d{0,11})(?:-[^/?#\s]*)?\/?(?:[?#].*)?$/i.exec(s);
  return link === null ? null : Number(link[1]);
}

export type HostJudgement =
  | { ok: true; taxon: HostTaxon }
  | { ok: false; problem: "unknown" | "not_vascular" }
  | { ok: false; problem: "inactive"; replacedBy: string[] }
  /** iNaturalist could not be reached, or did not answer sensibly: nothing is written and the caller says to try again. */
  | { ok: false; problem: "unreachable" };

/**
 * Whether this taxon may be a floral host, and what it is called. A taxon the
 * cache already holds, active and with Tracheophyta in its lineage, is taken
 * as it is and iNaturalist is not asked. Otherwise iNaturalist is asked, and
 * the answer judged: it must exist, be active, and have Tracheophyta in its
 * lineage (or be Tracheophyta). An inactive taxon is refused with what
 * iNaturalist says replaced it, where it says, named from the cache where the
 * cache has the name.
 */
export async function judgeHostTaxon(db: Kysely<Database>, read: HostTaxonReader, id: number): Promise<HostJudgement> {
  const cached = await sql<{ name: string; rank: string; is_active: boolean; vascular: boolean }>`
    SELECT t.name, t.rank, t.is_active,
           EXISTS (SELECT 1 FROM inat_taxon_ancestor a
                   WHERE a.inat_taxon_id = t.inat_taxon_id AND a.ancestor_id = ${TRACHEOPHYTA}) AS vascular
    FROM inat_taxon t WHERE t.inat_taxon_id = ${id}`.execute(db);
  const c = cached.rows[0];
  if (c !== undefined && c.is_active && c.vascular) return { ok: true, taxon: { id, name: c.name, rank: c.rank } };
  let answer: InatTaxonAnswer | null;
  try {
    answer = await read(id);
  } catch {
    return { ok: false, problem: "unreachable" };
  }
  if (answer === null) return { ok: false, problem: "unknown" };
  if (!answer.isActive) {
    const named = await Promise.all(
      answer.replacedBy.map(async (r) => {
        const found = await sql<{ name: string }>`SELECT name FROM inat_taxon WHERE inat_taxon_id = ${r}`.execute(db);
        return found.rows[0]?.name ?? `taxon ${r}`;
      }),
    );
    return { ok: false, problem: "inactive", replacedBy: named };
  }
  if (answer.id !== TRACHEOPHYTA && !answer.ancestorIds.includes(TRACHEOPHYTA)) return { ok: false, problem: "not_vascular" };
  return { ok: true, taxon: { id, name: answer.name, rank: answer.rank } };
}

export interface StaffHostDeps {
  db: Kysely<Database>;
  /** For the overlay applier; absent in a test app that only writes the file. */
  conn?: DuckDBConnection;
  sampleOverlayPath: string;
}

export interface StaffHostTarget {
  entity_id: number;
  inat_observation_id: bigint | null;
}

/** What staff chose, the taxon already read and judged. */
export type HostChoice = { kind: "taxon"; taxon: HostTaxon } | { kind: "none" } | { kind: "remove" };

export type StaffHostResult =
  | { outcome: "saved"; host: HostTaxon | null }
  | { outcome: "removed" }
  | { outcome: "unchanged" }
  | { outcome: "invalid"; problem: HostProblem }
  /** The overlay row was written but named no sample, or two. */
  | { outcome: "unresolved"; reason: string };

/**
 * What a host on this sample is kept against, so that it survives a rebuild
 * and the nightly's replay of the overlay. The rule is pointAnchor's
 * (src/app/locality-override.ts): a row already standing in the file keeps the
 * key it was written with, whichever of the sample's two keys that is, so a
 * sample from old Beeline that later gains an observation through the free
 * link never has a `legacy:` row and an `inat:` row. Otherwise the observation
 * where there is one, else the first old record of the sample.
 *
 * Null for a sample with neither, which includes one entered in Beeline: those
 * are trap samples, the trap form writes no host, and a trap's plant is not a
 * host (CONTEXT.md, Floral host). Coordinates write the store directly for
 * such a sample; the host is refused.
 */
export async function hostAnchor(
  deps: Pick<StaffHostDeps, "db" | "sampleOverlayPath">,
  sample: StaffHostTarget,
): Promise<string | null> {
  const table = await sql<{ n: bigint }>`
    SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 'legacy_specimen_number' AND NOT temporary`.execute(deps.db);
  let ids: string[] = [];
  if (Number(table.rows[0]?.n ?? 0) > 0) {
    const records = await sql<{ id: string }>`
      SELECT _id AS id FROM legacy_specimen_number WHERE sample_id = ${sample.entity_id} ORDER BY _id`.execute(deps.db);
    ids = records.rows.map((r) => r.id);
  }
  const mine = new Set(ids);
  const standing = (await readSampleOverlay(deps.sampleOverlayPath)).find((r) => {
    if (r.field !== "host") return false;
    const ref = parseSampleRef(r.sample_ref);
    if (ref === null) return false;
    return "legacy_id" in ref
      ? mine.has(ref.legacy_id)
      : sample.inat_observation_id !== null && ref.inat_observation_id === String(sample.inat_observation_id);
  });
  if (standing !== undefined) return standing.sample_ref;
  if (sample.inat_observation_id !== null) return observationRef(sample.inat_observation_id);
  return ids[0] === undefined ? null : legacyRecordRef(ids[0]);
}

/**
 * Set the sample's floral host, say it has none, or take what staff set away.
 * The caller has judged the taxon and holds the sample's turn in its queue.
 * `dryRun` does everything but write.
 */
export async function setStaffHost(
  deps: StaffHostDeps & { conn: DuckDBConnection },
  sample: StaffHostTarget,
  anchor: string,
  input: { choice: HostChoice; note: string; author: string; dryRun?: boolean },
): Promise<StaffHostResult> {
  const reason = input.note.trim();
  const conn = deps.conn;
  // Before anything durable: the row names the sample by a key, and the key has
  // to name exactly this sample (the locality's reasoning, CodeRabbit on PR #94).
  const ref = parseSampleRef(anchor);
  if (ref === null) return { outcome: "unresolved", reason: `'${anchor}' is not a sample reference` };
  const found = "legacy_id" in ref ? await resolveOldRecordSample(conn, ref.legacy_id) : await resolveObservationSample(conn, ref.inat_observation_id);
  if ("problem" in found) return { outcome: "unresolved", reason: found.problem };
  if (found.sampleId !== sample.entity_id) return { outcome: "unresolved", reason: `${anchor} is on another sample` };

  const standing =
    ((await (await conn.run(`SELECT 1 FROM sample_host_override WHERE sample_id = $1`, [sample.entity_id] as never)).getRows()) as unknown[][])
      .length > 0;
  if (input.choice.kind === "remove") {
    if (!standing) return { outcome: "unchanged" };
    if (input.dryRun === true) return { outcome: "removed" };
    return write(deps, anchor, { base_value: "", value: "", author: input.author, reason: "" }, { outcome: "removed" });
  }
  if (reason === "") return { outcome: "invalid", problem: "reason" };
  const host = input.choice.kind === "taxon" ? input.choice.taxon : null;
  if (!standing) {
    // Refused as no change: the sample already has this host, or none.
    const held = (await (
      await conn.run(`SELECT host_inat_taxon_id, host_name_as_observed FROM sample WHERE entity_id = $1`, [sample.entity_id] as never)
    ).getRows()) as unknown[][];
    const id = held[0]?.[0] === null || held[0]?.[0] === undefined ? null : Number(held[0]![0]);
    const hasName = held[0]?.[1] !== null && held[0]?.[1] !== undefined;
    if (host === null ? id === null && !hasName : id === host.id) return { outcome: "invalid", problem: "unchanged" };
  }
  const value = host === null ? NO_HOST : `${host.id} ${host.rank} ${host.name.trim()}`;
  if (input.dryRun === true) return { outcome: "saved", host };
  // Read in this turn, so a second save keeps the first base.
  const base_value = await currentHostOf(conn, sample.entity_id);
  return write(deps, anchor, { base_value, value, author: input.author, reason }, { outcome: "saved", host });
}

async function write(
  deps: StaffHostDeps & { conn: DuckDBConnection },
  anchor: string,
  row: Omit<SampleOverlayRow, "sample_ref" | "field">,
  done: StaffHostResult,
): Promise<StaffHostResult> {
  const full: SampleOverlayRow = { sample_ref: anchor, field: "host", ...row };
  // Durability before immediacy: if the file write fails, nothing applied.
  await upsertSampleOverlay(deps.sampleOverlayPath, [full]);
  const applied = await applySampleOverlay(deps.conn, [full]);
  const first = applied.unresolved[0];
  if (first !== undefined) return { outcome: "unresolved", reason: first.reason };
  return done;
}
