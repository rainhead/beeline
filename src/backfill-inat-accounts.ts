import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";

/**
 * Fill inat_account for people whose legacy records carry a login but no
 * usable numeric user id, by resolving the login through the iNat API
 * (GET /v1/users/{login} — public data, no auth). Only both-ways-unambiguous
 * pairs are written: one person per login, one login per person, neither
 * side already claimed. Everything else is reported, never guessed
 * (beeline-gju). Idempotent: filled people drop out of the candidate set.
 */

export interface BackfillResult {
  filled: Array<{ person: string; login: string; userId: number; apiName: string | null }>;
  skipped: Array<{ login: string; reason: string }>;
}

export interface BackfillOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  /** Pause between lookups; public API etiquette. */
  delayMs?: number;
}

export async function backfillInatAccounts(
  conn: DuckDBConnection,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? "https://api.inaturalist.org/v1";

  // Both-ways-unambiguous candidates: the login appears on exactly one
  // person's records, that person carries exactly one login, and neither the
  // person nor the login is already in inat_account. Ambiguous logins are
  // reported with their person count.
  const candidates = (await (
    await conn.run(`
      WITH pairs AS (
        SELECT DISTINCT m.person_id, p.display_name, r.userLogin AS login
        FROM legacy_occurrence r
        JOIN legacy_person_map m
          ON m.fn IS NOT DISTINCT FROM r.firstName
         AND m.ln IS NOT DISTINCT FROM r.lastName
        JOIN person p ON p.entity_id = m.person_id
        WHERE nullif(r.userLogin, '') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM inat_account a WHERE a.person_id = m.person_id)
      )
      SELECT login, display_name,
             (SELECT count(*) FROM pairs q WHERE q.login = pairs.login) AS people_for_login,
             (SELECT count(*) FROM pairs q WHERE q.person_id = pairs.person_id) AS logins_for_person,
             EXISTS (SELECT 1 FROM inat_account a WHERE lower(a.login) = lower(pairs.login)) AS login_claimed,
             person_id
      FROM pairs ORDER BY login`)
  ).getRows()) as Array<[string, string, bigint, bigint, boolean, number]>;

  const result: BackfillResult = { filled: [], skipped: [] };
  for (const [login, displayName, peopleForLogin, loginsForPerson, loginClaimed, personId] of candidates) {
    if (loginClaimed) {
      result.skipped.push({ login, reason: `login already claimed in inat_account; on records of ${displayName} — misattributed?` });
      continue;
    }
    if (Number(peopleForLogin) > 1) {
      result.skipped.push({ login, reason: `login spans ${peopleForLogin} people (shared account or person split)` });
      continue;
    }
    if (Number(loginsForPerson) > 1) {
      result.skipped.push({ login, reason: `${displayName} carries ${loginsForPerson} logins` });
      continue;
    }

    const response = await fetchImpl(`${apiBase}/users/${encodeURIComponent(login)}`);
    if (!response.ok) {
      result.skipped.push({ login, reason: `API ${response.status} — login gone or renamed` });
      continue;
    }
    const body = (await response.json()) as {
      results: Array<{ id: number; login: string; name: string | null }>;
    };
    const user = body.results?.[0];
    if (!user || user.login.toLowerCase() !== login.toLowerCase()) {
      result.skipped.push({ login, reason: `API returned ${user?.login ?? "nothing"} — not an exact match` });
      continue;
    }
    // A login can sit on the wrong person's records (shared data entry,
    // clerical error). If the account's own profile name names a different
    // person we know, believe the profile: the login is misattributed here.
    if (user.name) {
      const [claimant] = (await (
        await conn.run(
          `SELECT display_name FROM person
           WHERE lower(display_name) = lower(trim($1)) AND entity_id <> $2 LIMIT 1`,
          [user.name, personId],
        )
      ).getRows()) as Array<[string]>;
      if (claimant) {
        result.skipped.push({
          login,
          reason: `API profile name '${user.name}' is existing person '${claimant[0]}', not ${displayName} — login misattributed on their records?`,
        });
        continue;
      }
    }
    await conn.run(
      `INSERT INTO inat_account (person_id, inat_user_id, login) VALUES ($1, $2, $3)`,
      [personId, user.id, user.login],
    );
    result.filled.push({ person: displayName, login: user.login, userId: user.id, apiName: user.name });
    if (opts.delayMs !== 0) await new Promise((r) => setTimeout(r, opts.delayMs ?? 1100));
  }
  return result;
}

// CLI: pnpm inat:backfill-accounts [db]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? "beeline.duckdb";
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const result = await backfillInatAccounts(conn);
  conn.closeSync();
  console.log(JSON.stringify(result, null, 2));
}
