import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkRegistryMark,
  raiseRegistryMark,
  readRegistryMark,
  RegistryShrankRefused,
  UnreadableMarkRefused,
} from "../src/registry-mark.js";
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

/** A store holding `runs` print runs, the first of them minting `numbers` field numbers from base + 1. */
async function storeWith(runs: number, numbers: number, base = 26000000) {
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
    await conn.run(`INSERT INTO minted_field_number (field_number, print_run_id) VALUES ('${base + i}', ${runIds[0]})`);
  }
  return conn;
}

describe("the registry mark", () => {
  it("is started by the first boot, from what the store holds", async () => {
    const path = await markPath();
    const conn = await storeWith(2, 5);
    const { store, before } = await checkRegistryMark(conn, "memory", path);
    expect(before).toBeNull();
    expect(store).toEqual({ print_run: 2, minted_field_number: 5, highest_field_number: 26000005 });
    expect(await readRegistryMark(path)).toEqual({ print_run: 2, minted_field_number: 5, highest_field_number: 26000005 });
  });

  it("refuses a store that holds fewer minted numbers or runs than the mark, and leaves the mark alone", async () => {
    const path = await markPath();
    await writeFile(path, JSON.stringify({ print_run: 2, minted_field_number: 5, highest_field_number: 26000005 }));
    const rebuilt = await storeWith(2, 3);
    const refusal = checkRegistryMark(rebuilt, "memory", path);
    await expect(refusal).rejects.toBeInstanceOf(RegistryShrankRefused);
    await expect(refusal).rejects.toThrow(
      /holds 2 print run\(s\) and 3 minted field number\(s\), the highest 26000003, and this deployment has held 2 print run\(s\) and 5/,
    );
    const fewerRuns = await storeWith(1, 5);
    await expect(checkRegistryMark(fewerRuns, "memory", path)).rejects.toBeInstanceOf(RegistryShrankRefused);
    // A store built from scratch has none at all.
    await expect(checkRegistryMark(await storeWith(0, 0), "memory", path)).rejects.toBeInstanceOf(RegistryShrankRefused);
    expect(await readRegistryMark(path)).toEqual({ print_run: 2, minted_field_number: 5, highest_field_number: 26000005 });
  });

  it("serves a store that holds as many or more, and raises the mark to it", async () => {
    const path = await markPath();
    await writeFile(path, JSON.stringify({ print_run: 1, minted_field_number: 4, highest_field_number: 26000004 }));
    await checkRegistryMark(await storeWith(1, 4), "memory", path);
    expect(await readRegistryMark(path)).toEqual({ print_run: 1, minted_field_number: 4, highest_field_number: 26000004 });
    await checkRegistryMark(await storeWith(3, 9), "memory", path);
    expect(await readRegistryMark(path)).toEqual({ print_run: 3, minted_field_number: 9, highest_field_number: 26000009 });
  });

  it("is never lowered by a raise", async () => {
    const path = await markPath();
    await writeFile(path, JSON.stringify({ print_run: 4, minted_field_number: 2, highest_field_number: 26000002 }));
    expect(await raiseRegistryMark(await storeWith(1, 7), "memory", path)).toEqual({ print_run: 4, minted_field_number: 7, highest_field_number: 26000007 });
  });

  it("refuses a mark it cannot read rather than treating it as none, naming the file", async () => {
    const path = await markPath();
    for (const text of [`{"print_run": "lots"}`, "", `{"print_run": 1, "minted`, "null"]) {
      await writeFile(path, text);
      const refusal = checkRegistryMark(await storeWith(0, 0), "memory", path);
      await expect(refusal).rejects.toBeInstanceOf(UnreadableMarkRefused);
      await expect(refusal).rejects.toThrow(path);
      expect(await readFile(path, "utf8")).toBe(text);
    }
  });
});
