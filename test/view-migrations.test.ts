import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { MIGRATIONS_DIR } from "../src/migrate.js";
import { SCHEMA_DIR } from "../src/schema.js";
import { parseManifest, rehashManifest, viewHash, VIEW_MANIFEST } from "../src/view-manifest.js";
import { createMemoryDb } from "./helpers.js";
import { plainCreateOfExistingView, asCreateOrReplace, createdAndNeverDropped, creatingWithoutComment, sqlFiles, viewStatements, splitStatements, type ViewStatement } from "./migration-statements.js";

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

const INGEST_DIR = fileURLToPath(new URL("../ingest/", import.meta.url));

const stored = async (c: DuckDBConnection) => {
  const rows = await (
    await c.run("SELECT view_name, sql, comment FROM duckdb_views() WHERE NOT internal AND schema_name = 'main' AND database_name = current_database() ORDER BY view_name")
  ).getRows();
  return new Map(rows.map(([n, sql, comment]) => [String(n), { sql: String(sql), comment: comment === null ? null : String(comment) }]));
};

/**
 * Production's store was built fresh from schema/ at cutover and stamped every
 * migration up to 0070 at one instant (2026-11-03 22:01:54, in its backup of
 * 2026-11-22); the first one it ran, 2026-11-04 00:05:48, is
 * 0071-nothing-names-the-oklahoma-bee-atlas.sql. The earlier ones served the
 * sandbox, and several no longer run on today's schema. A view whose newest
 * statement is older than this is held by a hash instead.
 */
const FIRST_MIGRATION_PRODUCTION_RAN = "0071";

/** What to do about a view whose newest migration no longer gives the schema's text or comment. */
const restate = (file: string) =>
  `write a NEW migration, sorting after ${file}, that restates the whole view (CREATE OR REPLACE VIEW) and then its COMMENT ON VIEW; do not edit ${file}, because production has already run it and never runs it again`;

const migrations = await sqlFiles(MIGRATIONS_DIR);
const statements = viewStatements(migrations.filter((m) => m.file >= FIRST_MIGRATION_PRODUCTION_RAN));

/** Newest-first order: by file, then by position in the file. */
const order = (a: ViewStatement, b: ViewStatement) => (a.file === b.file ? a.index - b.index : a.file < b.file ? -1 : 1);
const history = (view: string) => statements.filter((s) => s.view === view).sort(order);
/** The newest CREATE or DROP of a view, which decides whether and how a migration states it. */
const newestShape = (view: string) => history(view).filter((s) => s.kind !== "comment").at(-1);

/** What is wrong between the schema's views, the manifest's text and which views a migration states. */
function manifestProblems(
  have: Map<string, { sql: string; comment: string | null }>,
  manifestText: string,
  isStated: (view: string) => boolean,
  running: string,
): string[] {
  const { version, hashes } = parseManifest(manifestText);
  // Before any hash is compared: another DuckDB writes views differently, so every hash would differ.
  if (hashes.size > 0 && version !== running) return [`DuckDB changed from ${version ?? "an unrecorded version"} to ${running}: run pnpm views:rehash`];
  const problems: string[] = [];
  for (const [view, want] of have) {
    const stated = isStated(view);
    const hash = hashes.get(view);
    if (stated && hash !== undefined) problems.push(`${view}: a migration states it, so delete its line from migrations/view-hashes.txt`);
    if (!stated && hash === undefined) {
      problems.push(`${view}: in the schema, but no migration creates it and it is not in migrations/view-hashes.txt: write a NEW migration that creates it (do not add a line to the file)`);
    }
    if (!stated && hash !== undefined && hash !== viewHash(want.sql, want.comment)) {
      problems.push(
        `${view}: changed in schema/ and held by a hash: write a NEW migration, sorting after every existing migration, that restates the whole view (CREATE OR REPLACE VIEW) and its COMMENT ON VIEW, then delete its line from migrations/view-hashes.txt. A migration with only the comment is not enough`,
      );
    }
  }
  for (const view of hashes.keys()) if (!have.has(view)) problems.push(`${view}: in migrations/view-hashes.txt but not in the schema; delete the line, and if a deployed store has the view write a NEW migration with DROP VIEW`);
  return problems;
}

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

  test("rewrites CREATE VIEW to CREATE OR REPLACE VIEW after any comments, and leaves OR REPLACE alone", () => {
    expect(asCreateOrReplace("/* a; b */\n-- line\n  CREATE VIEW v AS SELECT 1")).toBe("/* a; b */\n-- line\n  CREATE OR REPLACE VIEW v AS SELECT 1");
    expect(asCreateOrReplace("-- x\nCREATE OR REPLACE VIEW v AS SELECT 1")).toBe("-- x\nCREATE OR REPLACE VIEW v AS SELECT 1");
    expect(asCreateOrReplace("COMMENT ON VIEW v IS 'CREATE VIEW'")).toBe("COMMENT ON VIEW v IS 'CREATE VIEW'");
    // The pattern that CodeQL flagged: many block comments in a row do not hang it.
    expect(asCreateOrReplace("/*".repeat(5000) + "CREATE VIEW v AS SELECT 1")).toContain("/*");
  });

  test("cuts at a top-level semicolon only", () => {
    expect(splitStatements("-- a; b\nSELECT 'x;''y'; /* ; */ SELECT \"a;b\" ; -- end;")).toEqual([
      "-- a; b\nSELECT 'x;''y'",
      "/* ; */ SELECT \"a;b\"",
    ]);
  });
});

describe("the rule about comments, on made-up migrations", () => {
  const stated = (files: Record<string, string>) =>
    viewStatements(Object.entries(files).map(([file, text]) => ({ file, text })));

  test("only the newest create of a view needs the comment", () => {
    const earlierWithout = stated({
      "0100-a.sql": "CREATE VIEW v AS SELECT 1 AS a;",
      "0101-b.sql": "CREATE OR REPLACE VIEW v AS SELECT 2 AS a; COMMENT ON VIEW v IS 'now commented';",
    });
    expect(creatingWithoutComment(earlierWithout, () => true)).toEqual([]);

    const newestWithout = stated({
      "0100-a.sql": "CREATE VIEW v AS SELECT 1 AS a; COMMENT ON VIEW v IS 'commented';",
      "0101-b.sql": "CREATE OR REPLACE VIEW v AS SELECT 2 AS a;",
    });
    expect(creatingWithoutComment(newestWithout, () => true)).toEqual([expect.stringContaining("0101-b.sql: v is created with no COMMENT ON VIEW")]);
    // A view the schema does not comment needs none.
    expect(creatingWithoutComment(newestWithout, () => false)).toEqual([]);
  });
});

describe("a view the schema no longer declares", () => {
  const stated = (files: Record<string, string>) => viewStatements(Object.entries(files).map(([file, text]) => ({ file, text })));
  const none = new Set<string>();

  test("must have been dropped by the newest migration that mentions it", () => {
    expect(createdAndNeverDropped(stated({ "0100-a.sql": "CREATE VIEW v AS SELECT 1 AS a;", "0101-b.sql": "DROP VIEW v;" }), none)).toEqual([]);
    expect(createdAndNeverDropped(stated({ "0100-a.sql": "CREATE VIEW v AS SELECT 1 AS a;" }), none)).toEqual([expect.stringContaining("v: 0100-a.sql")]);
    expect(
      createdAndNeverDropped(stated({ "0100-a.sql": "CREATE VIEW v AS SELECT 1 AS a; DROP VIEW v;", "0101-b.sql": "CREATE VIEW v AS SELECT 2 AS a;" }), none),
    ).toEqual([expect.stringContaining("v: 0101-b.sql")]);
    // A view the schema still declares is the other tests' business.
    expect(createdAndNeverDropped(stated({ "0100-a.sql": "CREATE VIEW v AS SELECT 1 AS a;" }), new Set(["v"]))).toEqual([]);
  });

  test("none of today's migrations leaves one behind", async () => {
    const { conn } = await createMemoryDb();
    // Views that ingest/*.sql makes when a legacy promotion runs (not schema/) are declared there; the
    // migrations that change them say `-- needs:` (migrations/README.md).
    const ingest = viewStatements(await sqlFiles(INGEST_DIR)).filter((s) => s.kind === "create").map((s) => s.view);
    expect(createdAndNeverDropped(statements, new Set([...(await stored(conn)).keys(), ...ingest]))).toEqual([]);
  });
});

describe("views and the migrations that state them", () => {
  test("the newest migration that states each view states it as schema/ does", async () => {
    const { conn: reference } = await createMemoryDb();
    const { conn: store } = await createMemoryDb();
    const wanted = await stored(reference);
    const failures: string[] = [];

    for (const [view, want] of wanted) {
      const shape = newestShape(view);
      if (shape === undefined) {
        continue;
      }
      if (shape.kind === "drop") {
        failures.push(`${view}: the newest migration to touch it, ${shape.file}, drops it, yet schema/ declares it: ${restate(shape.file)}`);
        continue;
      }
      // Replay only this view's own statements: its CREATE (as OR REPLACE, so it
      // replaces the view in place) and every COMMENT ON VIEW stated after it.
      const replay = history(view).filter((s) => s.kind === "comment" && order(shape, s) < 0);
      try {
        await store.run(asCreateOrReplace(shape.text));
        for (const c of replay) await store.run(c.text);
      } catch (err) {
        failures.push(`${view}: ${shape.file} no longer runs on today's schema (${(err as Error).message.split("\n")[0]}): ${restate(shape.file)}`);
        continue;
      }
      const got = (await stored(store)).get(view)!;
      if (got.sql !== want.sql) failures.push(`${view}: the text ${shape.file} gives differs from schema/'s: ${restate(shape.file)}\n  migration: ${got.sql}\n  schema:    ${want.sql}`);
      if (got.comment !== want.comment) failures.push(`${view}: the comment after ${shape.file} differs from schema/'s: ${restate(shape.file)}\n  migration: ${got.comment}\n  schema:    ${want.comment}`);
    }
    expect(failures).toEqual([]);
    // Views no migration states are held by the manifest, which the next test checks.
  });

  test("a view no migration states is held by a hash, and only those views are", async () => {
    const { conn } = await createMemoryDb();
    const text = await readFile(VIEW_MANIFEST, "utf8").catch(() => "");
    const [[running]] = (await (await conn.run("SELECT version()")).getRows()) as [[string]];
    expect(manifestProblems(await stored(conn), text, (view) => newestShape(view) !== undefined, running)).toEqual([]);
  });

  test("an empty or absent manifest is fine once every view is stated by a migration", () => {
    const have = new Map([["v", { sql: "CREATE VIEW v AS SELECT 1", comment: null }]]);
    expect(manifestProblems(have, "", () => true, "v9")).toEqual([]);
    expect(manifestProblems(have, "# duckdb v1\n", () => true, "v9")).toEqual([]);
    expect(manifestProblems(have, "", () => false, "v9")).toEqual([expect.stringContaining("v: in the schema, but no migration creates it")]);
  });

  test("another DuckDB version is named before any hash is compared", () => {
    const have = new Map([["v", { sql: "CREATE VIEW v AS SELECT 1", comment: null }]]);
    const text = `# duckdb v1\nv ${viewHash("something else", null)}\n`;
    expect(manifestProblems(have, text, () => false, "v2")).toEqual(["DuckDB changed from v1 to v2: run pnpm views:rehash"]);
    // The same version with a different hash is a changed view, and says a migration is needed.
    expect(manifestProblems(have, text, () => false, "v1")).toEqual([expect.stringContaining("write a NEW migration")]);
  });

  test("pnpm views:rehash refuses with the recorded version and runs after an upgrade", () => {
    const fresh = new Map([["v", "newhash"]]);
    expect(() => rehashManifest("# duckdb v1\nv oldhash\n", fresh, "v1")).toThrow(/needs a new migration/);
    expect(rehashManifest("# duckdb v1\nv oldhash\n", fresh, "v2")).toBe("# duckdb v2\nv newhash\n");
    // It never adds a view, and refuses one that has left the schema.
    expect(rehashManifest("# duckdb v1\nv oldhash\n", new Map([["v", "h"], ["w", "h"]]), "v2")).not.toContain("w ");
    expect(() => rehashManifest("# duckdb v1\nx oldhash\n", fresh, "v2")).toThrow(/not in the schema/);
  });

  test("a migration that creates a view the schema comments restates the comment after it, in the same file", async () => {
    const { conn } = await createMemoryDb();
    const have = await stored(conn);
    const missing = creatingWithoutComment(statements, (view) => have.get(view)?.comment != null);
    expect(missing).toEqual([]);
  });
});


describe("a migration that restates a view that already exists", () => {
  test("uses CREATE OR REPLACE, or drops it first, because a plain CREATE fails on a deployed store", async () => {
    const all = viewStatements(migrations);
    expect(plainCreateOfExistingView(all, "0122")).toEqual([]);
  });

  test("names a plain CREATE of an existing view, and not one after a DROP", () => {
    const made = viewStatements([
      { file: "0040-a.sql", text: "CREATE VIEW v AS SELECT 1;" },
      { file: "0041-b.sql", text: "CREATE VIEW v AS SELECT 2;" },
      { file: "0042-c.sql", text: "DROP VIEW v; CREATE VIEW v AS SELECT 3; CREATE OR REPLACE VIEW v AS SELECT 4;" },
    ]);
    expect(plainCreateOfExistingView(made, "0040")).toHaveLength(1);
    expect(plainCreateOfExistingView(made, "0040")[0]).toContain("0041-b.sql");
  });
});
