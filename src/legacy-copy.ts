import type { DuckDBConnection } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { LEGACY_EXPORT_COLUMNS, legacyExportSources, legacyExportSql } from "./legacy-export.js";

/**
 * Every specimen Beeline prints, copied nightly into the old Beeline's master
 * list (beeline-83b8.18), so volunteers holding a label printed here can
 * enter their determination at old.melittologist.org, which stays open for
 * that through December 2026. Those determinations come back by
 * beeline-c43w (src/legacy-volunteer-import.ts).
 *
 * THROUGH THE OLD SYSTEM'S OWN API, NOT ITS DATABASE. The old server takes a
 * list of occurrences from a signed-in admin (`POST /api/occurrences`) and
 * upserts each by its `_id`, setting only the fields it is given. Its
 * repository computes, on every write, the two fields its screens sort and
 * filter by, `composite_sort` and `date`, so a record written straight into
 * Mongo would have to reproduce them exactly or sit out of order or out of
 * reach. The API is also reached over HTTPS with an admin login, where Mongo
 * is reached only over SSH with a root key to the old host, which production
 * has no business holding. The old system's working-file upload was the other
 * route, and is no route: reading that file in deletes every occurrence first
 * and replaces the master list with the file (SyncOccurrencesSubtaskHandler),
 * losing whatever volunteers entered since it was written.
 *
 * WHAT IS COPIED. A specimen printed by a print run that printed and was not
 * canceled, which has a field number and did not come from the old system.
 * An imported specimen is already there under its own record, even when
 * Beeline reprinted its label (one has been, under its old number), so
 * copying it would make a second. On the first print run (4 November 2026)
 * that was 954 specimens from 220 samples, all minted here from iNaturalist;
 * the old system holds no unnumbered 2025 or 2026 record for any of them to
 * duplicate. Each row is the legacy-format export's row for the specimen
 * (src/legacy-export.ts), its 63 template columns and not Beeline's
 * occurrenceRemarks, since the old system's template has no such field. On
 * the store of 7 November 2026 those rows filled every column an old-system
 * printed 2026 record fills except the ones Beeline does not hold: the OSAC
 * occurrenceID and resourceID (ADR 0008: Beeline mints none), the
 * observation's UUID in relatedResourceID, and the plant's phylum, order and
 * family. None of them is read by the old system's determination screens,
 * which find a volunteer's records by userLogin and field number.
 *
 * THE KEY. The old system keys a record by a hash of its sample, specimen,
 * date and link, so a corrected date would make it a different record.
 * Beeline's copy is keyed `beeline-specimen-<entity_id>` instead: the
 * specimen's own identity, which production never redraws (ADR 0006),
 * survives a corrected date and a duplicate repair's second field number,
 * and says on its face that the record started here, which is how
 * beeline-c43w tells the two apart. It is never 12 or 24 characters of hex,
 * the lengths the old server would read as a Mongo ObjectId.
 *
 * VOLUNTEERS' ENTRIES ARE NEVER OVERWRITTEN. The five volunteer columns are
 * the only ones a volunteer can write in the old system, so a copy writes
 * them only where the old record has none of them: on a new record, or on
 * one nobody has identified there. Beeline's own volunteer determination,
 * made in new Beeline, then shows there too; once a volunteer has entered
 * one in the old Beeline, theirs stands until beeline-c43w brings it home.
 * Even on a record nobody has identified, an update sends only volunteer
 * values that say something, never a blank: a volunteer can save between
 * the read before a batch and its write, and a blank sent then would erase
 * their entry and be read back as a faithful copy (found by an adversarial
 * review of this module, 2026-11-07).
 *
 * WHAT THE COPY DOES NOT REPAIR. The hash compares Beeline's row with what
 * Beeline last sent, not with what the old system holds now. Should the old
 * system rewrite a copied record itself — its "pull observations" task over
 * 2026 would rewrite place and coordinates from iNaturalist — the copy does
 * not notice; `pnpm legacy:copy --all` sends every record again and is the
 * repair. Nor should the legacy-format export, or any file of Beeline's
 * rows, ever be uploaded into the old Beeline: its upload keys each row by
 * its own hash and would make a second record beside the copy, under the
 * same field number.
 *
 * NOTHING IS TRUSTED UNREAD. Whether a record is new is read from the old
 * system before each batch rather than remembered, so a copy the old system
 * lost is made again and one this side forgot is not taken for new. Every
 * batch is read back afterwards, and a specimen is recorded in legacy_copy
 * only when the old system holds exactly what was sent; a night whose row is
 * unchanged sends nothing. The old server's own reply cannot be checked: its
 * counts turn to null as soon as one record in the batch is new, because its
 * insert path returns an id where the counts expect an object. A field
 * number the old system holds under any other record is not sent at all and
 * fails the night, since the old system must never hold two records with one
 * number (ADR 0008).
 */

/** The old system's admin login, and where its API is. */
export interface OldBeelineCredentials {
  /** e.g. https://old.melittologist.org, with no trailing slash. */
  origin: string;
  username: string;
  password: string;
}

export const LEGACY_COPY_ID_PREFIX = "beeline-specimen-";

/** The old system's `_id` for Beeline's copy of a specimen. */
export const legacyCopyId = (specimenId: number): string => `${LEGACY_COPY_ID_PREFIX}${specimenId}`;

/** The specimen an old-system `_id` is Beeline's copy of, or null for a record the old system made (beeline-c43w). */
export function specimenOfLegacyCopyId(id: string): number | null {
  if (!id.startsWith(LEGACY_COPY_ID_PREFIX)) return null;
  const rest = id.slice(LEGACY_COPY_ID_PREFIX.length);
  return /^[1-9][0-9]*$/.test(rest) ? Number(rest) : null;
}

/** The old system's template columns, the export's minus Beeline's own occurrenceRemarks. */
export const COPIED_COLUMNS = LEGACY_EXPORT_COLUMNS.filter((c) => c !== "occurrenceRemarks");

/** The only columns a volunteer can write in the old system (OccurrencesController's noAuthFields). */
export const VOLUNTEER_COLUMNS = ["familyVolDet", "genusVolDet", "speciesVolDet", "sexVolDet", "casteVolDet"] as const;

type CopiedColumn = (typeof COPIED_COLUMNS)[number];
type Row = Record<CopiedColumn, string>;

interface Candidate {
  specimenId: number;
  id: string;
  row: Row;
  sha256: string;
  /** The field number last copied, which a duplicate repair may since have replaced. */
  lastFieldNumber: string | null;
  lastSha256: string | null;
}

/** An old-system occurrence as its API returns it. */
export type OldRecord = Record<string, unknown> & { _id: string };

export interface LegacyCopyResult {
  /** Specimens that qualify for a copy. */
  printed: number;
  /** Of those, the ones whose row had not changed since it was last copied. */
  unchanged: number;
  /** Records the old system did not hold, made. */
  inserted: number;
  /** Records the old system held, brought up to date. */
  updated: number;
  /** Field numbers the old system holds under another record, not sent. */
  collisions: string[];
  /** Field numbers sent but not read back as sent. */
  unverified: string[];
  dryRun: boolean;
}

const sha256 = (row: Row) => createHash("sha256").update(JSON.stringify(COPIED_COLUMNS.map((c) => row[c]))).digest("hex");

/** The specimens printed here and not imported: the ones the old system cannot know. */
function printedHere(staged: boolean): string {
  const notImported = staged
    ? `AND NOT EXISTS (
         SELECT 1 FROM specimen sp2
         JOIN legacy_specimen_number lsn ON lsn.sample_id = sp2.sample_id AND lsn.specimen_number = sp2.specimen_number
         WHERE sp2.entity_id = pl.specimen_id)`
    : "";
  return `SELECT pl.specimen_id FROM printed_label pl JOIN print_run r ON r.entity_id = pl.print_run_id
          WHERE r.printed_at IS NOT NULL AND r.canceled_at IS NULL ${notImported}`;
}

/**
 * Every specimen that qualifies, as its export row beside what was last
 * copied. The rows go through a temporary table, as the export's do, so the
 * joins are done and released before anything else reads them.
 */
async function candidates(conn: DuckDBConnection): Promise<Candidate[]> {
  // The export's query, without its join to the staged legacy records: a
  // specimen with a staged record is never copied, so for every specimen that
  // is, that join finds nothing and the export writes the model's values
  // anyway. Left in, it held all 397,000 staged records in memory to match
  // none of them, and the copy took 1.6 GB on the store of 7 November 2026.
  const { staging } = await legacyExportSources(conn);
  const sql = legacyExportSql(null, null, printedHere(staging !== null));
  try {
    await conn.run(`CREATE OR REPLACE TEMP TABLE legacy_copy_rows AS ${sql.rows}`);
    const reader = await conn.runAndReadAll(`
      SELECT r.sort_tiebreak AS specimen_id, lc.field_number AS last_field_number, lc.content_sha256 AS last_sha256,
             ${COPIED_COLUMNS.map((c) => `r."${c}"`).join(", ")}
      FROM temp.legacy_copy_rows r
      LEFT JOIN legacy_copy lc ON lc.specimen_id = r.sort_tiebreak
      WHERE r."fieldNumber" IS NOT NULL
      ORDER BY r.sort_tiebreak`);
    return (reader.getRowObjectsJS() as Record<string, unknown>[]).map((o) => {
      const row = Object.fromEntries(COPIED_COLUMNS.map((c) => [c, o[c] == null ? "" : String(o[c])])) as Row;
      const specimenId = Number(o.specimen_id);
      return {
        specimenId,
        id: legacyCopyId(specimenId),
        row,
        sha256: sha256(row),
        lastFieldNumber: (o.last_field_number as string | null) ?? null,
        lastSha256: (o.last_sha256 as string | null) ?? null,
      };
    });
  } finally {
    await conn.run("DROP TABLE IF EXISTS temp.legacy_copy_rows");
  }
}

/** The old system's API, as far as the copy uses it. */
export class OldBeelineApi {
  private cookie: string | null = null;

  constructor(
    private readonly credentials: OldBeelineCredentials,
    private readonly signal?: AbortSignal,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    // A minute per request: a batch is at most fifty records, which the old
    // server writes one at a time, a findOne and an update each.
    const signal = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    const res = await fetch(`${this.credentials.origin}${path}`, { ...init, headers, signal, redirect: "error" });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`old Beeline answered ${init.method ?? "GET"} ${path.split("?")[0]} with ${res.status}${body ? `: ${body}` : ""}`);
    }
    return res;
  }

  /** Sign in as the admin; the old server answers with its token in a cookie, good for 24 hours. */
  async login(): Promise<void> {
    const res = await this.request("/api/admins/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: this.credentials.username, password: this.credentials.password }),
    });
    const token = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith("token="));
    if (!token) throw new Error("old Beeline accepted the login but set no token");
    this.cookie = token;
  }

  /**
   * Every record holding one of these field numbers. The old server reads a
   * comma-separated value as a list of whole, case-insensitive matches
   * (parseQueryParameters), and field numbers are digits, so nothing in them
   * is read as a pattern.
   */
  async find(fieldNumbers: string[]): Promise<OldRecord[]> {
    if (fieldNumbers.length === 0) return [];
    for (const n of fieldNumbers) if (!/^[0-9]+$/.test(n)) throw new Error(`not a field number: '${n}'`);
    const out: OldRecord[] = [];
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({ fieldNumber: fieldNumbers.join(","), per_page: "500", page: String(page) });
      const body = (await (await this.request(`/api/occurrences?${q}`)).json()) as {
        data: OldRecord[];
        pagination?: { hasNextPage?: boolean };
      };
      out.push(...body.data);
      if (!body.pagination?.hasNextPage) return out;
    }
  }

  /**
   * Every record these column tests select, a page at a time. The old server
   * reads `(non-empty)` and `(empty)` as those tests on a column, and ANDs the
   * columns together (parseQueryParameters); it sorts each page by its
   * composite sort and then `_id`, so pages do not overlap while nothing
   * changes. It caps a page at 5,000 records.
   */
  async *pages(filter: Record<string, string>, perPage = 2000): AsyncGenerator<OldRecord[]> {
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({ ...filter, per_page: String(perPage), page: String(page) });
      const body = (await (await this.request(`/api/occurrences?${q}`)).json()) as {
        data: OldRecord[];
        pagination?: { hasNextPage?: boolean };
      };
      yield body.data;
      if (!body.pagination?.hasNextPage) return;
    }
  }

  /** Insert or update each record by its `_id`, setting only the fields given. */
  async upsert(records: Record<string, string>[]): Promise<void> {
    await this.request("/api/occurrences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ occurrences: records }),
    });
  }
}

/**
 * The old server parses JSON bodies with Express's default limit of 100 kB,
 * so a batch stops at fifty records or 80 kB, whichever comes first. A
 * printed specimen's record is about a kilobyte.
 */
const BATCH_RECORDS = 50;
const BATCH_BYTES = 80_000;

function batches(cs: Candidate[]): Candidate[][] {
  const out: Candidate[][] = [];
  let current: Candidate[] = [];
  let bytes = 0;
  for (const c of cs) {
    // In bytes, as the old server counts its limit: a degree sign or an
    // accented locality is two or three bytes and one character.
    const size = Buffer.byteLength(JSON.stringify(c.row)) + c.id.length + 16;
    if (current.length > 0 && (current.length >= BATCH_RECORDS || bytes + size > BATCH_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(c);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

const blank = (v: unknown) => v === undefined || v === null || v === "";

/**
 * Copy every printed specimen whose row changed since it was last copied
 * (every one, with `all`). A dry run reads the old system and says what it
 * would send, and sends and records nothing.
 */
export async function copyToOldBeeline(
  conn: DuckDBConnection,
  credentials: OldBeelineCredentials,
  opts: { all?: boolean; dryRun?: boolean; signal?: AbortSignal; log?: (m: string) => void } = {},
): Promise<LegacyCopyResult> {
  const all = await candidates(conn);
  const due = opts.all ? all : all.filter((c) => c.sha256 !== c.lastSha256);
  const result: LegacyCopyResult = {
    printed: all.length,
    unchanged: all.length - due.length,
    inserted: 0,
    updated: 0,
    collisions: [],
    unverified: [],
    dryRun: opts.dryRun ?? false,
  };
  if (due.length === 0) return result;
  const count = (insert: boolean) => {
    if (insert) result.inserted++;
    else result.updated++;
  };
  // Where each copy due tonight is going. A duplicate repair moves one
  // specimen to a second number and leaves the first with the other, so
  // until tonight's copy moves it, the old record of the one that moved
  // still holds the number that is now the other's; that is not a collision.
  const moving = new Map(due.map((c) => [c.id, c.row.fieldNumber]));

  const api = new OldBeelineApi(credentials, opts.signal);
  await api.login();
  for (const batch of batches(due)) {
    const numbers = [...new Set(batch.flatMap((c) => [c.row.fieldNumber, ...(c.lastFieldNumber ? [c.lastFieldNumber] : [])]))];
    const before = await api.find(numbers);
    const byId = new Map(before.map((r) => [r._id, r]));
    const send: { c: Candidate; record: Record<string, string>; insert: boolean }[] = [];
    for (const c of batch) {
      const held = byId.get(c.id);
      const other = before.find(
        (r) => r._id !== c.id && r.fieldNumber === c.row.fieldNumber && (moving.get(r._id) ?? r.fieldNumber) === r.fieldNumber,
      );
      if (other) {
        result.collisions.push(`${c.row.fieldNumber} (held by old record ${other._id})`);
        continue;
      }
      const record: Record<string, string> = { _id: c.id };
      // A volunteer column is written only where the old record has none of
      // the five, and then only with a value: a blank can only erase, and a
      // volunteer may save between this read and the write below. Blanks go
      // only on a record that is new and was never copied, which no
      // volunteer can have reached; a record copied before but not found by
      // either number may still exist under a third, and is treated as held.
      const canFill = !held || VOLUNTEER_COLUMNS.every((v) => blank(held[v]));
      const fresh = !held && c.lastSha256 === null;
      for (const col of COPIED_COLUMNS) {
        if ((VOLUNTEER_COLUMNS as readonly string[]).includes(col) && !(canFill && (fresh || c.row[col] !== ""))) continue;
        record[col] = c.row[col];
      }
      send.push({ c, record, insert: !held });
    }
    if (send.length === 0) continue;
    if (opts.dryRun) {
      for (const s of send) count(s.insert);
      continue;
    }
    await api.upsert(send.map((s) => s.record));
    const after = new Map((await api.find(numbers)).map((r) => [r._id, r]));
    for (const s of send) {
      const got = after.get(s.c.id);
      const same = got && Object.entries(s.record).every(([k, v]) => (blank(got[k]) ? "" : String(got[k])) === v);
      if (!same) {
        result.unverified.push(s.c.row.fieldNumber);
        continue;
      }
      await conn.run(
        `INSERT INTO legacy_copy (specimen_id, field_number, content_sha256) VALUES ($1, $2, $3)
         ON CONFLICT (specimen_id) DO UPDATE SET
           field_number = excluded.field_number, content_sha256 = excluded.content_sha256, last_copied_at = now()`,
        [s.c.specimenId, s.c.row.fieldNumber, s.c.sha256],
      );
      count(s.insert);
    }
    opts.log?.(`batch of ${batch.length}: ${result.inserted} inserted and ${result.updated} updated so far`);
  }
  return result;
}

/** One line for job_run.detail and the CLI. */
export function describeCopy(r: LegacyCopyResult): string {
  const verb = r.dryRun ? "would be" : "were";
  const parts = [
    `${r.printed} printed specimen(s) belong in the old Beeline: ${r.unchanged} unchanged since the last copy`,
    `${r.inserted} ${verb} copied anew`,
    `${r.updated} ${verb} brought up to date`,
  ];
  if (r.collisions.length > 0) parts.push(`${r.collisions.length} not sent, their field number held by another old record: ${r.collisions.slice(0, 5).join(", ")}`);
  if (r.unverified.length > 0) parts.push(`${r.unverified.length} not read back as sent: ${r.unverified.slice(0, 10).join(", ")}`);
  return parts.join("; ");
}

/** Throw, after the work is recorded, when the night left something the old system does not hold correctly. */
export function assertCopied(r: LegacyCopyResult): void {
  if (r.collisions.length > 0 || r.unverified.length > 0) throw new Error(describeCopy(r));
}
