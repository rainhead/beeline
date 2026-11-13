import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cell, parseArgs, storeQuery, summary, table } from "../src/store-query.js";
import { keepQueryCopy } from "../src/store-backup.js";
import { snapshotCatalog } from "../src/store-snapshot.js";
import type { QueryResult } from "../src/query-copy.js";
import { createFileDb } from "./helpers.js";

/**
 * `pnpm store:query` (beeline-pnqr.4): the command that asks last night's
 * copy of the store a question. The runner behind it has its own tests
 * (test/query-copy.test.ts); these are the command's arguments, its output,
 * and one run from end to end against a real copy while the store it was
 * copied from is still open, as the app's is.
 */

const result = (over: Partial<QueryResult> = {}): QueryResult => ({
  columns: [
    { name: "name", type: "VARCHAR" },
    { name: "n", type: "INTEGER" },
  ],
  rows: [
    ["Ada", 2],
    [null, 0],
  ],
  truncated: false,
  truncatedBy: null,
  copiedAt: "2026-11-12T11:00:00.000Z",
  limits: { timeoutMs: 10_000, maxRows: 5_000, maxBytes: 5_000_000 },
  elapsedMs: 290,
  ...over,
});

describe("store:query arguments", () => {
  it("takes one statement and its options", () => {
    expect(parseArgs(["SELECT 1"])).toEqual({ sql: "SELECT 1", json: false, explain: false });
    expect(parseArgs(["--json", "--rows", "20", "--timeout", "2.5", "--explain", "--copy", "/x/y.duckdb", "SELECT 1"])).toEqual({
      sql: "SELECT 1",
      json: true,
      explain: true,
      maxRows: 20,
      timeoutMs: 2500,
      copy: "/x/y.duckdb",
    });
    expect(parseArgs(["-"])).toMatchObject({ sql: "-" });
  });

  it("says what is wrong with arguments it cannot use", () => {
    expect(parseArgs([])).toEqual({ problem: "give one statement, or - to read it from standard input" });
    // A statement left unquoted arrives as several words.
    expect(parseArgs(["SELECT", "1"])).toEqual({ problem: "give one statement, in quotes" });
    expect(parseArgs(["--rows", "many", "SELECT 1"])).toEqual({ problem: "--rows takes a whole number" });
    expect(parseArgs(["--timeout", "SELECT 1"])).toEqual({ problem: "--timeout takes a number of seconds" });
    expect(parseArgs(["--live", "SELECT 1"])).toEqual({ problem: "unknown option --live" });
  });
});

describe("store:query output", () => {
  it("prints a tab-separated table with a header row, one line per row", () => {
    expect(table(result())).toBe("name\tn\nAda\t2\nNULL\t0\n");
    // A tab or a line break inside a value cannot split a column or a row.
    expect(cell("a\tb\nc\\d")).toBe("a\\tb\\nc\\\\d");
    expect(cell(["x", 1])).toBe('["x",1]');
    expect(cell({ a: null })).toBe('{"a":null}');
  });

  it("says how many rows, how old the copy is, and when the answer was cut short", () => {
    const now = new Date("2026-11-12T19:00:00.000Z");
    expect(summary(result(), now)).toBe("2 rows in 290 ms, from the copy made 2026-11-12T11:00:00.000Z (8 hours ago)");
    expect(summary(result({ rows: [["Ada", 2]] }), now)).toContain("1 row in");
    expect(summary(result({ truncated: true, truncatedBy: "rows" }), now)).toContain("cut short at the row limit of 5000");
    expect(summary(result({ truncated: true, truncatedBy: "bytes" }), now)).toContain("cut short at 5000000 bytes");
    // A night's backup that did not replace the copy is worth saying.
    expect(summary(result(), new Date("2026-11-15T11:00:00.000Z"))).toContain("(3 days ago) — older than one night");
  });
});

describe("store:query, end to end", () => {
  let copy: string;
  let closeLive: () => void;

  beforeAll(async () => {
    // A store that stays open, as the app's does, and a copy kept from a snapshot of it, as the nightly backup keeps one.
    const db = await createFileDb();
    const conn = await db.instance.connect();
    await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Adams'), ('Bo Barnes')`);
    const dir = await mkdtemp(join(tmpdir(), "beeline-store-query-"));
    const snapshot = join(dir, "snapshot.duckdb");
    await snapshotCatalog(conn, db.catalog, snapshot, null);
    copy = join(dir, "query-copy", "query-copy.duckdb");
    await keepQueryCopy(snapshot, copy);
    await conn.run(`INSERT INTO person (display_name) VALUES ('Cleo Cortez')`);
    closeLive = () => conn.closeSync();
  });

  afterAll(() => closeLive());

  const run = async (argv: string[], stdin = "") => {
    let out = "";
    let err = "";
    const status = await storeQuery(argv, {
      env: {},
      stdin: async () => stdin,
      out: (t) => (out += t),
      err: (t) => (err += t),
    });
    return { status, out, err };
  };

  it("answers from the copy while the store it came from is open, and never sees what was written since", async () => {
    const r = await run(["--copy", copy, "SELECT display_name FROM person ORDER BY 1"]);
    expect(r.status).toBe(0);
    expect(r.out).toBe("display_name\nAda Adams\nBo Barnes\n");
    expect(r.err).toMatch(/^2 rows in \d+ ms, from the copy made \d{4}-/);
  });

  it("reads the statement from standard input, and prints JSON when asked", async () => {
    const r = await run(["--copy", copy, "--json", "--rows", "1", "-"], "SELECT display_name FROM person ORDER BY 1\n");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.out) as QueryResult;
    expect(parsed.rows).toEqual([["Ada Adams"]]);
    expect(parsed.truncatedBy).toBe("rows");
    expect(r.err).toContain("cut short at the row limit of 1");
  });

  it("refuses a statement that is not a SELECT, with a status that says the query failed", async () => {
    const r = await run(["--copy", copy, "DELETE FROM person"]);
    expect(r.status).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^not-allowed: /);
  });

  it("says where it looked when there is no copy, and that the arguments were wrong when they were", async () => {
    const missing = await run(["--copy", join(tmpdir(), "nowhere", "query-copy.duckdb"), "SELECT 1"]);
    expect(missing.status).toBe(1);
    expect(missing.err).toMatch(/^no-copy: .*looked at .*nowhere/s);
    const usage = await run([]);
    expect(usage.status).toBe(2);
    expect(usage.err).toContain("usage: pnpm store:query");
  });

  it("finds the copy beside the store BEELINE_DB names when no path is given", async () => {
    let asked = "";
    const status = await storeQuery(["SELECT 1"], {
      env: { BEELINE_DB: "/app/data/beeline.duckdb" },
      stdin: async () => "",
      out: () => {},
      err: () => {},
      queries: (path) => {
        asked = path;
        return { run: async () => result() };
      },
    });
    expect(status).toBe(0);
    expect(asked).toBe("/app/data/query-copy/query-copy.duckdb");
  });
});
