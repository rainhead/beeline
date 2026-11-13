import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFromEnv, DEFAULT_QUERY_COPY_PATH } from "../src/app/config.js";
import {
  createQueryCopy,
  QueryCopyError,
  queryCopyConflict,
  workerEnvironment,
  type QueryCopy,
} from "../src/query-copy.js";
import { executeQuery, type WorkerReply, type WorkerRequest } from "../src/query-copy-worker.js";
import { keepQueryCopy } from "../src/store-backup.js";
import { snapshotCatalog } from "../src/store-snapshot.js";
import { createFileDb } from "./helpers.js";

/**
 * A live store from the real schema, a snapshot of it put in place the way the
 * nightly backup puts one (a folder of its own, read-only), and runners on it.
 * Folders are the run's temporary ones (test/global-setup.ts), which can only be
 * removed once the read-only ones are opened up again.
 */
let live: DuckDBInstance;
let liveConn: DuckDBConnection;
let dir: string;
let copyPath: string;
let queries: QueryCopy;
const readOnlyFolders: string[] = [];
const isRoot = process.getuid?.() === 0;

const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

/** A folder of the run's own, with a copy of the store kept in it the way the backup keeps one. */
async function keptCopy(name = "query-copy.duckdb"): Promise<string> {
  const own = await mkdtemp(join(tmpdir(), "beeline-query-copy-"));
  const path = join(own, "query-copy", name);
  await keepQueryCopy(sourceSnapshot, path);
  readOnlyFolders.push(join(own, "query-copy"));
  return path;
}

let sourceSnapshot: string;

const request = (sql: string, over: Partial<WorkerRequest> = {}): WorkerRequest => ({
  path: copyPath,
  memoryLimit: "256MB",
  sql,
  explain: false,
  maxRows: 5_000,
  maxBytes: 5_000_000,
  maxCellBytes: 1_000_000,
  ...over,
});

/** Run in this process, as the child would, optionally with the kind check got past. */
const exec = (sql: string, over: Partial<WorkerRequest> = {}, bypassKindCheck = false) =>
  executeQuery(request(sql, over), { bypassKindCheck });

const okRows = async (sql: string, over: Partial<WorkerRequest> = {}) => {
  const reply = await exec(sql, over);
  if (!reply.ok) throw new Error(`${sql}: ${reply.code}: ${reply.message}`);
  return reply;
};

const failure = (reply: WorkerReply) => {
  expect(reply.ok, JSON.stringify(reply).slice(0, 300)).toBe(false);
  return reply as Extract<WorkerReply, { ok: false }>;
};

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
  sourceSnapshot = join(dir, "snapshot.duckdb");
  await snapshotCatalog(liveConn, db.catalog, sourceSnapshot, null);
  copyPath = join(dir, "query-copy", "query-copy.duckdb");
  await keepQueryCopy(sourceSnapshot, copyPath);
  readOnlyFolders.push(join(dir, "query-copy"));
  queries = createQueryCopy({ path: copyPath });
});

afterAll(async () => {
  for (const folder of readOnlyFolders) await chmod(folder, 0o700).catch(() => undefined);
  liveConn.closeSync();
  live.closeSync();
});

describe("a query against the copy, through a child process", () => {
  it("returns column names, types, rows and when the copy was made", async () => {
    const started = Date.now();
    const r = await queries.run("SELECT scientific_name, parent_id FROM animal ORDER BY entity_id");
    const trivialMs = Date.now() - started;
    expect(r.columns).toEqual([
      { name: "scientific_name", type: "VARCHAR" },
      { name: "parent_id", type: expect.stringMatching(/INT/) },
    ]);
    expect(r.rows).toEqual([
      ["Bombus", 900],
      ["Apidae", null],
    ]);
    expect(r.truncated).toBe(false);
    expect(r.truncatedBy).toBeNull();
    expect(r.limits).toEqual({ timeoutMs: 10_000, maxRows: 5_000, maxBytes: 5_000_000 });
    expect(r.copiedAt).toBe((await stat(copyPath)).mtime.toISOString());
    // A process per query costs a start-up; a lookup tool can pay it.
    expect(trivialMs).toBeLessThan(8_000);
  });

  it("answers DESCRIBE, a bare FROM, a read-only WITH, and a PIVOT with its columns listed", async () => {
    expect((await queries.run("DESCRIBE animal")).rows.length).toBeGreaterThan(3);
    expect((await queries.run("FROM animal")).rows).toHaveLength(2);
    expect((await queries.run("WITH a AS (SELECT 1 AS x) SELECT x FROM a")).rows).toEqual([[1]]);
    // A PIVOT that names its columns is typed SELECT and only reads; one that does not
    // is several statements (it looks the columns up first) and is refused.
    expect((await queries.run("PIVOT (SELECT 1 a, 'x' b, 5 c) ON b IN ('x', 'y') USING sum(c)")).rows).toEqual([[1, 5, null]]);
    expect((await refused("PIVOT (SELECT 1 a, 'x' b, 5 c) ON b USING sum(c)")).code).toBe("not-allowed");
  });

  it("is the copy and not the live store that it reads", async () => {
    await liveConn.run(`INSERT INTO person (display_name) VALUES ('Added after the copy')`);
    expect((await queries.run("SELECT count(*) FROM person")).rows).toEqual([[1]]);
  });

  it("answers with the plan when asked, and never runs the statement to do it", async () => {
    const plan = await queries.run("SELECT * FROM animal", { explain: true });
    expect(plan.columns.map((c) => c.name)).toEqual(["explain_key", "explain_value"]);
    expect(String(plan.rows[0]![1])).toMatch(/SEQ_SCAN|animal/i);
    // The prefix is ours, so what the caller typed must still be one SELECT.
    const copy = (await queries.run(`COPY (SELECT 1) TO '${copyPath}'`, { explain: true }).catch((e: unknown) => e)) as QueryCopyError;
    expect(copy.code).toBe("not-allowed");
    expect(copy.message).toContain("COPY");
    expect(((await queries.run("SELECT 1; SELECT 2", { explain: true }).catch((e: unknown) => e)) as QueryCopyError).code).toBe(
      "not-one-statement",
    );
    // A caller cannot ask for ANALYZE by typing it: it is a statement of its own kind.
    expect((await refused("EXPLAIN ANALYZE SELECT 1")).code).toBe("not-allowed");
  });
});

describe("the values it returns", () => {
  const types = `
    SELECT 1::BIGINT AS small_bigint, 9007199254740993::BIGINT AS big_bigint, -9007199254740993::BIGINT AS big_negative,
           170141183460469231731687303715884105727::HUGEINT AS hugeint, 5::HUGEINT AS small_hugeint,
           18446744073709551615::UBIGINT AS ubigint,
           12.50::DECIMAL(10,2) AS narrow_decimal, 123456789012345678901234567890.12::DECIMAL(38,2) AS wide_decimal,
           1.5::DOUBLE AS dbl, 'NaN'::DOUBLE AS nan, 'inf'::DOUBLE AS inf,
           DATE '2026-03-01' AS dt, DATE 'infinity' AS dt_inf, DATE '-infinity' AS dt_neg_inf,
           TIMESTAMP '2026-03-01 12:34:56' AS ts, TIMESTAMP '2026-03-01 12:34:56.789012' AS ts_micros,
           TIMESTAMPTZ '2026-03-01 04:34:56-08' AS tstz, TIMESTAMP 'infinity' AS ts_inf,
           TIMESTAMPTZ 'infinity' AS tstz_inf, TIMESTAMPTZ '-infinity' AS tstz_neg_inf,
           TIMESTAMPTZ '9000-01-01 00:00:00+00' AS tstz_far, TIMESTAMPTZ '0044-03-15 (BC) 12:00:00+00' AS tstz_bc,
           TIMESTAMP '0044-03-15 (BC) 12:34:56' AS ts_bc,
           [1, 2, 3] AS lst, {'a': 1, 'b': [DATE '2026-03-01']} AS st, MAP {'k': 10000000000000000000::HUGEINT} AS mp,
           '\\xDE\\xAD'::BLOB AS blob, 'text' AS txt, TIME '12:00:00' AS tm, NULL AS nothing`;

  it("are all ones JSON can carry, by one stated rule", async () => {
    const r = await okRows(types);
    const row = Object.fromEntries(r.columns.map((c, i) => [c.name, r.rows[0]![i]]));
    expect(row).toMatchObject({
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
      dt_inf: "infinity",
      dt_neg_inf: "-infinity",
      ts: "2026-03-01T12:34:56Z",
      ts_micros: "2026-03-01T12:34:56.789012Z",
      tstz: "2026-03-01T12:34:56Z",
      ts_inf: "infinity",
      tstz_inf: "infinity",
      tstz_neg_inf: "-infinity",
      tstz_far: "9000-01-01T00:00:00Z",
      lst: [1, 2, 3],
      st: { a: 1, b: ["2026-03-01"] },
      mp: [{ key: "k", value: "10000000000000000000" }],
      blob: "dead",
      txt: "text",
      tm: "12:00:00",
      nothing: null,
    });
    // BC years are DuckDB's own UTC text, whole: not cut at nineteen characters, not a nonsense date.
    expect(String(row.tstz_bc)).toMatch(/0044.*BC.*12:00:00/);
    expect(String(row.ts_bc)).toMatch(/0044.*BC.*12:34:56/);
    expect(JSON.parse(JSON.stringify(r.rows))).toEqual(r.rows);
  });

  it("keeps a struct field named __proto__", async () => {
    const r = await okRows("SELECT {'__proto__': 1, 'a': 2} AS s, [{'__proto__': 'x'}] AS l");
    const [struct, list] = r.rows[0] as [Record<string, unknown>, Record<string, unknown>[]];
    expect(Object.getOwnPropertyNames(struct).sort()).toEqual(["__proto__", "a"]);
    expect(Object.getOwnPropertyNames(list[0]!)).toEqual(["__proto__"]);
    expect(JSON.stringify(r.rows)).toBe('[[{"__proto__":1,"a":2},[{"__proto__":"x"}]]]');
    // Nothing leaked onto the prototype chain either.
    expect(({} as Record<string, unknown>).a).toBeUndefined();
    // The column's type is still the struct's, not the text it was carried as.
    expect(r.columns[0]!.type).toMatch(/^STRUCT/);
  });

  it("writes a TIMESTAMPTZ in UTC whatever zone the machine is in", async () => {
    const r = await okRows("SELECT current_setting('TimeZone'), TIMESTAMPTZ '2026-07-01 00:00:00+09'");
    expect(r.rows).toEqual([["UTC", "2026-06-30T15:00:00Z"]]);
  });

  it("replaces a value over the size limit by a note, without sending it, and hex-writes a blob under it", async () => {
    const r = await okRows("SELECT repeat('x', 100000) AS big_text, repeat('a', 5000)::BLOB AS big_blob, 'ok' AS fine, '\\xBE\\xEF'::BLOB AS small_blob", {
      maxCellBytes: 1000,
    });
    expect(r.rows).toEqual([["[100000 bytes: too large to return]", "[5000 bytes: too large to return]", "ok", "beef"]]);
    expect(r.columns.map((c) => c.type)).toEqual(["VARCHAR", "BLOB", "VARCHAR", "BLOB"]);
    // The same text twice under a repeated name is not confused by the projection.
    const dup = await okRows("SELECT 'a' AS x, 'b' AS x");
    expect(dup.rows).toEqual([["a", "b"]]);
    // Statements that end in a semicolon or a comment still go through it.
    expect((await okRows("SELECT 'a' AS x; -- done")).rows).toEqual([["a"]]);
  });

  it("cuts a result short by rows or by bytes, saying which", async () => {
    const byRows = await okRows("SELECT * FROM range(1000000000000)", { maxRows: 7 });
    expect(byRows.rows.map((row) => row[0])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(byRows.truncatedBy).toBe("rows");
    expect((await okRows("SELECT * FROM range(7)", { maxRows: 7 })).truncatedBy).toBeNull();
    expect((await okRows("SELECT * FROM range(8)", { maxRows: 7 })).truncatedBy).toBe("rows");
    const byBytes = await okRows("SELECT repeat('x', 400) FROM range(100000)", { maxBytes: 2_000 });
    expect(byBytes.truncatedBy).toBe("bytes");
    expect(byBytes.rows.length).toBeGreaterThan(0);
    expect(byBytes.rows.length).toBeLessThan(10);
  });
});

describe("what it refuses", () => {
  it("more than one statement, counted by the database and not by semicolons", async () => {
    expect((await refused("SELECT 1; SELECT 2")).code).toBe("not-one-statement");
    expect((await refused("SELECT 1; DROP TABLE animal")).code).toBe("not-one-statement");
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

  it("before starting a process: too long, a NUL, and limits that are not whole numbers in range", async () => {
    const started = Date.now();
    expect((await refused("SELECT 1 -- " + "x".repeat(20_000))).code).toBe("invalid");
    expect((await refused("SELECT 1\0")).code).toBe("invalid");
    for (const bad of [Number.NaN, Infinity, -1, 0, 1.5, 50_001, "7" as unknown as number]) {
      const err = await queries.run("SELECT 1", { maxRows: bad }).catch((e: unknown) => e);
      expect((err as QueryCopyError).code, `maxRows ${String(bad)}`).toBe("invalid");
    }
    for (const bad of [Number.NaN, 99, 60_001, 0.5, Infinity]) {
      const err = await queries.run("SELECT 1", { timeoutMs: bad }).catch((e: unknown) => e);
      expect((err as QueryCopyError).code, `timeoutMs ${String(bad)}`).toBe("invalid");
    }
    expect(((await queries.run("SELECT 1", { maxBytes: 5 }).catch((e: unknown) => e)) as QueryCopyError).code).toBe("invalid");
    // None of that started a process.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("anything but a SELECT, by kind, including every plan a caller types", async () => {
    const outside = join(dir, "written-by-copy-to.csv");
    const before = await sha256(copyPath);
    const kinds: [string, string][] = [
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
      ["PRAGMA memory_limit = '4GB'", "SET"],
      ["CALL pragma_version()", "CALL"],
      ["CHECKPOINT", "CALL"],
      ["EXPLAIN SELECT 1", "EXPLAIN"],
      ["EXPLAIN ANALYZE SELECT 1", "EXPLAIN"],
      // EXPLAIN ANALYZE executes what it wraps: these overwrote the copy and wrote 1.5 GB beside the store.
      [`EXPLAIN ANALYZE COPY (SELECT 1) TO '${copyPath}'`, "EXPLAIN"],
      [`EXPLAIN ANALYZE COPY (SELECT 1) TO '${copyPath}.wal.recovery' (FORMAT CSV, APPEND)`, "EXPLAIN"],
      [`COPY (SELECT 1) TO '${copyPath}' (FORMAT CSV)`, "COPY"],
    ];
    for (const [sql, kind] of kinds) {
      const err = await refused(sql);
      expect(err.code, sql).toBe("not-allowed");
      expect(err.message, sql).toContain(kind);
    }
    // A file anywhere else is refused by the instance before the statement's kind is even looked at.
    const elsewhere = await refused(`COPY (SELECT 1) TO '${outside}'`);
    expect(elsewhere.message).toMatch(/disabled by config/);
    expect(await sha256(copyPath)).toBe(before);
    expect((await readdir(join(dir, "query-copy"))).sort()).toEqual(["query-copy.duckdb"]);
    expect((await readdir(dir)).sort()).not.toContain("written-by-copy-to.csv");
  });

  it("the rest, which pass the kind check and are refused by the instance itself, leaving the copy and sequences as they were", async () => {
    const before = await sha256(copyPath);
    const seq = "SELECT last_value FROM duckdb_sequences() WHERE sequence_name = 'entity_id_seq'";
    const seqBefore = (await okRows(seq)).rows;
    const liveSeq = async () => (await (await liveConn.run(seq)).getRows())[0]![0];
    const liveSeqBefore = await liveSeq();
    const byInstance: [string, RegExp][] = [
      ["SELECT nextval('entity_id_seq')", /read-only/],
      ["SELECT nextval('entity_id_seq') FROM range(5)", /read-only/],
      ["WITH d AS (UPDATE animal SET rank = 'x' RETURNING entity_id) SELECT * FROM d", /read-only/],
      ["WITH d AS (INSERT INTO person (display_name) VALUES ('x') RETURNING entity_id) SELECT * FROM d", /read-only/],
      ["WITH d AS (DELETE FROM animal RETURNING entity_id) SELECT * FROM d", /read-only/],
      ["SELECT * FROM read_text('/etc/passwd')", /disabled by config/],
      ["SELECT * FROM read_csv('/etc/hostname')", /disabled by config/],
      ["SELECT * FROM glob('/etc/*')", /disabled by config/],
      [`SELECT * FROM read_text('${join(dir, "snapshot.duckdb")}')`, /disabled by config/],
    ];
    for (const [sql, message] of byInstance) {
      const reply = failure(await exec(sql));
      expect(reply.code, sql).toBe("sql");
      expect(reply.message, sql).toMatch(message);
    }
    expect(await sha256(copyPath)).toBe(before);
    expect((await okRows(seq)).rows).toEqual(seqBefore);
    expect(await liveSeq()).toBe(liveSeqBefore);
  });

  it("the configuration lock refuses a SET even when the kind check has been got past", async () => {
    for (const sql of [
      "SET memory_limit = '4GB'",
      "SET threads = 8",
      "SET enable_external_access = true",
      "SET temp_directory = '/tmp/elsewhere'",
      "SET autoload_known_extensions = true",
    ]) {
      const reply = failure(await exec(sql, {}, true));
      expect(reply.message, sql).toMatch(/configuration has been locked/);
    }
    // And with the check in place the same statement never reaches it.
    expect(failure(await exec("SET threads = 8")).code).toBe("not-allowed");
  });

  it.skipIf(isRoot)("a write that got past every check fails on the read-only folder and file", async () => {
    const own = await keptCopy();
    const folder = join(own, "..");
    const before = await sha256(own);
    const listing = (await readdir(folder)).sort();
    const hostile = [
      `COPY (SELECT 1) TO '${own}' (FORMAT CSV)`,
      `EXPLAIN ANALYZE COPY (SELECT 1) TO '${own}' (FORMAT CSV)`,
      `EXPLAIN ANALYZE COPY (SELECT 1) TO '${own}.wal.recovery' (FORMAT CSV, APPEND)`,
      `COPY (SELECT 1) TO '${own}.wal' (FORMAT CSV, APPEND)`,
    ];
    for (const sql of hostile) {
      const reply = failure(await executeQuery({ ...request(sql), path: own }, { bypassKindCheck: true }));
      expect(reply.message, sql).toMatch(/permission|denied|cannot|could not|read-only/i);
    }
    expect(await sha256(own)).toBe(before);
    expect((await readdir(folder)).sort()).toEqual(listing);
    expect((await stat(folder)).mode & 0o777).toBe(0o500);
    expect((await stat(own)).mode & 0o777).toBe(0o400);
  });
});

describe("the child process", () => {
  const slow = "SELECT count(*) FROM range(100000000000)";

  it("kills a query that ignores interrupt at the time limit, and the next query works", async () => {
    const started = Date.now();
    const err = (await queries
      .run("SELECT levenshtein(repeat('ab', 300000), repeat('ba', 300000))", { timeoutMs: 1_500 })
      .catch((e: unknown) => e)) as QueryCopyError;
    expect(err.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(6_000);
    expect((await queries.run("SELECT 1")).rows).toEqual([[1]]);
  });

  it("kills a query that takes all the memory it can, and the next query works", async () => {
    const q = createQueryCopy({ path: copyPath, rssLimitBytes: 600 * 1024 * 1024 });
    const started = Date.now();
    const err = (await q.run("SELECT len(range(400000000))", { timeoutMs: 30_000 }).catch((e: unknown) => e)) as QueryCopyError;
    expect(err.code).toBe("memory");
    expect(err.message).toMatch(/600 MB/);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect((await q.run("SELECT 2")).rows).toEqual([[2]]);
  });

  it("reports a child that crashes, and the app goes on", async () => {
    // 50,000 nested subqueries crash DuckDB's binder; the length limit is raised to let the statement through.
    const n = 50_000;
    const crashing = "SELECT * FROM (".repeat(n) + "SELECT 1 a" + ") t".repeat(n);
    expect(((await queries.run(crashing).catch((e: unknown) => e)) as QueryCopyError).code).toBe("invalid");
    const q = createQueryCopy({ path: copyPath, maxStatementChars: 10_000_000, rssLimitBytes: 1e12 });
    const err = (await q.run(crashing, { timeoutMs: 30_000 }).catch((e: unknown) => e)) as QueryCopyError;
    expect(err).toBeInstanceOf(QueryCopyError);
    expect(err.code).toBe("crashed");
    expect(err.message).toMatch(/signal|exit code/);
    expect((await q.run("SELECT 3")).rows).toEqual([[3]]);
  });

  it("refuses a second query while one runs, and takes the next when its child has exited", async () => {
    const first = queries.run(slow, { timeoutMs: 1_000 }).catch((e: unknown) => e);
    const second = await queries.run("SELECT 1").catch((e: unknown) => e);
    expect((second as QueryCopyError).code).toBe("busy");
    expect(((await first) as QueryCopyError).code).toBe("timeout");
    expect((await queries.run("SELECT 1")).rows).toEqual([[1]]);
  });

  it("is started with none of the app's secrets", async () => {
    process.env.BEELINE_DRIVE_KEY = "sentinel-secret";
    process.env.INAT_API_TOKEN = "sentinel-secret";
    process.env.NODE_TEST_KEPT = "kept";
    try {
      const echo = createQueryCopy({ path: copyPath, workerModule: join(import.meta.dirname, "fixtures", "echo-env-worker.mjs") });
      const names = (await echo.run("SELECT 1")).rows[0] as string[];
      expect(names).toContain("PATH");
      expect(names).toContain("NODE_TEST_KEPT");
      expect(names).not.toContain("BEELINE_DRIVE_KEY");
      expect(names).not.toContain("INAT_API_TOKEN");
      expect(names.every((n) => n === "PATH" || n === "HOME" || n === "TZ" || n === "TMPDIR" || n.startsWith("NODE_"))).toBe(true);
      expect(workerEnvironment({ PATH: "/bin", SENTRY_DSN: "x", TZ: "UTC", HOME: "/root" })).toEqual({ PATH: "/bin", TZ: "UTC", HOME: "/root" });
    } finally {
      delete process.env.BEELINE_DRIVE_KEY;
      delete process.env.INAT_API_TOKEN;
      delete process.env.NODE_TEST_KEPT;
    }
  });
});

describe("the copy file", () => {
  it("is a named error when it is missing, and works once it appears", async () => {
    const own = await mkdtemp(join(tmpdir(), "beeline-query-copy-"));
    const path = join(own, "query-copy", "query-copy.duckdb");
    const q = createQueryCopy({ path });
    expect(((await q.run("SELECT 1").catch((e: unknown) => e)) as QueryCopyError).code).toBe("no-copy");
    await keepQueryCopy(sourceSnapshot, path);
    readOnlyFolders.push(join(own, "query-copy"));
    expect((await q.run("SELECT count(*) FROM animal")).rows).toEqual([[2]]);
  });

  it("is served from whatever file is at the path now, and says when that was made", async () => {
    const path = await keptCopy();
    const q = createQueryCopy({ path });
    expect((await q.run("SELECT count(*) FROM person")).rows).toEqual([[1]]);
    const first = (await q.run("SELECT 1")).copiedAt;

    // Tonight's copy has two people; it arrives by the same rename the backup job uses.
    const db = await createFileDb();
    const conn = await db.instance.connect();
    await conn.run(`INSERT INTO person (display_name) VALUES ('P1'), ('P2')`);
    const night2 = join(path, "..", "..", "night2.duckdb");
    await snapshotCatalog(conn, db.catalog, night2, null);
    conn.closeSync();
    db.instance.closeSync();
    await new Promise((r) => setTimeout(r, 20));
    await keepQueryCopy(night2, path);
    const after = await q.run("SELECT count(*) FROM person");
    expect(after.rows).toEqual([[2]]);
    expect(after.copiedAt > first).toBe(true);
  });

  it("is a copy-unreadable error when the file is not a database", async () => {
    const own = await mkdtemp(join(tmpdir(), "beeline-query-copy-"));
    const path = join(own, "query-copy.duckdb");
    await writeFile(path, "this is not a database file, only text that is long enough to be read as a header ".repeat(40));
    const err = (await createQueryCopy({ path }).run("SELECT 1").catch((e: unknown) => e)) as QueryCopyError;
    expect(err).toBeInstanceOf(QueryCopyError);
    expect(err.code).toBe("copy-unreadable");
    expect(err.message).toMatch(/could not be opened/);
  });

  it("is a query that needs more memory than its limit fails with an ordinary error, and nothing is written beside the copy", async () => {
    const path = await keptCopy();
    const small = createQueryCopy({ path, memoryLimit: "64MB" });
    const listing = (await readdir(join(path, ".."))).sort();
    const err = (await small
      .run("SELECT sum(length(m)) FROM (SELECT repeat(md5(range::varchar), 4) m, random() k FROM range(3000000) ORDER BY k)", {
        timeoutMs: 60_000,
      })
      .catch((e: unknown) => e)) as QueryCopyError;
    expect(err).toBeInstanceOf(QueryCopyError);
    expect(err.code).toBe("sql");
    expect(err.message).toMatch(/temp|memory|director/i);
    expect((await readdir(join(path, ".."))).sort()).toEqual(listing);
    expect((await small.run("SELECT count(*) FROM animal")).rows).toEqual([[2]]);
    await liveConn.run(`INSERT INTO person (display_name) VALUES ('Still writing')`);
  });
});

describe("keeping the copy", () => {
  it("puts it in a folder of its own, read-only at rest, replacing the old one whole", async () => {
    const path = await keptCopy();
    const folder = join(path, "..");
    expect(await readdir(folder)).toEqual(["query-copy.duckdb"]);
    expect((await stat(path)).mode & 0o777).toBe(0o400);
    expect((await stat(folder)).mode & 0o777).toBe(0o500);
    expect(await sha256(path)).toBe(await sha256(sourceSnapshot));

    // Debris from an older file and a crashed run: removed before the rename, not after.
    await chmod(folder, 0o700);
    for (const name of ["query-copy.duckdb.wal", "query-copy.duckdb.wal.checkpoint", "query-copy.duckdb.wal.recovery", "query-copy.duckdb.partial"]) {
      await writeFile(join(folder, name), "stale");
    }
    await keepQueryCopy(sourceSnapshot, path);
    expect(await readdir(folder)).toEqual(["query-copy.duckdb"]);
    expect((await stat(folder)).mode & 0o777).toBe(0o500);
    expect(await sha256(path)).toBe(await sha256(sourceSnapshot));
  });

  it("leaves the old copy untouched, no partial file, and the folder closed when the new copy cannot be written", async () => {
    const path = await keptCopy();
    const folder = join(path, "..");
    const before = await sha256(path);
    // The source is missing, so the failure is in the copy itself, after the folder was opened and the partial file created.
    await expect(keepQueryCopy(join(dir, "no-such-snapshot.duckdb"), path)).rejects.toThrow(/no-such-snapshot/);
    expect(await sha256(path)).toBe(before);
    expect(await readdir(folder)).toEqual(["query-copy.duckdb"]);
    expect((await stat(folder)).mode & 0o777).toBe(0o500);
    expect((await stat(path)).mode & 0o777).toBe(0o400);
  });

  it("refuses a path that is the live store, a WAL beside it, or another file the app writes, before touching anything", async () => {
    const own = await mkdtemp(join(tmpdir(), "beeline-query-copy-"));
    const store = join(own, "beeline.duckdb");
    await writeFile(store, "the live store");
    const csv = join(own, "corrections.csv");
    await writeFile(csv, "a,b\n");
    await symlink(store, join(own, "alias.duckdb"));
    await mkdir(join(own, "real"));
    await symlink(join(own, "real"), join(own, "linked-folder"));
    for (const target of [store, `${store}.wal`, `${store}.wal.recovery`, csv, join(own, "alias.duckdb"), join(own, "linked-folder", "..", "beeline.duckdb")]) {
      await expect(keepQueryCopy(sourceSnapshot, target, [store, csv]), target).rejects.toThrow(/refusing to replace/);
    }
    expect(await readFile(store, "utf8")).toBe("the live store");
    expect(await readFile(csv, "utf8")).toBe("a,b\n");
    expect(await readdir(own)).not.toContain("beeline.duckdb.partial");
    expect(queryCopyConflict("/a/b/store.duckdb", ["/a/b/store.duckdb"])).toBe("/a/b/store.duckdb");
    expect(queryCopyConflict("/a/b/query-copy/query-copy.duckdb", ["/a/b/store.duckdb"])).toBeNull();
  });
});

describe("where the app is told to keep it", () => {
  const base = { BEELINE_ORIGIN: "https://x.org" };

  it("defaults to a folder of its own, beside the store when there is one, and one default everywhere", () => {
    expect(configFromEnv({ ...base, BEELINE_DB: "/app/data/beeline.duckdb" }).queryCopyPath).toBe("/app/data/query-copy/query-copy.duckdb");
    expect(configFromEnv(base).queryCopyPath).toBe(DEFAULT_QUERY_COPY_PATH);
    expect(DEFAULT_QUERY_COPY_PATH).toBe("data/query-copy/query-copy.duckdb");
    expect(configFromEnv({ ...base, BEELINE_QUERY_COPY: "/elsewhere/q/q.duckdb" }).queryCopyPath).toBe("/elsewhere/q/q.duckdb");
  });

  it("refuses a path that is the live store or its WAL", () => {
    expect(() => configFromEnv({ ...base, BEELINE_DB: "/app/data/beeline.duckdb", BEELINE_QUERY_COPY: "/app/data/beeline.duckdb" })).toThrow(
      /would replace the live store/,
    );
    expect(() => configFromEnv({ ...base, BEELINE_DB: "/app/data/beeline.duckdb", BEELINE_QUERY_COPY: "/app/data/beeline.duckdb.wal" })).toThrow(
      /would replace the live store/,
    );
  });
});
