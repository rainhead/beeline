import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQueryCopy, QueryCopyError, type QueryCopy } from "../src/query-copy.js";
import { keepQueryCopy } from "../src/store-backup.js";
import { snapshotCatalog } from "../src/store-snapshot.js";
import { createFileDb } from "./helpers.js";

/**
 * A live store from the real schema, a snapshot of it taken the way the nightly
 * backup takes one, and a query runner on the snapshot. The folder is the run's
 * temporary one (test/global-setup.ts), removed when the run ends.
 */
let live: DuckDBInstance;
let liveConn: DuckDBConnection;
let dir: string;
let copyPath: string;
let queries: QueryCopy;

const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

const refused = async (sql: string) => {
  const err = await queries.run(sql).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `${sql} should have been refused`).toBeInstanceOf(QueryCopyError);
  return err as QueryCopyError;
};

beforeAll(async () => {
  const db = await createFileDb();
  live = db.instance;
  liveConn = await live.connect();
  await liveConn.run(`INSERT INTO animal (entity_id, parent_id, rank, scientific_name) VALUES (900, NULL, 'family', 'Apidae')`);
  await liveConn.run(`INSERT INTO animal (entity_id, parent_id, rank, scientific_name) VALUES (800, 900, 'genus', 'Bombus')`);
  await liveConn.run(`INSERT INTO person (display_name) VALUES ('A. Collector')`);
  dir = await mkdtemp(join(tmpdir(), "beeline-query-copy-"));
  copyPath = join(dir, "query-copy.duckdb");
  await snapshotCatalog(liveConn, db.catalog, copyPath, null);
  queries = createQueryCopy({ path: copyPath });
});

afterAll(() => {
  queries.close();
  liveConn.closeSync();
  live.closeSync();
});

describe("a query against the copy", () => {
  it("returns column names, column types and rows from the real schema", async () => {
    const r = await queries.run("SELECT scientific_name, parent_id FROM animal ORDER BY entity_id");
    expect(r.columns).toEqual([
      { name: "scientific_name", type: "VARCHAR" },
      { name: "parent_id", type: expect.stringMatching(/INT/) },
    ]);
    expect(r.rows).toEqual([
      ["Bombus", 900],
      ["Apidae", null],
    ]);
    expect(r.truncated).toBe(false);
    expect(r.limits).toEqual({ timeoutMs: 10_000, maxRows: 5_000 });
  });

  it("allows EXPLAIN, DESCRIBE, a bare FROM and a WITH that only reads", async () => {
    expect((await queries.run("EXPLAIN SELECT 1")).rows.length).toBeGreaterThan(0);
    expect((await queries.run("DESCRIBE animal")).rows.length).toBeGreaterThan(3);
    expect((await queries.run("FROM animal")).rows).toHaveLength(2);
    expect((await queries.run("WITH a AS (SELECT 1 AS x) SELECT x FROM a")).rows).toEqual([[1]]);
  });

  it("is the copy and not the live store that it reads", async () => {
    await liveConn.run(`INSERT INTO person (display_name) VALUES ('Added after the copy')`);
    const r = await queries.run("SELECT count(*) FROM person");
    expect(r.rows).toEqual([[1]]);
  });
});

describe("the values it returns", () => {
  const types = `
    SELECT 1::BIGINT AS small_bigint, 9007199254740993::BIGINT AS big_bigint, -9007199254740993::BIGINT AS big_negative,
           170141183460469231731687303715884105727::HUGEINT AS hugeint, 5::HUGEINT AS small_hugeint,
           18446744073709551615::UBIGINT AS ubigint,
           12.50::DECIMAL(10,2) AS narrow_decimal, 123456789012345678901234567890.12::DECIMAL(38,2) AS wide_decimal,
           1.5::DOUBLE AS dbl, 'NaN'::DOUBLE AS nan, 'inf'::DOUBLE AS inf,
           DATE '2026-03-01' AS dt, TIMESTAMP '2026-03-01 12:34:56' AS ts, TIMESTAMP '2026-03-01 12:34:56.789012' AS ts_micros,
           TIMESTAMPTZ '2026-03-01 04:34:56-08' AS tstz, TIMESTAMP 'infinity' AS ts_inf,
           [1, 2, 3] AS lst, {'a': 1, 'b': [DATE '2026-03-01']} AS st, MAP {'k': 10000000000000000000::HUGEINT} AS mp,
           '\\xDE\\xAD'::BLOB AS blob, 'text' AS txt, TIME '12:00:00' AS tm, NULL AS nothing`;

  it("are all ones JSON can carry, by one stated rule", async () => {
    const r = await queries.run(types);
    const row = Object.fromEntries(r.columns.map((c, i) => [c.name, r.rows[0]![i]]));
    expect(row).toEqual({
      small_bigint: 1,
      big_bigint: "9007199254740993",
      big_negative: "-9007199254740993",
      hugeint: "170141183460469231731687303715884105727",
      small_hugeint: 5,
      ubigint: "18446744073709551615",
      narrow_decimal: 12.5,
      wide_decimal: "123456789012345678901234567890.12",
      dbl: 1.5,
      nan: "NaN",
      inf: "Infinity",
      dt: "2026-03-01",
      ts: "2026-03-01T12:34:56Z",
      ts_micros: "2026-03-01T12:34:56.789012Z",
      tstz: "2026-03-01T12:34:56Z",
      ts_inf: "infinity",
      lst: [1, 2, 3],
      st: { a: 1, b: ["2026-03-01"] },
      mp: [{ key: "k", value: "10000000000000000000" }],
      blob: "dead",
      txt: "text",
      tm: "12:00:00",
      nothing: null,
    });
    // And it really is JSON: nothing is a bigint, which JSON.stringify would throw on.
    expect(JSON.parse(JSON.stringify(r.rows))).toEqual(r.rows);
  });

  it("writes a TIMESTAMPTZ in UTC whatever zone the machine is in", async () => {
    const r = await queries.run("SELECT current_setting('TimeZone'), TIMESTAMPTZ '2026-07-01 00:00:00+09'");
    expect(r.rows).toEqual([["UTC", "2026-06-30T15:00:00Z"]]);
  });
});

describe("what it refuses", () => {
  it("more than one statement, counted by the database and not by semicolons", async () => {
    expect((await refused("SELECT 1; SELECT 2")).code).toBe("not-one-statement");
    expect((await refused("SELECT 1; DROP TABLE animal")).code).toBe("not-one-statement");
    // A semicolon inside a string or a comment is not a second statement.
    expect((await queries.run("SELECT 'a;b' AS x -- ; SELECT 2")).rows).toEqual([["a;b"]]);
    expect((await queries.run("SELECT 1;")).rows).toEqual([[1]]);
  });

  it("an empty query, and a query that is not SQL, with the database's own message", async () => {
    expect((await refused("")).code).toBe("empty");
    expect((await refused("  -- nothing\n")).code).toBe("empty");
    const err = await refused("SELEKT 1");
    expect(err.code).toBe("sql");
    expect(err.message).toMatch(/syntax error/i);
  });

  it("everything that writes, loads, attaches, sets or reads a file, leaving the copy and its sequence as they were", async () => {
    const before = await sha256(copyPath);
    const seq = "SELECT last_value FROM duckdb_sequences() WHERE sequence_name = 'entity_id_seq'";
    const seqBefore = (await queries.run(seq)).rows;
    const liveSeq = async () => (await (await liveConn.run(seq)).getRows())[0]![0];
    const liveSeqBefore = await liveSeq();
    const outside = join(dir, "written-by-copy-to.csv");

    // Stopped before it runs, by kind.
    const byKind: [string, string][] = [
      ["CREATE TABLE z (a INTEGER)", "CREATE"],
      ["CREATE TEMP TABLE z AS SELECT 1", "CREATE"],
      ["INSERT INTO person (display_name) VALUES ('x')", "INSERT"],
      ["UPDATE animal SET rank = 'x'", "UPDATE"],
      ["DELETE FROM animal", "DELETE"],
      ["DROP TABLE animal", "DROP"],
      ["ATTACH ':memory:' AS m", "ATTACH"],
      ["INSTALL httpfs", "LOAD"],
      ["LOAD json", "LOAD"],
      ["SET memory_limit = '4GB'", "SET"],
      ["SET enable_external_access = true", "SET"],
      ["PRAGMA memory_limit = '4GB'", "SET"],
      ["CALL pragma_version()", "CALL"],
      ["CHECKPOINT", "CALL"],
    ];
    for (const [sql, kind] of byKind) {
      const err = await refused(sql);
      expect(err.code, sql).toBe("not-allowed");
      expect(err.message, sql).toContain(kind);
    }

    // Typed SELECT, so passed on to the database, which refuses them itself.
    const byInstance: [string, RegExp][] = [
      ["SELECT nextval('entity_id_seq')", /read-only/],
      ["SELECT nextval('entity_id_seq') FROM range(5)", /read-only/],
      ["WITH d AS (UPDATE animal SET rank = 'x' RETURNING entity_id) SELECT * FROM d", /read-only/],
      ["WITH d AS (INSERT INTO person (display_name) VALUES ('x') RETURNING entity_id) SELECT * FROM d", /read-only/],
      ["WITH d AS (DELETE FROM animal RETURNING entity_id) SELECT * FROM d", /read-only/],
      ["SELECT * FROM read_text('/etc/passwd')", /disabled by config/],
      ["SELECT * FROM read_csv('/etc/hostname')", /disabled by config/],
      ["SELECT * FROM glob('/etc/*')", /disabled by config/],
      [`COPY (SELECT 1) TO '${outside}'`, /disabled by config/],
      [`SELECT * FROM '${copyPath}'`, /./],
    ];
    for (const [sql, message] of byInstance) {
      const err = await refused(sql);
      expect(err.code, sql).toBe("sql");
      expect(err.message, sql).toMatch(message);
    }

    expect(await sha256(copyPath)).toBe(before);
    expect((await queries.run(seq)).rows).toEqual(seqBefore);
    expect((await queries.run("SELECT count(*) FROM animal")).rows).toEqual([[2]]);
    expect((await readdir(dir)).sort()).not.toContain("written-by-copy-to.csv");
    // Nor was the live store's sequence touched.
    expect(await liveSeq()).toBe(liveSeqBefore);
  });
});

describe("time, rows and one at a time", () => {
  const slow = "SELECT count(*) FROM range(100000000000)";

  it("stops a query at its time limit, and the next query works", async () => {
    const started = Date.now();
    const err = await queries.run(slow, { timeoutMs: 300 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryCopyError);
    expect((err as QueryCopyError).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await queries.run("SELECT 1")).rows).toEqual([[1]]);
  });

  it("cuts a result short at the row cap without reading the rest", async () => {
    const started = Date.now();
    const r = await queries.run("SELECT * FROM range(1000000000000)", { maxRows: 7 });
    expect(r.rows.map((row) => row[0])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    // A result of exactly the cap is not cut short; one more row is.
    expect((await queries.run("SELECT * FROM range(7)", { maxRows: 7 })).truncated).toBe(false);
    expect((await queries.run("SELECT * FROM range(8)", { maxRows: 7 })).truncated).toBe(true);
    // The default cap is 5,000 rows.
    const big = await queries.run("SELECT * FROM range(6000)");
    expect(big.rows).toHaveLength(5_000);
    expect(big.truncated).toBe(true);
  });

  it("refuses a second query while one runs, and takes the next once it has finished", async () => {
    const first = queries.run(slow, { timeoutMs: 1_000 }).catch((e: unknown) => e);
    const second = await queries.run("SELECT 1").catch((e: unknown) => e);
    expect(second).toBeInstanceOf(QueryCopyError);
    expect((second as QueryCopyError).code).toBe("busy");
    expect(((await first) as QueryCopyError).code).toBe("timeout");
    expect((await queries.run("SELECT 1")).rows).toEqual([[1]]);
  });
});

describe("the copy file", () => {
  it("is a named error when it is missing, and works once it appears", async () => {
    const own = await mkdtemp(join(tmpdir(), "beeline-query-copy-"));
    const path = join(own, "query-copy.duckdb");
    const q = createQueryCopy({ path });
    const err = await q.run("SELECT 1").catch((e: unknown) => e);
    expect((err as QueryCopyError).code).toBe("no-copy");
    await keepQueryCopy(copyPath, path);
    expect((await q.run("SELECT count(*) FROM animal")).rows).toEqual([[2]]);
    q.close();
  });

  it("is reopened when the backup replaces it, and the old instance is closed", async () => {
    const own = await mkdtemp(join(tmpdir(), "beeline-query-copy-"));
    const path = join(own, "query-copy.duckdb");
    await keepQueryCopy(copyPath, path);
    const q = createQueryCopy({ path });
    expect((await q.run("SELECT count(*) FROM person")).rows).toEqual([[1]]);

    // Tonight's copy has one more person; it arrives by rename, as the job does it.
    const night2 = join(own, "night2.duckdb");
    const db = await createFileDb();
    const conn = await db.instance.connect();
    await conn.run(`INSERT INTO person (display_name) VALUES ('P1'), ('P2')`);
    await snapshotCatalog(conn, db.catalog, night2, null);
    conn.closeSync();
    db.instance.closeSync();
    await keepQueryCopy(night2, path);
    expect((await q.run("SELECT count(*) FROM person")).rows).toEqual([[2]]);

    // Deleted, it is missing again rather than served from the old instance.
    await rm(path);
    expect(((await q.run("SELECT 1").catch((e: unknown) => e)) as QueryCopyError).code).toBe("no-copy");
    q.close();
  });

  it("is not left broken by a replacement that is not a database", async () => {
    const own = await mkdtemp(join(tmpdir(), "beeline-query-copy-"));
    const path = join(own, "query-copy.duckdb");
    await keepQueryCopy(copyPath, path);
    const q = createQueryCopy({ path });
    await q.run("SELECT 1");
    await writeFile(join(own, "other"), "x");
    await rename(join(own, "other"), path);
    // The replacement is not a database, so reopening says so as an ordinary error; the module is not left broken.
    const err = (await q.run("SELECT 1").catch((e: unknown) => e)) as QueryCopyError;
    expect(err).toBeInstanceOf(Error);
    await keepQueryCopy(copyPath, path);
    expect((await q.run("SELECT count(*) FROM animal")).rows).toEqual([[2]]);
    q.close();
  });
});

describe("a query that needs more memory than its limit", () => {
  it("fails with an ordinary error, writes nothing beside the copy, and harms neither instance", async () => {
    const own = await mkdtemp(join(tmpdir(), "beeline-query-copy-"));
    const path = join(own, "query-copy.duckdb");
    await keepQueryCopy(copyPath, path);
    const small = createQueryCopy({ path, memoryLimit: "64MB" });
    const filesBefore = (await readdir(own)).sort();
    const err = (await small
      .run("SELECT sum(length(m)) FROM (SELECT repeat(md5(range::varchar), 4) m, random() k FROM range(3000000) ORDER BY k)", {
        timeoutMs: 60_000,
      })
      .catch((e: unknown) => e)) as QueryCopyError;
    expect(err).toBeInstanceOf(QueryCopyError);
    expect(err.code).toBe("sql");
    expect(err.message).toMatch(/temp|memory|director/i);
    // Nothing was spilled beside the copy, where the volume is the live store's.
    expect((await readdir(own)).sort()).toEqual(filesBefore);
    // The instance goes on answering, and so does the live store.
    expect((await small.run("SELECT count(*) FROM animal")).rows).toEqual([[2]]);
    await liveConn.run(`INSERT INTO person (display_name) VALUES ('Still writing')`);
    small.close();
  });
});
