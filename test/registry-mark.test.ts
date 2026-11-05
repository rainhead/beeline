import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRegistryMark, raiseRegistryMark, readRegistryMark, RegistryShrankRefused } from "../src/registry-mark.js";
import { createMemoryDb, rows } from "./helpers.js";

/**
 * beeline-l3w7: a store moved over the live one brings its own registry, so
 * only a record kept outside the store can tell that the new one holds fewer
 * minted field numbers than the deployment has seen.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function markPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "beeline-mark-"));
  dirs.push(dir);
  return join(dir, "registry-mark.json");
}

/** A store holding `runs` print runs, the first of them minting `numbers` field numbers. */
async function storeWith(runs: number, numbers: number) {
  const { conn } = await createMemoryDb();
  const [[person]] = (await rows(
    conn,
    `INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`,
  )) as [[number]];
  const runIds: number[] = [];
  for (let i = 0; i < runs; i++) {
    const [[id]] = (await rows(
      conn,
      `INSERT INTO print_run (prepared_by) VALUES (${person}) RETURNING entity_id`,
    )) as [[number]];
    runIds.push(id);
  }
  for (let i = 1; i <= numbers; i++) {
    await conn.run(`INSERT INTO minted_field_number (field_number, print_run_id) VALUES ('${26000000 + i}', ${runIds[0]})`);
  }
  return conn;
}

describe("the registry mark", () => {
  it("is started by the first boot, from what the store holds", async () => {
    const path = await markPath();
    const conn = await storeWith(2, 5);
    const { store, before } = await checkRegistryMark(conn, "memory", path);
    expect(before).toBeNull();
    expect(store).toEqual({ print_run: 2, minted_field_number: 5 });
    expect(await readRegistryMark(path)).toEqual({ print_run: 2, minted_field_number: 5 });
  });

  it("refuses a store that holds fewer minted numbers or runs than the mark, and leaves the mark alone", async () => {
    const path = await markPath();
    await writeFile(path, JSON.stringify({ print_run: 2, minted_field_number: 5 }));
    const rebuilt = await storeWith(2, 3);
    const refusal = checkRegistryMark(rebuilt, "memory", path);
    await expect(refusal).rejects.toBeInstanceOf(RegistryShrankRefused);
    await expect(refusal).rejects.toThrow(/holds 2 print run\(s\) and 3 minted field number\(s\).*held 2 and 5/);
    const fewerRuns = await storeWith(1, 5);
    await expect(checkRegistryMark(fewerRuns, "memory", path)).rejects.toBeInstanceOf(RegistryShrankRefused);
    // A store built from scratch has none at all.
    await expect(checkRegistryMark(await storeWith(0, 0), "memory", path)).rejects.toBeInstanceOf(RegistryShrankRefused);
    expect(await readRegistryMark(path)).toEqual({ print_run: 2, minted_field_number: 5 });
  });

  it("serves a store that holds as many or more, and raises the mark to it", async () => {
    const path = await markPath();
    await writeFile(path, JSON.stringify({ print_run: 1, minted_field_number: 4 }));
    await checkRegistryMark(await storeWith(1, 4), "memory", path);
    expect(await readRegistryMark(path)).toEqual({ print_run: 1, minted_field_number: 4 });
    await checkRegistryMark(await storeWith(3, 9), "memory", path);
    expect(await readRegistryMark(path)).toEqual({ print_run: 3, minted_field_number: 9 });
  });

  it("is never lowered by a raise", async () => {
    const path = await markPath();
    await writeFile(path, JSON.stringify({ print_run: 4, minted_field_number: 2 }));
    expect(await raiseRegistryMark(await storeWith(1, 7), "memory", path)).toEqual({
      print_run: 4,
      minted_field_number: 7,
    });
  });

  it("throws on a mark it cannot read rather than treating it as none", async () => {
    const path = await markPath();
    await writeFile(path, `{"print_run": "lots"}`);
    await expect(checkRegistryMark(await storeWith(0, 0), "memory", path)).rejects.toThrow(/not a registry mark/);
    expect(await readFile(path, "utf8")).toBe(`{"print_run": "lots"}`);
  });
});
