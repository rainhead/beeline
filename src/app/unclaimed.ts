import type { DuckDBConnection } from "@duckdb/node-api";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { promoteObservations } from "../promote-observations.js";
import { personHandle } from "./roster.js";

/**
 * Records from people Beeline does not know (beeline-e85).
 *
 * An observation from an iNaturalist user no person is bound to is never
 * minted — every sample has a primary collector — so it waits in
 * observation_sample_unresolved, routed to a program by unclaimed_record
 * (schema/108). Nobody is anonymous here: each observer has an iNaturalist
 * account, and the store simply holds no person for it. So the screen's work
 * is identification, and it has the overlay's two answers: *bind* the account
 * to somebody already here, or *admit* somebody new (`create` plus the
 * binding, which is also what lets them sign in).
 *
 * One row per observer, not per record: both answers are about the person,
 * and clear every record of theirs at once.
 */

export interface Lead {
  display_name: string;
  handle: string;
}

/** Why somebody already here might be this observer. */
export type SuggestionEvidence = "register" | "inat_name";

export interface Suggestion {
  person_id: number;
  display_name: string;
  handle: string;
  /** Every reason this person is suggested, strongest first. */
  evidence: SuggestionEvidence[];
  /** The login they are already bound to, if any — binding would replace it. */
  bound_login: string | null;
}

export interface UnclaimedObserver {
  user_id: number;
  login: string;
  /** The name on their iNaturalist profile, where they gave one. */
  inat_name: string | null;
  records: number;
  /** Records in the open season (season.started_on) — split, per the project's rule. */
  open_records: number;
  first_observed: Date;
  last_observed: Date;
  /** Codes of every program their records fall in, most records first. */
  programs: string[];
  suggestions: Suggestion[];
}

export interface UnclaimedProgram {
  code: string;
  name: string;
  leads: Lead[];
  /** Observers with any record here, most records first. */
  observers: UnclaimedObserver[];
}

export interface UnclaimedRecord {
  inat_id: number;
  sample_number: string;
  specimen_count: number;
  observed_on: Date;
  state_province: string | null;
  county_name: string | null;
  program_code: string;
}

export interface UnclaimedListing {
  programs: UnclaimedProgram[];
  observers: number;
  records: number;
  open_records: number;
}


/**
 * Both readers of the legacy register exist only where legacy promotion has
 * staged it (ingest/promote-register.sql): a store without it simply offers
 * fewer suggestions.
 */
async function hasRegister(db: Kysely<Database>): Promise<boolean> {
  const found = await sql<{ n: number | bigint }>`
    SELECT count(*) AS n FROM information_schema.tables
    WHERE table_name = 'legacy_username_register'`.execute(db);
  return Number(found.rows[0]?.n ?? 0) === 1;
}

/**
 * The name on each observer's iNaturalist profile, from the newest load of
 * any of their unresolved records. Read from the stored JSON rather than
 * observation_field, which has no column for it: only these few hundred rows
 * ever need it.
 */
async function inatNames(db: Kysely<Database>, userIds: readonly number[]): Promise<Map<number, string>> {
  if (userIds.length === 0) return new Map();
  const found = await sql<{ user_id: number | bigint; name: string | null }>`
    SELECT u.user_id,
           arg_max(nullif(trim(json_extract_string(o.content, '$.user.name')), ''), o.inat_id) AS name
    FROM unclaimed_record u
    JOIN observation_current o ON o.inat_id = u.inat_id
    WHERE u.user_id IN (${sql.join(userIds)})
    GROUP BY u.user_id`.execute(db);
  return new Map(
    found.rows.filter((r) => r.name !== null).map((r) => [Number(r.user_id), r.name as string]),
  );
}

/**
 * Who each observer might be, among the people already here — suggestions
 * for a person to confirm, never a binding (beeline-eft is what acting on a
 * resemblance alone did). Two kinds of evidence, both a name:
 *
 *   register   the legacy register lists the observer's login under a name
 *              some person here carries — somebody the old system knew by
 *              this account. 9 of 52 observers on the dev store.
 *   inat_name  the observer's iNaturalist profile name is some person's
 *              name. 3 of 52.
 *
 * Names are compared folded to letters and digits, the identity rule legacy
 * promotion uses (legacy_name_key, ingest/promote-legacy.sql), spelled out
 * here because that macro exists only on a store legacy promotion has run on.
 * The legacy records' own login and user-id columns were tried too and reach
 * nobody: an observer whose account is on legacy rows was already bound by
 * promotion.
 */
async function suggestionsFor(
  db: Kysely<Database>,
  observers: ReadonlyArray<{ user_id: number; login: string; inat_name: string | null }>,
): Promise<Map<number, Suggestion[]>> {
  const out = new Map<number, Suggestion[]>();
  if (observers.length === 0) return out;
  const fold = (x: ReturnType<typeof sql>) => sql`regexp_replace(lower(${x}), '[^a-z0-9]', '', 'g')`;
  const observerRows = sql.join(
    observers.map((o) => sql`(${o.user_id}, ${o.login.toLowerCase()}, ${o.inat_name})`),
  );
  const register = await hasRegister(db);
  const found = await sql<{
    user_id: number | bigint;
    person_id: number;
    display_name: string;
    login: string | null;
    evidence: SuggestionEvidence;
  }>`
    WITH obs(user_id, login, inat_name) AS (VALUES ${observerRows}),
    matched AS (
      ${
        register
          ? sql`SELECT o.user_id, p.entity_id AS person_id, 'register' AS evidence
                FROM obs o
                JOIN legacy_username_register g ON g.login = o.login
                JOIN person p ON ${fold(sql`p.display_name`)} = ${fold(sql`g.full_name`)}
                UNION ALL`
          : sql``
      }
      SELECT o.user_id, p.entity_id AS person_id, 'inat_name' AS evidence
      FROM obs o
      JOIN person p ON ${fold(sql`p.display_name`)} = ${fold(sql`o.inat_name`)}
      WHERE o.inat_name IS NOT NULL
    )
    SELECT DISTINCT m.user_id, m.person_id, p.display_name, a.login, m.evidence
    FROM matched m
    JOIN person p ON p.entity_id = m.person_id
    LEFT JOIN inat_account a ON a.person_id = p.entity_id
    ORDER BY p.display_name`.execute(db);
  for (const r of found.rows) {
    const uid = Number(r.user_id);
    const list = out.get(uid) ?? [];
    let s = list.find((x) => x.person_id === r.person_id);
    if (s === undefined) {
      s = {
        person_id: r.person_id,
        display_name: r.display_name,
        handle: personHandle({ person_id: r.person_id, login: r.login }),
        evidence: [],
        bound_login: r.login,
      };
      list.push(s);
    }
    if (!s.evidence.includes(r.evidence)) s.evidence.push(r.evidence);
    s.evidence.sort((a, b) => (a === "register" ? -1 : b === "register" ? 1 : 0));
    out.set(uid, list);
  }
  return out;
}

async function observers(db: Kysely<Database>, userId?: number): Promise<UnclaimedObserver[]> {
  const found = await sql<{
    user_id: number | bigint;
    login: string;
    records: number | bigint;
    open_records: number | bigint;
    first_observed: Date;
    last_observed: Date;
    programs: string[];
  }>`
    SELECT u.user_id,
           arg_max(u.user_login, u.inat_id) AS login,
           count(*) AS records,
           count(*) FILTER (WHERE u.observed_on >= (SELECT started_on FROM season)) AS open_records,
           min(u.observed_on) AS first_observed,
           max(u.observed_on) AS last_observed,
           (SELECT list(code ORDER BY n DESC, code) FROM (
              SELECT x.program_code AS code, count(*) AS n FROM unclaimed_record x
              WHERE x.user_id = u.user_id GROUP BY 1)) AS programs
    FROM unclaimed_record u
    WHERE u.user_id IS NOT NULL ${userId === undefined ? sql`` : sql`AND u.user_id = ${userId}`}
    GROUP BY u.user_id
    ORDER BY records DESC, login`.execute(db);
  const ids = found.rows.map((r) => Number(r.user_id));
  const names = await inatNames(db, ids);
  const base = found.rows.map((r) => ({
    user_id: Number(r.user_id),
    login: r.login,
    inat_name: names.get(Number(r.user_id)) ?? null,
  }));
  const suggestions = await suggestionsFor(db, base);
  return found.rows.map((r, i) => ({
    ...base[i]!,
    records: Number(r.records),
    open_records: Number(r.open_records),
    first_observed: r.first_observed,
    last_observed: r.last_observed,
    programs: [...r.programs],
    suggestions: suggestions.get(Number(r.user_id)) ?? [],
  }));
}

async function leadsByProgram(db: Kysely<Database>): Promise<Map<string, Lead[]>> {
  const found = await sql<{ code: string; person_id: number; display_name: string; login: string | null }>`
    SELECT pr.code, p.entity_id AS person_id, p.display_name, a.login
    FROM program_lead pl
    JOIN program pr ON pr.entity_id = pl.program_id
    JOIN person p ON p.entity_id = pl.person_id
    LEFT JOIN inat_account a ON a.person_id = p.entity_id
    ORDER BY p.display_name`.execute(db);
  const out = new Map<string, Lead[]>();
  for (const r of found.rows) {
    const list = out.get(r.code) ?? [];
    list.push({ display_name: r.display_name, handle: personHandle(r) });
    out.set(r.code, list);
  }
  return out;
}

/**
 * Every observer, under every program their records fall in. An observer in
 * two programs (1 of 52 on the dev store) is listed under both: each
 * program's staff should see them, and binding them once clears both. Under
 * each program the counts and dates are that program's records only, so the
 * sections add up; the observer's page has the whole.
 */
export async function listUnclaimed(db: Kysely<Database>): Promise<UnclaimedListing> {
  const all = await observers(db);
  const leads = await leadsByProgram(db);
  const programs = await db
    .selectFrom("program")
    .select(["code", "name"])
    .orderBy(sql`atlas_id IS NULL`)
    .orderBy("name")
    .execute();
  const here = await sql<{
    user_id: number | bigint;
    program_code: string;
    records: number | bigint;
    open_records: number | bigint;
    first_observed: Date;
    last_observed: Date;
  }>`
    SELECT user_id, program_code,
           count(*) AS records,
           count(*) FILTER (WHERE observed_on >= (SELECT started_on FROM season)) AS open_records,
           min(observed_on) AS first_observed,
           max(observed_on) AS last_observed
    FROM unclaimed_record
    WHERE user_id IS NOT NULL
    GROUP BY user_id, program_code`.execute(db);
  const inProgram = (code: string): UnclaimedObserver[] =>
    all.flatMap((o) => {
      const h = here.rows.find((r) => Number(r.user_id) === o.user_id && r.program_code === code);
      return h === undefined
        ? []
        : [
            {
              ...o,
              records: Number(h.records),
              open_records: Number(h.open_records),
              first_observed: h.first_observed,
              last_observed: h.last_observed,
            },
          ];
    });
  return {
    programs: programs
      .map((p) => ({
        code: p.code,
        name: p.name,
        leads: leads.get(p.code) ?? [],
        observers: inProgram(p.code).sort((a, b) => b.records - a.records || a.login.localeCompare(b.login)),
      }))
      .filter((p) => p.observers.length > 0),
    observers: all.length,
    records: all.reduce((n, o) => n + o.records, 0),
    open_records: all.reduce((n, o) => n + o.open_records, 0),
  };
}

export interface ObserverDetail {
  observer: UnclaimedObserver;
  records: UnclaimedRecord[];
  programs: Array<{ code: string; name: string; leads: Lead[] }>;
}

/** One observer and their records; null once nothing of theirs is unresolved. */
export async function observerDetail(db: Kysely<Database>, userId: number): Promise<ObserverDetail | null> {
  const [observer] = await observers(db, userId);
  if (observer === undefined) return null;
  const found = await sql<{
    inat_id: number | bigint;
    sample_number: string;
    specimen_count: number;
    observed_on: Date;
    state_province: string | null;
    county_name: string | null;
    program_code: string;
  }>`
    SELECT inat_id, sample_number, specimen_count, observed_on, state_province, county_name, program_code
    FROM unclaimed_record
    WHERE user_id = ${userId}
    ORDER BY observed_on DESC, try_cast(sample_number AS INTEGER) NULLS LAST, sample_number, inat_id`.execute(db);
  const leads = await leadsByProgram(db);
  const names = await db.selectFrom("program").select(["code", "name"]).execute();
  return {
    observer,
    records: found.rows.map((r) => ({ ...r, inat_id: Number(r.inat_id) })),
    programs: observer.programs.map((code) => ({
      code,
      name: names.find((n) => n.code === code)?.name ?? code,
      leads: leads.get(code) ?? [],
    })),
  };
}

/** Everyone a bind could name, for the person field's suggestions. */
export async function bindablePeople(db: Kysely<Database>): Promise<string[]> {
  const found = await sql<{ display_name: string }>`
    SELECT DISTINCT display_name FROM person ORDER BY display_name`.execute(db);
  return found.rows.map((r) => r.display_name);
}

/**
 * What became of an observer's records once they were bound: made into new
 * samples, linked to samples already here (a legacy record of the same
 * collecting event — the reason binding is not the same as admitting), and
 * left unminted, which minting's own views explain (an ambiguous match, a
 * printed sample of that number).
 */
export interface MintOutcome {
  made: number;
  linked: number;
  left: number;
}

// One promotion at a time from the app. Two binds at once would otherwise
// race one transaction against another on the same connection, which DuckDB
// cannot hold — the print runs' lock exists for the same reason
// (src/print-run.ts).
let mintQueue: Promise<unknown> = Promise.resolve();

/**
 * Make an observer's records into samples now, rather than at 2am — the same
 * promotion the nightly runs, so a bound volunteer's observations link to
 * their legacy samples exactly as they would have overnight (27 of the 79
 * records the dev store's suggestions would bind are such links, and
 * admitting those people instead would have minted 27 duplicates). Skips the
 * observation_field refresh, which only a sync can change and which is most
 * of a promotion's cost; with it skipped a pass is ~0.7 s on the dev store.
 *
 * Runs on its own connection: promotion is one raw BEGIN/COMMIT transaction
 * and must not share a connection with the scheduler's.
 */
export async function mintNow(
  conn: DuckDBConnection,
  userId: number,
  opts: { sampleOverlayPath?: string },
): Promise<MintOutcome> {
  const run = mintQueue.then(async () => {
    const count = async (q: string): Promise<number> => {
      const [[v]] = (await (await conn.run(q)).getRows()) as [[bigint]];
      return Number(v);
    };
    const theirs = `(SELECT inat_id FROM observation_sample_candidate WHERE user_id = ${Number(userId)})`;
    const made = await count(`SELECT count(*) FROM sample_mint_pending WHERE lead_inat_id IN ${theirs}`);
    const linked = await count(`SELECT count(*) FROM sample_mint_free_link WHERE lead_inat_id IN ${theirs}`);
    await promoteObservations(conn, { sampleOverlayPath: opts.sampleOverlayPath, refreshFields: false });
    // A sample's own citation, or an imported sample's legacy records naming
    // the observation — minting treats both as the observation's sample.
    const cited = await count(
      `SELECT count(*) FROM ${theirs} t
       WHERE EXISTS (SELECT 1 FROM sample s WHERE s.inat_observation_id = t.inat_id)
          OR EXISTS (SELECT 1 FROM sample_legacy_observation lo WHERE lo.inat_observation_id = t.inat_id)`,
    );
    const all = await count(`SELECT count(*) FROM ${theirs} t`);
    return { made, linked, left: all - cited };
  });
  mintQueue = run.catch(() => {});
  return run;
}
