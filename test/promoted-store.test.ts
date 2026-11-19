import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { createMemoryDb as buildFromSchema } from "../src/schema.js";
import { openCopy, PROMOTED_STORES, promotedStore, writeCopy } from "./promoted-store.js";
import { storeContents } from "./store-template.js";

describe("a copy of a promoted store", () => {
  test("holds everything the store it was copied from held, down to the next entity id", async () => {
    // Compared with the store it was copied from, not with a second
    // promotion: promotion hands out entity ids in no fixed order, so two
    // promotions of one fixture number their specimens differently.
    const { staging, inputs } = PROMOTED_STORES.corrected;
    const { conn: promoted } = await buildFromSchema();
    await loadLegacyStaging(promoted, staging);
    await promoteLegacy(promoted, inputs);
    const file = join(await mkdtemp(join(tmpdir(), "beeline-promoted-")), "copy.duckdb");
    await writeCopy(promoted, file);
    const { conn: copied } = await openCopy(file);
    const [want, got] = [await storeContents(promoted, { viewText: false }), await storeContents(copied, { viewText: false })];
    // The animal tree is the one table copied a level at a time: say so if it ever has nothing to copy.
    expect(want.rows.animal).not.toBe("[]");
    expect(Object.keys(got.rows)).toEqual(Object.keys(want.rows));
    for (const name of Object.keys(want.rows)) expect(got.rows[name], name).toBe(want.rows[name]);
    expect(got).toEqual(want);
    // A promotion, a copy and two readings of every table: 14 to 18 s alone
    // on Hostess, and past the default 30 s in a full run on a busy machine.
  }, 60_000);

  test("is a store of the test's own, which another copy does not see", async () => {
    const { conn: one } = await promotedStore("occurrences");
    const { conn: two } = await promotedStore("occurrences");
    await one.run(`INSERT INTO person (display_name) VALUES ('Only In One')`);
    const count = async (conn: DuckDBConnection) =>
      (await conn.runAndReadAll(`SELECT count(*) FROM person WHERE display_name = 'Only In One'`)).getRows();
    expect(await count(one)).toEqual([[1n]]);
    expect(await count(two)).toEqual([[0n]]);
  });

  test("creates the test's corrections file, and refuses one that already holds corrections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beeline-promoted-"));
    const path = join(dir, "corrections.csv");
    await promotedStore("occurrences", { appCorrections: path });
    expect(await readFile(path, "utf8")).toBe("_id,field,base_value,new_value,author,reason\n");
    await writeFile(path, "_id,field,base_value,new_value,author,reason\nbbbb2222,locality,a,b,someone,why\n");
    await expect(promotedStore("occurrences", { appCorrections: path })).rejects.toThrow(/already holds corrections/);
  });
});
