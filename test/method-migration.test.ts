import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { migrate, MIGRATIONS_DIR, schemaDrift } from "../src/migrate.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

/**
 * migrations/0123 makes the controlled list of methods, each sample's method
 * and the three views over them (beeline-ni5m.15), and backfills sample_method
 * from sample.protocol. Checked by putting a store back as the migration before
 * it left it, with samples of several wordings, migrating, and finding the
 * store as a fresh build.
 */

const FILE = "0123-a-controlled-list-of-methods.sql";
const VIEWS = ["sample_without_method", "sample_method_out_of_step", "sample_kind_method_mismatch"];
const OLD_PROTOCOL_COMMENT = "Free text today ('vane trap', '6 Vane Traps'); controlled vocabulary pending staff answers (docs/questions.md, Trap sampling q3).";

/** A store as 0122 left it: none of the new objects, and the old comment on sample.protocol. */
async function storeBefore() {
  const made = await createMemoryDb();
  const { conn } = made;
  await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector')`);
  const ids: Record<string, number> = {};
  const wordings: [string, string][] = [
    ["net", "'aerial net'"],
    ["old-net", "'net'"],
    ["count", "'6 Vane Traps'"],
    ["pantrap", "'pantrap'"],
    ["mixed", "'pan traps and vane traps'"],
    ["unlisted", "'ground pitfall'"],
    ["empty", "NULL"],
    ["entered", "'vane trap'"],
    // A count a person set (the effort) wins over the one the text states.
    ["corrected", "'6 vane traps'"],
    // A netted sample takes no count, whatever its effort says.
    ["netted", "'aerial net'"],
  ];
  for (const [i, [name, protocol]] of wordings.entries()) {
    ids[name] = await insertCleanSample(conn, {
      sample_number: `'${i + 1}'`,
      protocol,
      kind: name === "count" || name === "pantrap" ? "'trap'" : "'net'",
      // A sample entered in Beeline keeps its count as the number its effort starts with.
      ...(name === "entered" ? { sampling_effort: "'8 vane traps'" } : {}),
      ...(name === "corrected" ? { sampling_effort: "'9 vane traps'" } : {}),
    });
  }
  // The efforts as the store before the migration held them, which the fixture's own writer has tidied.
  for (const [name, effort] of [["entered", "'8 vane traps'"], ["corrected", "'9 vane traps'"], ["netted", "'6 aerial nets'"], ["count", "NULL"]] as const) {
    await conn.run(`UPDATE sample SET sampling_effort = ${effort} WHERE entity_id = ${ids[name]}`);
  }
  for (const view of VIEWS) await conn.run(`DROP VIEW ${view}`);
  for (const table of ["sample_method", "method_text", "method"]) await conn.run(`DROP TABLE ${table}`);
  await conn.run(`COMMENT ON COLUMN sample.protocol IS '${OLD_PROTOCOL_COMMENT.replaceAll("'", "''")}'`);
  return { ...made, ids };
}

const migrateOnly = async (conn: DuckDBConnection) => {
  const dir = await mkdtemp(join(tmpdir(), "migration-0123-"));
  await copyFile(join(MIGRATIONS_DIR, FILE), join(dir, "9999-under-test.sql"));
  return migrate(conn, { dir });
};

describe("migration 0123: a controlled list of methods", () => {
  it("gives each sample its method from the text, and the store is a fresh build", async () => {
    const { conn, ids } = await storeBefore();
    expect(await migrateOnly(conn)).toEqual(["9999-under-test.sql"]);

    const got = await rows(conn, `SELECT sample_id, method_code, trap_count FROM sample_method ORDER BY sample_id`);
    expect(got).toEqual([
      [ids.net, "aerial net", null],
      [ids["old-net"], "aerial net", null],
      [ids.count, "vane trap", 6],
      [ids.pantrap, "pan trap", null],
      [ids.mixed, "pan and vane traps", null],
      [ids.entered, "vane trap", 8],
      [ids.corrected, "vane trap", 9],
      [ids.netted, "aerial net", null],
    ]);
    // The old effort column is written from the stored count, as its one writer writes it: filled for the count in the
    // text, kept where it agreed, made from the count a person set, and emptied for a netted sample.
    expect(await rows(conn, `SELECT entity_id, sampling_effort FROM sample WHERE entity_id IN (${ids.count}, ${ids.entered}, ${ids.corrected}, ${ids.netted}) ORDER BY 1`)).toEqual([
      [ids.count, "6 vane traps"], [ids.entered, "8 vane traps"], [ids.corrected, "9 vane traps"], [ids.netted, null],
    ]);
    // The unlisted text and the empty one have no method, and are on the worklist.
    expect(await rows(conn, `SELECT sample_id FROM sample_without_method ORDER BY 1`)).toEqual([[ids.unlisted], [ids.empty]]);
    expect(await rows(conn, `SELECT count(*) FROM sample_method_out_of_step`)).toEqual([[0n]]);
    // The kinds were set by the old rules, here as fixtures: the mixed, entered and corrected samples are nets here, and their methods are traps.
    expect(await rows(conn, `SELECT sample_id FROM sample_kind_method_mismatch ORDER BY 1`)).toEqual([[ids.mixed], [ids.entered], [ids.corrected]]);

    // The comment on the column is restated, and the store has what a fresh build has.
    expect(await schemaDrift(conn)).toEqual([]);
    const fresh = await createMemoryDb();
    const same = async (sql: string) => expect(await rows(conn, sql)).toEqual(await rows(fresh.conn, sql));
    await same(`SELECT code, label_word, is_trap FROM method ORDER BY code`);
    await same(`SELECT text, method_code, trap_count FROM method_text ORDER BY text`);
    await same(`SELECT table_name, comment FROM duckdb_tables() WHERE table_name IN ('method', 'sample_method', 'method_text') ORDER BY 1`);
    await same(`SELECT table_name, column_name, comment FROM duckdb_columns() WHERE table_name IN ('method', 'sample_method', 'method_text') OR (table_name = 'sample' AND column_name = 'protocol') ORDER BY 1, 2`);
    await same(`SELECT view_name, comment FROM duckdb_views() WHERE view_name IN (${VIEWS.map((v) => `'${v}'`).join(", ")}) ORDER BY 1`);
  });

  it("is safe to run on a store with no samples", async () => {
    const { conn } = await createMemoryDb();
    for (const view of VIEWS) await conn.run(`DROP VIEW ${view}`);
    for (const table of ["sample_method", "method_text", "method"]) await conn.run(`DROP TABLE ${table}`);
      expect(await migrateOnly(conn)).toEqual(["9999-under-test.sql"]);
    expect(await rows(conn, `SELECT count(*) FROM sample_method`)).toEqual([[0n]]);
  });

  it("is followed by one statement that repairs the rows an older release left, which the header gives", async () => {
    const { conn, ids } = await storeBefore();
    expect(await migrateOnly(conn)).toEqual(["9999-under-test.sql"]);
    // The old code, rolled back to: a method as written changed, or made, with no sample_method row.
    await conn.run(`UPDATE sample SET protocol = 'pan trap' WHERE entity_id = ${ids.net}`);
    await conn.run(`UPDATE sample SET protocol = 'vacuum' WHERE entity_id = ${ids.unlisted}`);
    await conn.run(`UPDATE sample SET protocol = 'ground pitfall' WHERE entity_id = ${ids.pantrap}`);
    expect(Number((await rows(conn, `SELECT count(*) FROM sample_method_out_of_step`))[0]![0])).toBe(3);
    const text = await readFile(join(MIGRATIONS_DIR, FILE), "utf8");
    const statement = text.split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
    expect(statement).toMatch(/^MERGE INTO sample_method/);
    await conn.run(statement);
    expect(await rows(conn, `SELECT count(*) FROM sample_method_out_of_step`)).toEqual([[0n]]);
    expect(await rows(conn, `SELECT method_code FROM sample_method WHERE sample_id IN (${ids.net}, ${ids.unlisted}) ORDER BY sample_id`)).toEqual([["pan trap"], ["vacuum"]]);
    expect(await rows(conn, `SELECT count(*) FROM sample_method WHERE sample_id = ${ids.pantrap}`)).toEqual([[0n]]);
  });
});
