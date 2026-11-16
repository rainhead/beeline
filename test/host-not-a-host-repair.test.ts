import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { MIGRATIONS_DIR } from "../src/migrate.js";

/**
 * The repair in migrations/0097-homo-sapiens-is-no-host.sql (beeline-rfkj.11):
 * a stored host that is a taxon meaning no host (Homo sapiens, a user's flag
 * on iNaturalist) is cleared. The migration's DDL is the schema's, which a
 * fresh store already has, so only its UPDATE is run here; the whole file was
 * applied to a copy of production's store of 2026-11-15, where it cleared 47
 * samples and `db:migrate --check` then matched schema/*.sql.
 */
describe("migration 0097's repair", () => {
  test("clears a Homo sapiens host, by id or by name, leaves every other host alone, and does so once", async () => {
    const { conn } = await createMemoryDb();
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    const sample = async (n: string, id: string, name: string, rank: string) =>
      insertCleanSample(conn, { sample_number: `'${n}'`, host_inat_taxon_id: id, host_name_as_observed: name, host_rank: rank });
    // The shapes production holds: 46 settled samples with the id (34 printed), one of 2026 with the name alone.
    const byId = await sample("1", "43584", "'Homo sapiens'", "'species'");
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${byId}, 1)`);
    const byName = await sample("2", "NULL", "'Homo sapiens'", "'species'");
    const plant = await sample("3", "47604", "'Rubus'", "'genus'");
    // The bee identified as the observation's subject is a mistake for the QC rule to catch, not a flag.
    const bee = await sample("4", "57669", "'Andrena'", "'genus'");
    // A plant named with no id is left as it is: only the flag's own name is cleared.
    const plantName = await sample("5", "NULL", "'Rubus'", "'genus'");

    const migration = await readFile(`${MIGRATIONS_DIR}0097-homo-sapiens-is-no-host.sql`, "utf8");
    const repair = migration.slice(migration.indexOf("UPDATE sample SET host_inat_taxon_id = NULL"));
    expect(repair).toMatch(/^UPDATE sample/);
    const hosts = () => rows(conn, "SELECT entity_id, host_inat_taxon_id, host_name_as_observed, host_rank FROM sample ORDER BY 1");

    await conn.run(repair);
    const after = await hosts();
    expect(after).toEqual([
      [byId, null, null, null],
      [byName, null, null, null],
      [plant, 47604n, "Rubus", "genus"],
      [bee, 57669n, "Andrena", "genus"],
      [plantName, null, "Rubus", "genus"],
    ]);
    await conn.run(repair);
    expect(await hosts()).toEqual(after);
  });
});
