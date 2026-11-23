import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Splits a SQL file into its statements, with their text, which DuckDB's
 * node API does not return (`extractStatements` gives a count and prepared
 * statements only). It walks the characters and cuts at a `;` that is not
 * inside a single-quoted string (a doubled quote stays inside), a double-quoted
 * identifier, a `--` comment or a block comment. No file in schema/ or
 * migrations/ uses dollar quoting; if one starts to, the count check in
 * test/view-migrations.test.ts fails for that file rather than mis-splitting it.
 *
 * Comment-only stretches (a trailing comment, or a file that is all comment)
 * are not statements and are dropped, as DuckDB drops them.
 */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const flush = (end: number) => {
    const piece = text.slice(start, end);
    if (stripLeadingComments(piece) !== "") out.push(piece.trim());
    start = end + 1;
  };
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "'" || c === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === c) {
          if (text[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "-" && next === "-") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
    } else if (c === ";") {
      flush(i);
      i++;
    } else i++;
  }
  flush(text.length);
  return out;
}

/** The statement with leading whitespace and comments removed; empty when nothing else is left. */
export function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    s = s.replace(/^\s+/, "");
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("/*")) {
      const close = s.indexOf("*/", 2);
      s = close === -1 ? "" : s.slice(close + 2);
    } else return s;
  }
}

export interface ViewStatement {
  file: string;
  /** Position among the file's statements, from 0. */
  index: number;
  kind: "create" | "drop" | "comment";
  view: string;
  /** The statement as written. */
  text: string;
}

/**
 * What a statement does to a view, read from its first keywords only. A
 * statement is already separate, so a `CREATE VIEW` inside a string or a
 * comment elsewhere cannot be matched. Names in these files are bare
 * identifiers; a quoted or schema-qualified one is not recognised, which the
 * tests would show as a view stated by nothing.
 */
export function viewStatement(file: string, index: number, text: string): ViewStatement | null {
  const head = stripLeadingComments(text);
  let m = /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(head);
  if (m) return { file, index, kind: "create", view: m[1]!, text };
  m = /^DROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(head);
  if (m) return { file, index, kind: "drop", view: m[1]!, text };
  m = /^COMMENT\s+ON\s+VIEW\s+([A-Za-z_][A-Za-z0-9_]*)\s+IS\b/i.exec(head);
  if (m) return { file, index, kind: "comment", view: m[1]!, text };
  return null;
}

/** Every .sql file of a directory, in filename order, with its text. */
export async function sqlFiles(dir: string): Promise<{ file: string; text: string }[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(names.map(async (file) => ({ file, text: await readFile(join(dir, file), "utf8") })));
}

/** The view statements of a list of files, in the order a store would see them. */
export function viewStatements(files: { file: string; text: string }[]): ViewStatement[] {
  const out: ViewStatement[] = [];
  for (const { file, text } of files) {
    splitStatements(text).forEach((s, index) => {
      const v = viewStatement(file, index, s);
      if (v !== null) out.push(v);
    });
  }
  return out;
}

/**
 * Views a migration creates or replaces and leaves without the comment the
 * schema gives them. `CREATE OR REPLACE VIEW` drops a view's comment, so the
 * newest statement that creates a view must be followed, in its own file, by
 * a `COMMENT ON VIEW` for it. Earlier creates are superseded, so a view that
 * had no comment when first made and gained one in a later migration is not
 * a failure of the first. Only views the schema comments are required to.
 */
export function creatingWithoutComment(statements: ViewStatement[], schemaComments: (view: string) => boolean): string[] {
  const order = (a: ViewStatement, b: ViewStatement) => (a.file === b.file ? a.index - b.index : a.file < b.file ? -1 : 1);
  const newest = new Map<string, ViewStatement>();
  for (const s of [...statements].sort(order)) if (s.kind === "create") newest.set(s.view, s);
  const missing: string[] = [];
  for (const s of newest.values()) {
    if (!schemaComments(s.view)) continue;
    const restated = statements.some((c) => c.kind === "comment" && c.view === s.view && c.file === s.file && c.index > s.index);
    if (!restated) missing.push(`${s.file}: ${s.view} is created with no COMMENT ON VIEW after it, and CREATE OR REPLACE VIEW drops the comment: write a NEW migration, sorting after ${s.file}, that restates the view and then its COMMENT ON VIEW; do not edit ${s.file}, production has already run it`);
  }
  return missing;
}

/**
 * Views a migration creates that the schema no longer declares and no later
 * migration drops: a deployed store would keep them. For each view named by a
 * CREATE or DROP and absent from the schema, the newest of those statements
 * must be a DROP.
 */
export function createdAndNeverDropped(statements: ViewStatement[], schemaViews: ReadonlySet<string>): string[] {
  const order = (a: ViewStatement, b: ViewStatement) => (a.file === b.file ? a.index - b.index : a.file < b.file ? -1 : 1);
  const newest = new Map<string, ViewStatement>();
  for (const s of [...statements].sort(order)) if (s.kind !== "comment") newest.set(s.view, s);
  return [...newest.values()]
    .filter((s) => s.kind === "create" && !schemaViews.has(s.view))
    .map((s) => `${s.view}: ${s.file} creates it, neither schema/ nor ingest/ declares it any more and no later migration drops it: write a NEW migration, sorting after ${s.file}, with DROP VIEW ${s.view}; do not edit ${s.file}, production has already run it`);
}
