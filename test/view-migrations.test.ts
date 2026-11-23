import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { MIGRATIONS_DIR } from "../src/migrate.js";
import { SCHEMA_DIR } from "../src/schema.js";
import { viewHash, VIEW_MANIFEST } from "../src/view-manifest.js";
import { createMemoryDb } from "./helpers.js";
import { sqlFiles, viewStatements, splitStatements, type ViewStatement } from "./migration-statements.js";

/**
 * "Did this change forget a migration?" for views, which `db:migrate --check`
 * cannot answer on a deployed store: DuckDB stores a view's text as the
 * version that wrote it serialised it, so production's differs from a fresh
 * build's with no difference in meaning (ADR 0006, the 2026-11-22
 * amendment, beeline-0apa). Here both sides are written by the DuckDB that
 * runs the test, so the text compares exactly.
 *
 * The rule: the newest migration that states a view states it as schema/
 * does. A view no migration states is held by a hash in
 * migrations/view-hashes.txt instead.
 */

const stored = async (c: DuckDBConnection) => {
  const rows = await (
    await c.run("SELECT view_name, sql, comment FROM duckdb_views() WHERE NOT internal AND schema_name = 'main' ORDER BY view_name")
  ).getRows();
  return new Map(rows.map(([n, sql, comment]) => [String(n), { sql: String(sql), comment: comment === null ? null : String(comment) }]));
};

/**
 * Production's store was built fresh from schema/ at cutover (2026-11-03) and
 * has run only the migrations from 0070 on; the earlier ones served the
 * sandbox, and several no longer run on today's schema. A view whose newest
 * statement is older than this is held by a hash instead.
 */
const FIRST_MIGRATION_PRODUCTION_RAN = "0070";

const migrations = await sqlFiles(MIGRATIONS_DIR);
const statements = viewStatements(migrations.filter((m) => m.file >= FIRST_MIGRATION_PRODUCTION_RAN));

/** Newest-first order: by file, then by position in the file. */
const order = (a: ViewStatement, b: ViewStatement) => (a.file === b.file ? a.index - b.index : a.file < b.file ? -1 : 1);
const history = (view: string) => statements.filter((s) => s.view === view).sort(order);
/** The newest CREATE or DROP of a view, which decides whether and how a migration states it. */
const newestShape = (view: string) => history(view).filter((s) => s.kind !== "comment").at(-1);

describe("the statement splitter", () => {
  test("agrees with DuckDB on how many statements every schema file and every migration holds", async () => {
    const { conn } = await createMemoryDb();
    const schema = await sqlFiles(SCHEMA_DIR);
    const wrong: string[] = [];
    for (const { file, text } of [...schema.map((f) => ({ ...f, file: `schema/${f.file}` })), ...migrations.map((f) => ({ ...f, file: `migrations/${f.file}` }))]) {
      const mine = splitStatements(text).length;
      const duckdb = (await conn.extractStatements(text)).count;
      if (mine !== duckdb) wrong.push(`${file}: splitter ${mine}, DuckDB ${duckdb}`);
    }
    expect(wrong).toEqual([]);
  });

  test("cuts at a top-level semicolon only", () => {
    expect(splitStatements("-- a; b\nSELECT 'x;''y'; /* ; */ SELECT \"a;b\" ; -- end;")).toEqual([
      "-- a; b\nSELECT 'x;''y'",
      "/* ; */ SELECT \"a;b\"",
    ]);
  });
});

describe("views and the migrations that state them", () => {
  test("the newest migration that states each view states it as schema/ does", async () => {
    const { conn: reference } = await createMemoryDb();
    const { conn: store } = await createMemoryDb();
    const wanted = await stored(reference);
    const failures: string[] = [];
    const unstated: string[] = [];

    for (const [view, want] of wanted) {
      const shape = newestShape(view);
      if (shape === undefined) {
        unstated.push(view);
        continue;
      }
      if (shape.kind === "drop") {
        failures.push(`${view}: the newest migration to touch it, ${shape.file}, drops it, yet schema/ declares it`);
        continue;
      }
      // Replay only this view's own statements: its CREATE (as OR REPLACE, so it
      // replaces the view in place) and every COMMENT ON VIEW stated after it.
      const replay = history(view).filter((s) => s.kind === "comment" && order(shape, s) < 0);
      try {
        await store.run(shape.text.replace(/^(\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*)CREATE\s+VIEW/i, "$1CREATE OR REPLACE VIEW"));
        for (const c of replay) await store.run(c.text);
      } catch (err) {
        failures.push(`${view}: ${shape.file} no longer runs on today's schema: ${(err as Error).message.split("\n")[0]}`);
        continue;
      }
      const got = (await stored(store)).get(view)!;
      if (got.sql !== want.sql) failures.push(`${view}: the text ${shape.file} gives differs from schema/'s\n  migration: ${got.sql}\n  schema:    ${want.sql}`);
      if (got.comment !== want.comment) failures.push(`${view}: the comment after ${shape.file} differs from schema/'s\n  migration: ${got.comment}\n  schema:    ${want.comment}`);
    }
    expect(failures).toEqual([]);
    // The views no migration states, which the manifest holds, are the next test's.
    expect(unstated.length).toBeGreaterThan(0);
  });

  test("a view no migration states is held by a hash, and only those views are", async () => {
    const { conn } = await createMemoryDb();
    const have = await stored(conn);
    const manifest = new Map(
      (await readFile(VIEW_MANIFEST, "utf8"))
        .split("\n")
        .filter((l) => l.trim() !== "" && !l.startsWith("#"))
        .map((l) => l.split(/\s+/) as [string, string]),
    );
    const problems: string[] = [];
    for (const [view, want] of have) {
      const stated = newestShape(view) !== undefined;
      const hash = manifest.get(view);
      if (stated && hash !== undefined) problems.push(`${view}: a migration states it, so delete its line from migrations/view-hashes.txt`);
      if (!stated && hash === undefined) problems.push(`${view}: in the schema, stated by no migration and not in migrations/view-hashes.txt`);
      if (!stated && hash !== undefined && hash !== viewHash(want.sql, want.comment)) {
        problems.push(`${view}: changed in schema/ and held by a hash: write a migration that restates the view, then delete its line from migrations/view-hashes.txt`);
      }
    }
    for (const view of manifest.keys()) if (!have.has(view)) problems.push(`${view}: in migrations/view-hashes.txt but not in the schema; delete the line`);
    expect(problems).toEqual([]);
  });

  test("a migration that creates a view the schema comments restates the comment after it, in the same file", async () => {
    const { conn } = await createMemoryDb();
    const have = await stored(conn);
    const missing: string[] = [];
    for (const s of statements.filter((s) => s.kind === "create")) {
      if (have.get(s.view)?.comment == null) continue;
      const restated = statements.some((c) => c.kind === "comment" && c.view === s.view && c.file === s.file && c.index > s.index);
      if (!restated) missing.push(`${s.file}: ${s.view}`);
    }
    expect(missing).toEqual([]);
  });
});

