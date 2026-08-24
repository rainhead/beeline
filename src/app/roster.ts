import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";

/**
 * The people roster: who is in the store, which iNaturalist account each is
 * bound to, and — the part that earns the screen — the evidence for that
 * binding.
 *
 * Binding evidence exists because a wrong binding is invisible in a list. The
 * account a person files under is a conclusion promotion drew from the legacy
 * records, and when it drew a wrong one (beeline-eft) nothing on any screen
 * said so: 'andonymelathopoulos' looked exactly as settled as 'amelathopoulos'
 * until someone counted the records behind each. So the roster shows the count
 * beside the binding, and shows the runners-up, and says plainly when the
 * bound login is not the one most of that person's records carry.
 */

export const PAGE_SIZE = 50;

export type BindingVerdict =
  /** The bound login is the one most of their records carry. */
  | "supported"
  /** Bound, but another login on their records is better attested. */
  | "outweighed"
  /** Bound to an account no legacy record of theirs mentions. */
  | "unattested"
  /** No account: they cannot sign in. */
  | "unbound"
  /** No legacy records to weigh — an iNat-native person, or a fresh store. */
  | "no-evidence";

export interface RosterRow {
  person_id: number;
  display_name: string;
  login: string | null;
  inat_user_id: number | null;
  samples: number;
  atlas_code: string | null;
  is_admin: boolean;
  /** Records backing the bound login, null when there is nothing to weigh. */
  bound_records: number | null;
  /** The best-attested account on their records, and its count. */
  top_login: string | null;
  top_uid: number | null;
  top_records: number | null;
  verdict: BindingVerdict;
}

export interface RosterQuery {
  search: string;
  /** Only rows whose binding wants a human look. */
  suspect: boolean;
  page: number;
}

export const EMPTY_ROSTER_QUERY: RosterQuery = { search: "", suspect: false, page: 1 };

export function parseRosterQuery(params: URLSearchParams): RosterQuery {
  const page = Number(params.get("page") ?? "1");
  return {
    search: (params.get("q") ?? "").trim(),
    suspect: params.get("suspect") === "1",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

export function rosterHref(query: RosterQuery, overrides: Partial<RosterQuery> = {}): string {
  const q = { ...query, ...overrides };
  const params = new URLSearchParams();
  if (q.search !== "") params.set("q", q.search);
  if (q.suspect) params.set("suspect", "1");
  if (q.page > 1) params.set("page", String(q.page));
  const s = params.toString();
  return s === "" ? "/people" : `/people?${s}`;
}

/** Whether legacy staging is still attached — a rebuilt store has it, a
 * store restored without it does not, and the evidence columns go quiet. */
export async function hasLegacyEvidence(db: Kysely<Database>): Promise<boolean> {
  const found = await sql<{ n: number | bigint }>`
    SELECT count(*) AS n FROM information_schema.tables
    WHERE table_name IN ('legacy_occurrence', 'legacy_person_map')`.execute(db);
  return Number(found.rows[0]?.n ?? 0) === 2;
}

/**
 * Per-person login counts from the legacy records, as a SQL fragment usable
 * as a CTE. Only referenced when hasLegacyEvidence() is true.
 */
const loginWeights = sql`
  SELECT m.person_id, r.userLogin AS login,
         try_cast(r.userId AS BIGINT) AS uid, count(*) AS records
  FROM legacy_occurrence r
  JOIN legacy_person_map m
    ON m.fn IS NOT DISTINCT FROM r.firstName AND m.ln IS NOT DISTINCT FROM r.lastName
  WHERE nullif(r.userLogin, '') IS NOT NULL
  GROUP BY 1, 2, 3`;

export interface RosterPage {
  rows: RosterRow[];
  total: number;
  page: number;
  pages: number;
  /** False when the store carries no legacy staging to weigh bindings against. */
  evidence: boolean;
}

export async function listRoster(db: Kysely<Database>, query: RosterQuery): Promise<RosterPage> {
  const evidence = await hasLegacyEvidence(db);
  const offset = (query.page - 1) * PAGE_SIZE;
  const term = `%${query.search.toLowerCase()}%`;

  // Without legacy staging every evidence column is null and the verdict
  // collapses to bound/unbound; the screen says so rather than implying the
  // bindings were checked.
  const weights = evidence
    ? sql`weights AS (${loginWeights}),
          best AS (
            SELECT person_id, arg_max(login, records) AS top_login,
                   arg_max(uid, records) AS top_uid, max(records) AS top_records
            FROM weights GROUP BY 1
          ),`
    : sql`best AS (SELECT NULL::INTEGER AS person_id, NULL::TEXT AS top_login,
                          NULL::BIGINT AS top_uid, NULL::BIGINT AS top_records),`;
  const boundRecords = evidence
    ? // Weighed on the iNat user id, never the login string. An account that
      // was renamed upstream keeps its id and loses its old name, so matching
      // by name would flag four correct bindings as unattested — which is
      // exactly the false alarm that buries the one real one.
      // Falling back to the login where legacy recorded no id at all: those
      // bindings came from resolving the login through the iNat API
      // (src/backfill-inat-accounts.ts), and calling them unattested would
      // report work that succeeded as work to check.
      sql`(SELECT sum(w.records) FROM weights w
           WHERE w.person_id = p.entity_id
             AND (w.uid = a.inat_user_id
                  OR (w.uid IS NULL AND lower(w.login) = lower(a.login))))`
    : sql`NULL::BIGINT`;

  const base = sql`
    WITH ${weights}
    roster AS (
      SELECT p.entity_id AS person_id,
             p.display_name,
             a.login,
             a.inat_user_id,
             (SELECT count(*) FROM sample_collector sc WHERE sc.person_id = p.entity_id) AS samples,
             atl.code AS atlas_code,
             (adm.person_id IS NOT NULL) AS is_admin,
             ${boundRecords} AS bound_records,
             best.top_login,
             best.top_uid,
             best.top_records
      FROM person p
      LEFT JOIN inat_account a ON a.person_id = p.entity_id
      LEFT JOIN person_home_atlas ha ON ha.person_id = p.entity_id
      LEFT JOIN atlas atl ON atl.entity_id = ha.atlas_id
      LEFT JOIN person_admin adm ON adm.person_id = p.entity_id
      LEFT JOIN best ON best.person_id = p.entity_id
    ),
    judged AS (
      SELECT *,
             CASE
               WHEN login IS NULL THEN 'unbound'
               WHEN top_login IS NULL THEN 'no-evidence'
               WHEN bound_records IS NULL THEN 'unattested'
               WHEN top_uid IS DISTINCT FROM inat_user_id AND top_records > bound_records THEN 'outweighed'
               ELSE 'supported'
             END AS verdict
      FROM roster
    )
    SELECT * FROM judged
    WHERE (${query.search === ""} OR lower(display_name) LIKE ${term} OR lower(coalesce(login, '')) LIKE ${term})
      AND (${!query.suspect} OR verdict IN ('outweighed', 'unattested'))`;

  const counted = await sql<{ n: number | bigint }>`SELECT count(*) AS n FROM (${base})`.execute(db);
  const total = Number(counted.rows[0]?.n ?? 0);
  const listed = await sql<RosterRow>`
    ${base}
    ORDER BY CASE verdict WHEN 'outweighed' THEN 0 WHEN 'unattested' THEN 1 ELSE 2 END,
             samples DESC, display_name
    LIMIT ${PAGE_SIZE} OFFSET ${offset}`.execute(db);

  return {
    rows: listed.rows.map((r) => ({
      ...r,
      person_id: Number(r.person_id),
      samples: Number(r.samples),
      inat_user_id: r.inat_user_id === null ? null : Number(r.inat_user_id),
      bound_records: r.bound_records === null ? null : Number(r.bound_records),
      top_records: r.top_records === null ? null : Number(r.top_records),
      top_uid: r.top_uid === null ? null : Number(r.top_uid),
      is_admin: Boolean(r.is_admin),
    })),
    total,
    page: query.page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    evidence,
  };
}

export interface LoginWeight {
  login: string;
  uid: number | null;
  records: number;
  /** True for the account this person is currently bound to (by id). */
  bound: boolean;
}

export interface PersonDetail extends RosterRow {
  given_name: string | null;
  family_name: string | null;
  label_name: string | null;
  /** Every login on their legacy records, best-attested first. */
  logins: LoginWeight[];
  /** Samples where they are the primary collector. */
  primary_samples: number;
}

export async function personDetail(db: Kysely<Database>, personId: number): Promise<PersonDetail | null> {
  const found = await sql<PersonDetail>`
    SELECT p.entity_id AS person_id, p.display_name, p.given_name, p.family_name, p.label_name,
           a.login, a.inat_user_id,
           (SELECT count(*) FROM sample_collector sc WHERE sc.person_id = p.entity_id) AS samples,
           (SELECT count(*) FROM sample s WHERE s.collector_id = p.entity_id) AS primary_samples,
           atl.code AS atlas_code,
           (adm.person_id IS NOT NULL) AS is_admin
    FROM person p
    LEFT JOIN inat_account a ON a.person_id = p.entity_id
    LEFT JOIN person_home_atlas ha ON ha.person_id = p.entity_id
    LEFT JOIN atlas atl ON atl.entity_id = ha.atlas_id
    LEFT JOIN person_admin adm ON adm.person_id = p.entity_id
    WHERE p.entity_id = ${personId}`.execute(db);
  const row = found.rows[0];
  if (row === undefined) return null;

  const evidence = await hasLegacyEvidence(db);
  const logins: LoginWeight[] = [];
  if (evidence) {
    const weighed = await sql<{ login: string; uid: number | bigint | null; records: number | bigint }>`
      SELECT login, uid, records FROM (${loginWeights}) WHERE person_id = ${personId}
      ORDER BY records DESC, login`.execute(db);
    for (const w of weighed.rows) {
      logins.push({
        login: w.login,
        uid: w.uid === null ? null : Number(w.uid),
        records: Number(w.records),
        bound:
          row.inat_user_id !== null &&
          (Number(w.uid) === Number(row.inat_user_id) ||
            (w.uid === null && row.login !== null && w.login.toLowerCase() === row.login.toLowerCase())),
      });
    }
  }
  const top = logins[0];
  const bound = logins.find((l) => l.bound);
  const verdict: BindingVerdict =
    row.login === null
      ? "unbound"
      : top === undefined
        ? "no-evidence"
        : bound === undefined
          ? "unattested"
          : top.uid !== bound.uid && top.records > bound.records
            ? "outweighed"
            : "supported";

  return {
    ...row,
    person_id: Number(row.person_id),
    samples: Number(row.samples),
    primary_samples: Number(row.primary_samples),
    inat_user_id: row.inat_user_id === null ? null : Number(row.inat_user_id),
    is_admin: Boolean(row.is_admin),
    bound_records: bound?.records ?? null,
    top_login: top?.login ?? null,
    top_uid: top?.uid ?? null,
    top_records: top?.records ?? null,
    logins,
    verdict,
  };
}

/**
 * How a person is named in the overlay — the key a rebuild reproduces.
 *
 * The display name is preferred even for people who have an account, because
 * `inat:` refs are self-defeating for the commonest edit this screen makes:
 * a row that rebinds inat:1542612 to 429964 names a person that the next
 * rebuild, applying the corrected promotion rule, no longer binds to 1542612
 * at all — so the row would resolve to nobody exactly when it mattered. The
 * name survives a rebinding; it is only unusable when two people share one.
 */
export function personRef(row: {
  display_name: string;
  inat_user_id: number | null;
  nameIsUnique: boolean;
}): string {
  if (row.nameIsUnique) return `name:${row.display_name}`;
  if (row.inat_user_id !== null) return `inat:${row.inat_user_id}`;
  throw new Error(`cannot reference '${row.display_name}': the name is shared and there is no account to name them by`);
}

/** Whether exactly one person carries this display name. */
export async function nameIsUnique(db: Kysely<Database>, displayName: string): Promise<boolean> {
  const found = await sql<{ n: number | bigint }>`
    SELECT count(*) AS n FROM person WHERE display_name = ${displayName}`.execute(db);
  return Number(found.rows[0]?.n ?? 0) === 1;
}
