import type { DuckDBConnection } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";
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
  // Legacy's mapping is authoritative where it exists — it keeps the promoted
  // name whatever the person is called now — so a name it already covers is
  // left alone. Everyone else is APPENDED, not set: two people sharing a
  // display name have to reach the ambiguity check below. Keeping only the
  // first would resolve an ambiguous reference to whichever person the scan
  // happened to reach first, which is the one outcome this whole module
  // refuses to produce.
  const fromLegacy = new Set(byName.keys());
  for (const [name, id] of await rows(conn, `SELECT display_name, entity_id FROM person`)) {
    const key = String(name);
    if (fromLegacy.has(key)) continue;
    byName.set(key, [...(byName.get(key) ?? []), Number(id)]);
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

export async function applyPersonOverlay(
  conn: DuckDBConnection,
  overlay: readonly PersonOverlayRow[],
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, unresolved: [] };
  if (overlay.length === 0) return result;
  const resolve = await resolver(conn, overlay);
  const fail = (r: PersonOverlayRow, reason: string) =>
    result.unresolved.push({ person_ref: r.person_ref, field: r.field, reason });

  for (const row of overlay) {
    const found = resolve(row.person_ref);
    if ("problem" in found) { fail(row, found.problem); continue; }
    const problem = await applyField(conn, found.id, row.field, row.value, row.author);
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
  /** Who decided — the overlay row's author, recorded on the grant. */
  author: string,
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
        [personId, author] as never,
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

// CLI: pnpm person:apply [db] — replay the overlay onto a store that already
// exists. Promotion does this at the end of a rebuild; this is the same step
// for a deployed store, where a bulk decision (a roster import, a curated file
// graduated into git) has to land without one.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const { mergeOverlays, readOverlay } = await import("./person-overlay.js");
  const dbPath = process.argv[2] ?? "beeline.duckdb";
  const curated = process.argv[3] ?? "ingest/person-overlay.csv";
  const app = process.argv[4] ?? "data/person-overlay.csv";
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const result = await applyPersonOverlay(conn, mergeOverlays(await readOverlay(curated), await readOverlay(app)));
  await conn.run("CHECKPOINT");
  conn.closeSync();
  console.log(JSON.stringify(result, null, 2));
}
