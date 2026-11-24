import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSampleMethods } from "../src/check-sample-methods.js";
import { migrate, MIGRATIONS_DIR, schemaDrift } from "../src/migrate.js";
import { duckdbReader } from "../src/person-change.js";
import { readSampleLog, recordSampleChanges } from "../src/sample-change.js";
import { setSampleMethodRow } from "../src/sample-method-row.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { promotedStore } from "./promoted-store.js";

/**
 * Stage three of beeline-ni5m.15: a sample's kind is its method's (trap where the method is a trap), kept so by the one
 * writer of the method row, corrected once by migration 0126, asserted by the nightly, and no longer logged.
 */

const kindOf = async (conn: Awaited<ReturnType<typeof createMemoryDb>>["conn"], id: number) =>
  (await rows(conn, `SELECT kind FROM sample WHERE entity_id = ${id}`))[0]![0];

describe("setSampleMethodRow sets the sample's kind from the method", () => {
  it("makes a trap method a trap sample and any other method a net sample, and leaves the dates alone", async () => {
    const { conn } = await createMemoryDb();
    await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector')`);
    const id = await insertCleanSample(conn, { protocol: "'aerial net'" });
    expect(await kindOf(conn, id)).toBe("net");
    await setSampleMethodRow(conn, id, "trap nest", null);
    expect(await kindOf(conn, id)).toBe("trap");
    await setSampleMethodRow(conn, id, "vane trap", 4);
    expect(await kindOf(conn, id)).toBe("trap");
    await setSampleMethodRow(conn, id, "vacuum", null);
    expect(await kindOf(conn, id)).toBe("net");
    const [[start, end]] = (await rows(conn, `SELECT CAST(date_start AS VARCHAR), CAST(date_end AS VARCHAR) FROM sample WHERE entity_id = ${id}`)) as [[string, string]];
    expect(end).toBe(start);
    expect(await rows(conn, `SELECT * FROM sample_kind_method_mismatch`)).toEqual([]);
  });
});

describe("migration 0126", () => {
  it("sets kind from the method for the samples that disagree, leaves one with no method and an agreeing one alone, and is a fresh build", async () => {
    const { conn } = await createMemoryDb();
    await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector')`);
    const ids: Record<string, number> = {};
    const cases: [string, string, string][] = [
      ["nest", "'trap nest'", "'net'"],
      ["pan", "'pan traps'", "'net'"],
      ["netted", "'aerial net'", "'trap'"],
      ["agrees", "'vane trap'", "'trap'"],
      ["none", "NULL", "'trap'"],
    ];
    for (const [i, [name, protocol, kind]] of cases.entries()) ids[name] = await insertCleanSample(conn, { sample_number: `'${i + 1}'`, protocol, kind });
    // The store as it was: kinds as the old rule gave them, whatever the methods say.
    for (const [name, kind] of [["nest", "net"], ["pan", "net"], ["netted", "trap"], ["agrees", "trap"], ["none", "trap"]] as const) {
      await conn.run(`UPDATE sample SET kind = '${kind}' WHERE entity_id = ${ids[name]}`);
    }
    expect((await rows(conn, `SELECT count(*) FROM sample_kind_method_mismatch`))[0]![0]).toBe(3n);
    const dir = await mkdtemp(join(tmpdir(), "migration-0126-"));
    await copyFile(join(MIGRATIONS_DIR, "0126-kind-follows-the-method.sql"), join(dir, "9999-under-test.sql"));
    expect(await migrate(conn, { dir })).toEqual(["9999-under-test.sql"]);
    expect(await kindOf(conn, ids.nest!)).toBe("trap");
    expect(await kindOf(conn, ids.pan!)).toBe("trap");
    expect(await kindOf(conn, ids.netted!)).toBe("net");
    expect(await kindOf(conn, ids.agrees!)).toBe("trap");
    expect(await kindOf(conn, ids.none!)).toBe("trap");
    expect(await rows(conn, `SELECT * FROM sample_kind_method_mismatch`)).toEqual([]);
    expect(await schemaDrift(conn)).toEqual([]);
  });
});

describe("the nightly's check", () => {
  it("fails on a kind that is not the method's, counts it as the clause kind and names no sample, and passes a sample with no method", async () => {
    const { conn } = await createMemoryDb();
    await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector')`);
    const id = await insertCleanSample(conn, { protocol: "'pan trap'", kind: "'trap'" });
    await insertCleanSample(conn, { sample_number: "'2'", protocol: "NULL", kind: "'trap'" });
    await checkSampleMethods(conn);
    await conn.run(`UPDATE sample SET kind = 'net' WHERE entity_id = ${id}`);
    await expect(checkSampleMethods(conn)).rejects.toThrow(/kind: 1/);
  });
});

describe("the sample change log does not log a change of kind", () => {
  it("restates the snapshot, does not re-baseline, logs nothing for kind, and still logs a change in another field", async () => {
    const { conn } = await createMemoryDb();
    await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector')`);
    const id = await insertCleanSample(conn, { protocol: "'trap nest'", kind: "'net'", locality: "'Corvallis'" });
    await conn.run("INSERT INTO schema_migration (name) VALUES ('0001-a-store-that-was-built.sql')");
    const dir = await mkdtemp(join(tmpdir(), "kind-log-"));
    const paths = { log: join(dir, "sample-change.csv"), state: join(dir, "sample-state.csv") };
    const reader = duckdbReader(conn);
    expect((await recordSampleChanges(reader, paths, { source: "reconcile" })).baselined).toBe(true);
    // The migration: kind follows the method, and meanwhile the locality changed.
    await conn.run(`UPDATE sample SET kind = 'trap', locality = 'Philomath' WHERE entity_id = ${id}`);
    const pass = await recordSampleChanges(reader, paths, { source: "reconcile" });
    expect(pass.baselined).toBe(false);
    const logged = (await readSampleLog(paths.log)).changes;
    expect(logged.map((c) => c.field)).toEqual(["locality"]);
    // A second pass finds the snapshot already says trap.
    expect((await recordSampleChanges(reader, paths, { source: "reconcile" })).appended).toBe(0);
  });
});

describe("promotion gives a sample from old records the kind of its method", { timeout: 120_000 }, () => {
  it("leaves no sample whose kind disagrees with its method, and makes a trap method a trap sample whatever its dates", async () => {
    const { conn } = await promotedStore("occurrences");
    expect(await rows(conn, `SELECT * FROM sample_kind_method_mismatch`)).toEqual([]);
    const byMethod = await rows(conn, `SELECT m.method_code, s.kind, count(*) FROM sample s JOIN sample_method m ON m.sample_id = s.entity_id GROUP BY ALL ORDER BY 1, 2`);
    for (const [method, kind] of byMethod as [string, string, bigint][]) {
      const [[trap]] = (await rows(conn, `SELECT is_trap FROM method WHERE code = '${method}'`)) as [[boolean]];
      expect(kind, method).toBe(trap ? "trap" : "net");
    }
    // No sample with no method is a trap: a text method_text does not list gives net.
    expect(await rows(conn, `SELECT count(*) FROM sample s WHERE s.kind = 'trap' AND NOT EXISTS (SELECT 1 FROM sample_method m WHERE m.sample_id = s.entity_id)`)).toEqual([[0n]]);
  });
});
