import { sql, type Kysely } from "kysely";
import type { Database, MembershipKind } from "../model.js";

/**
 * The people roster: who is in the store, and which iNaturalist account each
 * one signs in with. A listing of people, first and — after cutover — only.
 *
 * The account a person files under is a conclusion promotion drew from their
 * older records, and when it drew a wrong one (beeline-eft) nothing on any
 * screen said so: 'andonymelathopoulos' looked exactly as settled as
 * 'amelathopoulos' until someone counted the records behind each. So a wrong
 * one still has to be visible here. But checking them is a job that ends when
 * the legacy records stop being the source, so it does not get a column, a
 * sort order, or a vocabulary of its own: a row says something only when
 * something is wrong with it, in the words anyone would use.
 */

export const PAGE_SIZE = 50;

export type BindingVerdict =
  /** The account is the one most of their records use. */
  | "supported"
  /** Another account on their records is used far more — probably wrong. */
  | "outweighed"
  /** An account no older record of theirs mentions. */
  | "unattested"
  /** No account: they cannot sign in. */
  | "unbound"
  /** Nothing to weigh — an iNat-native person, or a store without staging. */
  | "no-evidence";

/** The two that mean something is wrong, and the only two a row reports. */
export const LOOKS_WRONG: readonly BindingVerdict[] = ["outweighed", "unattested"];

export interface RosterRow {
  person_id: number;
  display_name: string;
  login: string | null;
  inat_user_id: number | null;
  samples: number;
  /**
   * Where they belong (schema/010). Null kind = nobody has said; 'program' =
   * somebody said, and the answer is Master Melittology itself with no member
   * atlas — a real state, not a gap to chase (beeline-lcl).
   */
  membership: MembershipKind | null;
  atlas_code: string | null;
  is_admin: boolean;
  /** Records backing the bound login, null when there is nothing to weigh. */
  bound_records: number | null;
  /** The best-attested account on their records, and its count. */
  top_login: string | null;
  top_uid: number | null;
  top_records: number | null;
  /**
   * Who holds that account, when it is somebody else. A household shares one
   * iNaturalist login and only one of them can hold it (inat_user_id is
   * unique), so the partner's row would otherwise read as a blank where the
   * truth is "signs in as Gretchen" — beeline-eyk, Robert Pederson and his
   * 1,087 samples.
   */
  top_holder: string | null;
  verdict: BindingVerdict;
  /** When they last collected, and when they were last here. Both say the
   * same thing in different registers: is this person still active. */
  last_sample: Date | string | null;
  last_seen: Date | string | null;
}

export interface RosterQuery {
  search: string;
  /** Only rows whose account does not match the records behind it. */
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

/**
 * Whether legacy staging is still attached. Without it there is nothing to
 * weigh an account against, so the screen drops the checking apparatus
 * entirely rather than reporting a verdict it did not reach — which is also
 * the shape this page takes after cutover.
 */
export async function hasLegacyEvidence(db: Kysely<Database>): Promise<boolean> {
  const found = await sql<{ n: number | bigint }>`
    SELECT count(*) AS n FROM information_schema.tables
    WHERE table_name IN ('legacy_occurrence', 'legacy_person_map')`.execute(db);
  return Number(found.rows[0]?.n ?? 0) === 2;
}

/**
 * Whether the private store is attached (ADR 0003). It holds when somebody
 * was last here; a store opened without it — tests, a CLI run — simply has no
 * answer, rather than failing to have one.
 */
export async function hasSessions(db: Kysely<Database>): Promise<boolean> {
  const found = await sql<{ n: number | bigint }>`
    SELECT count(*) AS n FROM information_schema.tables
    WHERE table_catalog = 'private' AND table_name IN ('session', 'inat_oauth_token')`.execute(db);
  return Number(found.rows[0]?.n ?? 0) === 2;
}

/**
 * When somebody was last here. The session row is the truer answer — it slides
 * with every request — but sessions expire and are purged, so the sign-in
 * behind them is the fallback that survives longer. Neither is a credential;
 * both live in the private store because they sit beside ones that are.
 */
const lastSeenSql = sql`greatest(
  (SELECT max(sn.last_seen_at) FROM private.session sn WHERE sn.person_id = p.entity_id),
  (SELECT t.last_login_at FROM private.inat_oauth_token t WHERE t.inat_user_id = a.inat_user_id))`;

/**
 * When they last collected. Read from sample_collector, never from
 * sample.collector_id: two thirds of trap samples were collected by a pair,
 * and the second collector's last season is as real as the first's
 * (beeline-77j).
 */
const lastSampleSql = sql`(
  SELECT max(s.date_start) FROM sample s
  JOIN sample_collector sc ON sc.sample_id = s.entity_id
  WHERE sc.person_id = p.entity_id)`;

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
  /** False when the store carries no staging to weigh an account against. */
  evidence: boolean;
  /**
   * People anywhere in the store whose account does not match their records —
   * not just on this page. The listing no longer sorts them to the front, so
   * this is how someone learns there is anything to look at.
   */
  lookWrong: number;
}

export async function listRoster(db: Kysely<Database>, query: RosterQuery): Promise<RosterPage> {
  const evidence = await hasLegacyEvidence(db);
  const sessions = await hasSessions(db);
  const lastSeen = sessions ? lastSeenSql : sql`NULL::TIMESTAMP`;
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

  const judged = sql`
    WITH ${weights}
    roster AS (
      SELECT p.entity_id AS person_id,
             p.display_name,
             a.login,
             a.inat_user_id,
             (SELECT count(*) FROM sample_collector sc WHERE sc.person_id = p.entity_id) AS samples,
             pm.kind AS membership,
             atl.code AS atlas_code,
             (adm.person_id IS NOT NULL) AS is_admin,
             ${boundRecords} AS bound_records,
             best.top_login,
             best.top_uid,
             best.top_records,
             (SELECT h.display_name FROM inat_account ia
              JOIN person h ON h.entity_id = ia.person_id
              WHERE ia.inat_user_id = best.top_uid AND ia.person_id <> p.entity_id) AS top_holder,
             ${lastSampleSql} AS last_sample,
             ${lastSeen} AS last_seen
      FROM person p
      LEFT JOIN inat_account a ON a.person_id = p.entity_id
      LEFT JOIN person_membership pm ON pm.person_id = p.entity_id
      LEFT JOIN atlas atl ON atl.entity_id = pm.atlas_id
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
    SELECT * FROM judged`;

  const base = sql`
    SELECT * FROM (${judged})
    WHERE (${query.search === ""} OR lower(display_name) LIKE ${term} OR lower(coalesce(login, '')) LIKE ${term})
      AND (${!query.suspect} OR verdict IN ('outweighed', 'unattested'))`;

  const counted = await sql<{ n: number | bigint }>`SELECT count(*) AS n FROM (${base})`.execute(db);
  const total = Number(counted.rows[0]?.n ?? 0);
  // Unfiltered on purpose: the count is an invitation to go and look, so it
  // has to answer "is there anything to look at", not "on this page".
  const wrong = await sql<{ n: number | bigint }>`
    SELECT count(*) AS n FROM (${judged}) WHERE verdict IN ('outweighed', 'unattested')`.execute(db);
  // Ordered as a listing of people, not as a worklist. Sorting the doubtful
  // ones to the front made the first page a queue wearing a roster's name.
  const listed = await sql<RosterRow>`
    ${base}
    ORDER BY samples DESC, display_name
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
    lookWrong: Number(wrong.rows[0]?.n ?? 0),
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
  const lastSeen = (await hasSessions(db)) ? lastSeenSql : sql`NULL::TIMESTAMP`;
  const found = await sql<PersonDetail>`
    SELECT p.entity_id AS person_id, p.display_name, p.given_name, p.family_name, p.label_name,
           a.login, a.inat_user_id,
           (SELECT count(*) FROM sample_collector sc WHERE sc.person_id = p.entity_id) AS samples,
           (SELECT count(*) FROM sample s WHERE s.collector_id = p.entity_id) AS primary_samples,
           pm.kind AS membership,
           atl.code AS atlas_code,
           (adm.person_id IS NOT NULL) AS is_admin,
           ${lastSampleSql} AS last_sample,
           ${lastSeen} AS last_seen
    FROM person p
    LEFT JOIN inat_account a ON a.person_id = p.entity_id
    LEFT JOIN person_membership pm ON pm.person_id = p.entity_id
    LEFT JOIN atlas atl ON atl.entity_id = pm.atlas_id
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
  // Who holds the account their records point at, when it is somebody else:
  // the shared-household case, where only one of a couple can hold the login.
  const top = logins[0];
  const holder =
    top?.uid == null
      ? null
      : ((
          await sql<{ display_name: string }>`
            SELECT h.display_name FROM inat_account ia
            JOIN person h ON h.entity_id = ia.person_id
            WHERE ia.inat_user_id = ${top.uid} AND ia.person_id <> ${personId}`.execute(db)
        ).rows[0]?.display_name ?? null);
  // Summed, not the first match, so this agrees with the listing: one account
  // can appear under more than one weight row (case-variant logins, or a
  // rename recorded against the same id), and taking one of them would show a
  // smaller count here than the roster shows for the same person.
  const boundRows = logins.filter((l) => l.bound);
  const bound =
    boundRows.length === 0
      ? undefined
      : { uid: boundRows[0]!.uid, records: boundRows.reduce((sum, l) => sum + l.records, 0) };
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
    top_holder: holder,
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
