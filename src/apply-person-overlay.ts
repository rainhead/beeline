import type { DuckDBConnection } from "@duckdb/node-api";
import { parseRef, type OverlayField, type PersonOverlayRow } from "./person-overlay.js";

/**
 * Apply staff decisions about people to the store (ADR 0004 overlay, keyed as
 * described in person-overlay.ts). Runs at the end of legacy promotion so a
 * rebuilt store carries every decision forward, and again in-process whenever
 * the roster screen records one, so an edit is live without a rebuild.
 *
 * Nothing here guesses. A reference that names nobody, an account already held
 * by someone else, an atlas code that does not exist — each is returned as an
 * unresolved row for a human to look at, never quietly dropped and never
 * applied to the nearest plausible person.
 */

export interface Unresolved {
  person_ref: string;
  field: string;
  reason: string;
}

export interface ApplyResult {
  applied: number;
  merged: number;
  unresolved: Unresolved[];
}

const rows = async (conn: DuckDBConnection, sql: string, params: unknown[] = []) =>
  (await (await conn.run(sql, params as never)).getRows()) as unknown[][];

const scalar = async (conn: DuckDBConnection, sql: string, params: unknown[] = []) => {
  const r = await rows(conn, sql, params);
  return r[0]?.[0] ?? null;
};

const tableExists = async (conn: DuckDBConnection, name: string) =>
  Number(await scalar(conn, `SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, [name])) > 0;

/**
 * ref → person_id, resolved against the promoted state.
 *
 * `name:` looks in legacy_person_name — the table promotion builds from the
 * distinct recordedBy names, and the natural key a rebuild reproduces — before
 * falling back to person.display_name for people who arrived through iNat
 * rather than legacy. Consulting the promoted name rather than the current one
 * is what lets a rename be replayed: renaming someone does not move the
 * reference that renamed them.
 */
async function resolver(conn: DuckDBConnection, overlay: readonly PersonOverlayRow[] = []) {
  const byName = new Map<string, number[]>();
  if (await tableExists(conn, "legacy_person_name")) {
    for (const [name, id] of await rows(conn, `SELECT name, person_id FROM legacy_person_name`)) {
      byName.set(String(name), [...(byName.get(String(name)) ?? []), Number(id)]);
    }
  }
  for (const [name, id] of await rows(conn, `SELECT display_name, entity_id FROM person`)) {
    if (!byName.has(String(name))) byName.set(String(name), [Number(id)]);
  }
  const byInat = new Map<string, number>();
  for (const [uid, pid] of await rows(conn, `SELECT inat_user_id, person_id FROM inat_account`)) {
    byInat.set(String(uid), Number(pid));
  }
  // A rename the overlay itself records: `name:Ada Collector` still names the
  // person now called `Ada Collector-Smith`. Legacy-promoted stores get this
  // free from legacy_person_name, which keeps the promoted name whatever the
  // person is called later — but a store with no legacy staging has only the
  // current name, and without this a rename would orphan every later decision
  // about that person on replay.
  // Both directions. Forward covers a row that still names someone by the
  // name a previous row changed; backward covers the commoner case, a row the
  // app wrote after a rename and so keyed on the NEW name, replayed against a
  // freshly promoted store that only knows the old one.
  const renamedTo = new Map<string, string>();
  const renamedFrom = new Map<string, string>();
  for (const r of overlay) {
    if (r.field !== "display_name") continue;
    const parsed = parseRef(r.person_ref);
    if (parsed?.kind !== "name") continue;
    renamedTo.set(parsed.key, r.value);
    renamedFrom.set(r.value, parsed.key);
  }

  const lookup = (key: string, seen: Set<string>): { id: number } | { problem: string } => {
    const ids = byName.get(key);
    if (ids !== undefined) {
      if (ids.length > 1) return { problem: `'${key}' names ${ids.length} people` };
      return { id: ids[0]! };
    }
    for (const next of [renamedTo.get(key), renamedFrom.get(key)]) {
      if (next !== undefined && !seen.has(next)) {
        seen.add(next);
        const found = lookup(next, seen);
        if ("id" in found) return found;
      }
    }
    return { problem: `no person named '${key}'` };
  };

  return (ref: string): { id: number } | { problem: string } => {
    const parsed = parseRef(ref);
    if (parsed === null) return { problem: `'${ref}' is not a person reference` };
    if (parsed.kind === "inat") {
      const id = byInat.get(parsed.key);
      return id === undefined ? { problem: `no person holds iNat account ${parsed.key}` } : { id };
    }
    return lookup(parsed.key, new Set([parsed.key]));
  };
}

/** Every foreign key to person, repointed loser → winner. */
async function mergePerson(conn: DuckDBConnection, loser: number, winner: number): Promise<void> {
  await conn.run(`UPDATE determination SET determiner_id = $1 WHERE determiner_id = $2`, [winner, loser] as never);

  // Updating sample would violate sample_collector's foreign key even though
  // neither the key nor the referencing rows change: DuckDB <= 1.5 rewrites an
  // UPDATE as delete + insert, and the delete half sees the children (the same
  // limitation migration 0007 works around; beeline-c1b). So the children are
  // lifted off, the parent updated, and the children put back — remapped,
  // deduplicated, and reordered in the one pass.
  //
  // sample_collector is keyed (sample_id, person_id), so where both people
  // collected the same sample the survivor appears once, at the earlier of the
  // two positions, rather than twice.
  await conn.run(`CREATE OR REPLACE TEMP TABLE merge_collectors AS
    SELECT sample_id, min(position) AS position
    FROM (SELECT sample_id, position, CASE WHEN person_id = $1 THEN $2 ELSE person_id END AS person_id
          FROM sample_collector
          WHERE sample_id IN (SELECT sample_id FROM sample_collector WHERE person_id IN ($1, $2)))
    WHERE person_id = $2
    GROUP BY sample_id`, [loser, winner] as never);
  await conn.run(
    `DELETE FROM sample_collector WHERE person_id IN ($1, $2)`,
    [loser, winner] as never,
  );
  await conn.run(`UPDATE sample SET collector_id = $1 WHERE collector_id = $2`, [winner, loser] as never);
  await conn.run(`UPDATE sample SET atlas_assigned_by = $1 WHERE atlas_assigned_by = $2`, [winner, loser] as never);
  await conn.run(
    `INSERT INTO sample_collector (sample_id, person_id, position)
     SELECT sample_id, $1, position FROM merge_collectors`,
    [winner] as never,
  );
  await conn.run(`DROP TABLE merge_collectors`);

  // 1:1 facets: the winner's own row wins; the loser's is dropped, never
  // silently overwriting a fact the winner already states.
  for (const t of ["inat_account", "person_orcid", "person_home_atlas", "person_admin"]) {
    await conn.run(
      `DELETE FROM ${t} WHERE person_id = $1 AND EXISTS (SELECT 1 FROM ${t} w WHERE w.person_id = $2)`,
      [loser, winner] as never,
    );
    await conn.run(`UPDATE ${t} SET person_id = $1 WHERE person_id = $2`, [winner, loser] as never);
  }
  await conn.run(`DELETE FROM person WHERE entity_id = $1`, [loser] as never);
}

export async function applyPersonOverlay(
  conn: DuckDBConnection,
  overlay: readonly PersonOverlayRow[],
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, merged: 0, unresolved: [] };
  if (overlay.length === 0) return result;
  const resolve = await resolver(conn, overlay);
  const fail = (r: PersonOverlayRow, reason: string) =>
    result.unresolved.push({ person_ref: r.person_ref, field: r.field, reason });

  // Merges first, so a later row naming the absorbed person lands on the
  // person they were absorbed into rather than on a row that no longer exists.
  const moved = new Map<number, number>();
  const follow = (id: number): number => {
    const seen = new Set<number>();
    let at = id;
    while (moved.has(at) && !seen.has(at)) {
      seen.add(at);
      at = moved.get(at)!;
    }
    return at;
  };
  for (const row of overlay.filter((r) => r.field === "merged_into")) {
    const from = resolve(row.person_ref);
    const into = resolve(row.value);
    if ("problem" in from) { fail(row, from.problem); continue; }
    if ("problem" in into) { fail(row, `merge target: ${into.problem}`); continue; }
    const loser = follow(from.id);
    const winner = follow(into.id);
    if (loser === winner) { fail(row, "already the same person"); continue; }
    await mergePerson(conn, loser, winner);
    moved.set(loser, winner);
    result.merged++;
    result.applied++;
  }

  for (const row of overlay.filter((r) => r.field !== "merged_into")) {
    const found = resolve(row.person_ref);
    if ("problem" in found) { fail(row, found.problem); continue; }
    const id = follow(found.id);
    const problem = await applyField(conn, id, row.field, row.value);
    if (problem !== null) fail(row, problem);
    else result.applied++;
  }
  return result;
}

/** One field onto one person; a string reason if it could not be set. */
async function applyField(
  conn: DuckDBConnection,
  personId: number,
  field: OverlayField,
  value: string,
): Promise<string | null> {
  if (field === "inat_user_id") {
    if (value === "") {
      await conn.run(`DELETE FROM inat_account WHERE person_id = $1`, [personId] as never);
      return null;
    }
    const [idPart, loginPart] = value.split(" ");
    const uid = Number(idPart);
    const holder = await scalar(conn, `SELECT person_id FROM inat_account WHERE inat_user_id = $1`, [uid]);
    if (holder !== null && Number(holder) !== personId) {
      return `iNat account ${uid} is already bound to person ${Number(holder)}`;
    }
    // Keep a login we already know over the number, so an id-only row does not
    // blank a good display value.
    const known = await scalar(conn, `SELECT login FROM inat_account WHERE inat_user_id = $1`, [uid]);
    const login = loginPart ?? (known === null ? String(uid) : String(known));
    await conn.run(`DELETE FROM inat_account WHERE person_id = $1`, [personId] as never);
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES ($1, $2, $3)`, [
      personId,
      uid,
      login,
    ] as never);
    return null;
  }

  if (field === "admin") {
    if (value === "no") {
      await conn.run(`DELETE FROM person_admin WHERE person_id = $1`, [personId] as never);
    } else {
      await conn.run(
        `INSERT INTO person_admin (person_id, granted_by) VALUES ($1, $2) ON CONFLICT (person_id) DO NOTHING`,
        [personId, "overlay"] as never,
      );
    }
    return null;
  }

  if (field === "home_atlas") {
    if (value === "") {
      await conn.run(`DELETE FROM person_home_atlas WHERE person_id = $1`, [personId] as never);
      return null;
    }
    const atlas = await scalar(conn, `SELECT entity_id FROM atlas WHERE code = $1`, [value]);
    if (atlas === null) return `no atlas with code '${value}'`;
    await conn.run(
      `INSERT INTO person_home_atlas (person_id, atlas_id) VALUES ($1, $2)
       ON CONFLICT (person_id) DO UPDATE SET atlas_id = excluded.atlas_id`,
      [personId, Number(atlas)] as never,
    );
    return null;
  }

  // The name columns. Blank clears to NULL, except display_name, which the
  // parser already refuses to blank.
  const columns: Partial<Record<OverlayField, string>> = {
    display_name: "display_name",
    given_name: "given_name",
    family_name: "family_name",
    label_name: "label_name",
  };
  const column = columns[field];
  if (column === undefined) return `cannot apply '${field}'`;
  await conn.run(`UPDATE person SET ${column} = $1 WHERE entity_id = $2`, [
    value === "" ? null : value,
    personId,
  ] as never);
  return null;
}
