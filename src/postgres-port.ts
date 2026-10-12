import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * DuckDB SQL, rewritten for PostgreSQL.
 *
 * ADR 0001 keeps the schema close enough to portable that a move to Postgres
 * is "a port, not a rewrite". This module is that claim written down: every
 * DuckDB-only construct the SQL uses, each with the mechanical rewrite a port
 * would make. `pnpm db:check-postgres` applies `schema/*.sql` through it to a
 * real Postgres, so a construct with no rule here fails the check instead of
 * drifting in unnoticed (beeline-l6w).
 *
 * The rules are a list, not a parser. They work on a tree of tokens, so
 * strings, comments and quoted identifiers are never touched and a function
 * call is matched with its whole argument list, but they know nothing about
 * types. Where a rule needs to know an argument is JSON, it looks for the
 * `json_extract` that produced it, which is how every such site is written.
 *
 * The Postgres helpers the rules call (`beeline_try_cast_integer`,
 * `beeline_json_array`, …) are defined in `schema/postgres/prelude.sql`,
 * which is applied before the schema.
 *
 * Three of the rewrites fix a difference that would not have raised an
 * error, which is the kind ADR 0001 warns about (`~` was the first it found):
 *  - `\b` in a regular expression is a word boundary in DuckDB (RE2) and a
 *    backspace in Postgres, which spells the boundary `\y`.
 *  - `j ->> '$.name'` is a JSONPath in DuckDB. In Postgres it is a key that
 *    is literally `$.name`, which no object has, so it answers NULL.
 *  - `round(x, 4)` on a double prints `47.1` in DuckDB and, by way of the
 *    numeric Postgres needs for it, `47.1000`.
 */

export const POSTGRES_PRELUDE = fileURLToPath(new URL("../schema/postgres/prelude.sql", import.meta.url));

export function readPrelude(): Promise<string> {
  return readFile(POSTGRES_PRELUDE, "utf8");
}

/** Rewrite one DuckDB SQL text (any number of statements) for Postgres. */
export function toPostgres(sql: string): string {
  return render(rewrite(parse(tokenize(sql))));
}

/**
 * `?` placeholders numbered `$1`, `$2`, … as Postgres wants them. Only a `?`
 * outside strings, quoted identifiers and comments is a placeholder, so
 * `coalesce(ref, '?')` keeps its question mark.
 */
export function numberPlaceholders(sql: string): string {
  let k = 0;
  return tokenize(sql)
    .map((tok) => (tok.t === "op" ? tok.v.replace(/\?/g, () => `$${++k}`) : tok.v))
    .join("");
}

// ── Tokens ────────────────────────────────────────────────────────────────

type Token =
  | { t: "word"; v: string }
  | { t: "str"; v: string } // a whole literal, quotes included
  | { t: "ident"; v: string } // a whole "quoted identifier"
  | { t: "ws"; v: string } // whitespace, and a comment reduced to a space
  | { t: "op"; v: string }; // one operator or piece of punctuation

type Group = { t: "group"; children: Node[] };
type Node = Token | Group;

const OPERATOR_CHARS = "+-*/<>=~!@#%^&|`?:.";
const WORD_CHAR = /[A-Za-z_0-9$]/;

function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql.charAt(i);
    if (c === "-" && sql.charAt(i + 1) === "-") {
      while (i < sql.length && sql.charAt(i) !== "\n") i++;
      out.push({ t: "ws", v: " " });
    } else if (c === "/" && sql.charAt(i + 1) === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      out.push({ t: "ws", v: " " });
    } else if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error(`unterminated string literal at offset ${i}`);
        if (sql.charAt(j) === "'") {
          if (sql.charAt(j + 1) !== "'") break;
          j += 2;
        } else j++;
      }
      out.push({ t: "str", v: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end < 0) throw new Error(`unterminated quoted identifier at offset ${i}`);
      out.push({ t: "ident", v: sql.slice(i, end + 1) });
      i = end + 1;
    } else if (/\s/.test(c)) {
      let j = i;
      while (j < sql.length && /\s/.test(sql.charAt(j))) j++;
      out.push({ t: "ws", v: sql.slice(i, j) });
      i = j;
    } else if (WORD_CHAR.test(c)) {
      let j = i;
      while (j < sql.length && WORD_CHAR.test(sql.charAt(j))) j++;
      out.push({ t: "word", v: sql.slice(i, j) });
      i = j;
    } else if (OPERATOR_CHARS.includes(c)) {
      // A run of operator characters is one operator (`->>`, `::`, `<>`).
      let j = i;
      while (j < sql.length && OPERATOR_CHARS.includes(sql.charAt(j))) j++;
      out.push({ t: "op", v: sql.slice(i, j) });
      i = j;
    } else {
      // ( ) , ; [ ] and anything else stand alone.
      out.push({ t: "op", v: c });
      i++;
    }
  }
  return out;
}

function parse(tokens: Token[]): Node[] {
  let i = 0;
  function seq(inGroup: boolean): Node[] {
    const nodes: Node[] = [];
    for (let tok = tokens[i++]; tok !== undefined; tok = tokens[i++]) {
      if (tok.t === "op" && tok.v === "(") nodes.push({ t: "group", children: seq(true) });
      else if (tok.t === "op" && tok.v === ")") {
        if (!inGroup) throw new Error("unbalanced ')'");
        return nodes;
      } else nodes.push(tok);
    }
    if (inGroup) throw new Error("unbalanced '('");
    return nodes;
  }
  return seq(false);
}

function render(nodes: Node[]): string {
  return nodes.map((n) => (n.t === "group" ? `(${render(n.children)})` : n.v)).join("");
}

// ── Reading nodes ─────────────────────────────────────────────────────────

const isWord = (n: Node | undefined, w: string): boolean =>
  n !== undefined && n.t === "word" && n.v.toLowerCase() === w.toLowerCase();

const isOp = (n: Node | undefined, v: string): boolean => n !== undefined && n.t === "op" && n.v === v;

/** Index of the next node that is not whitespace, at or after `i`. */
function nextSolid(nodes: Node[], i: number): number {
  while (nodes[i]?.t === "ws") i++;
  return i;
}

function trimNodes(nodes: Node[]): Node[] {
  let a = 0;
  let b = nodes.length;
  while (a < b && nodes[a]?.t === "ws") a++;
  while (b > a && nodes[b - 1]?.t === "ws") b--;
  return nodes.slice(a, b);
}

/** A group's children split at top-level commas, each trimmed of whitespace. */
function splitArgs(children: Node[]): Node[][] {
  const args: Node[][] = [[]];
  for (const n of children) {
    if (isOp(n, ",")) args.push([]);
    else args[args.length - 1]!.push(n);
  }
  const trimmed = args.map(trimNodes);
  return trimmed.length === 1 && trimmed[0]!.length === 0 ? [] : trimmed;
}

/** Split `expr AS type` at its last top-level AS. */
function splitCast(children: Node[]): { expr: Node[]; type: Node[] } | null {
  for (let k = children.length - 1; k >= 0; k--) {
    if (isWord(children[k], "AS")) {
      return { expr: trimNodes(children.slice(0, k)), type: trimNodes(children.slice(k + 1)) };
    }
  }
  return null;
}

/** The single function call `nodes` consists of, if that is all it is. */
function asCall(nodes: Node[]): { name: string; args: Node[][] } | null {
  const [name, group, ...rest] = trimNodes(nodes);
  if (rest.length > 0 || name?.t !== "word" || group?.t !== "group") return null;
  return { name: name.v.toLowerCase(), args: splitArgs(group.children) };
}

function containsCall(nodes: Node[], name: string): boolean {
  return nodes.some((n, k) =>
    n.t === "group" ? containsCall(n.children, name) : isWord(n, name) && nodes[nextSolid(nodes, k + 1)]?.t === "group",
  );
}

const sqlString = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function literalValue(nodes: Node[]): string | null {
  const [only, ...rest] = trimNodes(nodes);
  return only?.t === "str" && rest.length === 0 ? only.v.slice(1, -1).replace(/''/g, "'") : null;
}

/** `'$.geojson.coordinates[1]'` → `'{geojson,coordinates,1}'`, a Postgres path. */
function jsonPath(arg: Node[]): string {
  const path = literalValue(arg);
  if (path === null || !/^\$(?:\.[A-Za-z_]\w*|\[\d+\])*$/.test(path)) {
    throw new Error(`a JSON path must be a '$.key[n]…' literal to be ported, got ${render(arg)}`);
  }
  const parts = [...path.matchAll(/\.([A-Za-z_]\w*)|\[(\d+)\]/g)].map((m) => m[1] ?? m[2]);
  return sqlString(`{${parts.join(",")}}`);
}

/** RE2's word boundary, spelled the Postgres way. */
const wordBoundary = (pattern: string): string => pattern.replace(/\\b/g, "\\y");

function typeName(type: Node[]): string {
  return render(type).trim().replace(/\s+/g, " ");
}

// ── The rules ─────────────────────────────────────────────────────────────

const INTERVAL_UNIT = /^(microsecond|millisecond|second|minute|hour|day|week|month|year)s?$/i;

function rewrite(nodes: Node[]): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const replaced = rewriteAt(nodes, i);
    if (replaced) {
      out.push({ t: "word", v: replaced.text });
      i = replaced.last;
    } else if (n.t === "group") {
      out.push({ t: "group", children: rewrite(n.children) });
    } else {
      out.push(n);
    }
  }
  return out;
}

/** The rewrite of the construct starting at `nodes[i]`, and where it ends, if a rule applies. */
function rewriteAt(nodes: Node[], i: number): { text: string; last: number } | null {
  const n = nodes[i]!;

  // j ->> '$.key'  →  j #>> '{key}'
  if (n.t === "op" && (n.v === "->>" || n.v === "->")) {
    const litAt = nextSolid(nodes, i + 1);
    const lit = nodes[litAt];
    if (lit?.t === "str" && lit.v.startsWith("'$")) {
      return { text: `${n.v === "->>" ? "#>>" : "#>"} ${jsonPath([lit])}`, last: litAt };
    }
    return null;
  }
  if (n.t !== "word") return null;
  const word = n.v.toLowerCase();
  const after = nextSolid(nodes, i + 1);

  if (word === "create") return rewriteCreate(nodes, i);

  // INTERVAL 30 DAY → INTERVAL '30 day'; INTERVAL (expr) UNIT → (expr) * INTERVAL '1 unit'
  if (word === "interval") {
    const amount = nodes[after];
    const unitAt = nextSolid(nodes, after + 1);
    const unit = nodes[unitAt];
    if (unit?.t !== "word" || !INTERVAL_UNIT.test(unit.v)) return null;
    if (amount?.t === "word" && /^\d+$/.test(amount.v)) {
      return { text: `INTERVAL '${amount.v} ${unit.v.toLowerCase()}'`, last: unitAt };
    }
    if (amount?.t === "group") {
      return { text: `((${render(rewrite(amount.children))}) * INTERVAL '1 ${unit.v.toLowerCase()}')`, last: unitAt };
    }
    return null;
  }

  // DOUBLE → DOUBLE PRECISION: DuckDB takes both, Postgres only the second.
  if (word === "double" && !isWord(nodes[after], "PRECISION")) return { text: "DOUBLE PRECISION", last: i };
  // JSON → JSONB, which the extraction operators and casts below want. Upper
  // case only: that is how the schema writes the type, and a lower-case
  // `json` is more likely a name.
  if (n.v === "JSON" && nodes[after]?.t !== "group") return { text: "JSONB", last: i };

  const call = nodes[after];
  if (call?.t === "group") {
    const text = rewriteCall(word, call.children, nodes, after);
    if (text !== null) return { text, last: after };
  }
  return null;
}

function rewriteCreate(nodes: Node[], i: number): { text: string; last: number } | null {
  let k = nextSolid(nodes, i + 1);
  let orReplace = false;
  if (isWord(nodes[k], "OR")) {
    k = nextSolid(nodes, nextSolid(nodes, k + 1) + 1);
    orReplace = true;
  }

  // CREATE OR REPLACE TEMP TABLE t AS … → DROP TABLE IF EXISTS t; CREATE TEMP TABLE t AS …
  if (orReplace && (isWord(nodes[k], "TEMP") || isWord(nodes[k], "TEMPORARY"))) {
    const tableAt = nextSolid(nodes, k + 1);
    const nameAt = nextSolid(nodes, tableAt + 1);
    const name = nodes[nameAt];
    if (isWord(nodes[tableAt], "TABLE") && name?.t === "word") {
      return { text: `DROP TABLE IF EXISTS ${name.v}; CREATE TEMP TABLE ${name.v}`, last: nameAt };
    }
    return null;
  }

  // CREATE [OR REPLACE] MACRO name() AS expr; → an SQL function.
  if (isWord(nodes[k], "MACRO")) {
    const nameAt = nextSolid(nodes, k + 1);
    const paramsAt = nextSolid(nodes, nameAt + 1);
    const asAt = nextSolid(nodes, paramsAt + 1);
    const name = nodes[nameAt];
    const params = nodes[paramsAt];
    if (name?.t !== "word" || params?.t !== "group" || !isWord(nodes[asAt], "AS")) {
      throw new Error("unrecognised CREATE MACRO");
    }
    if (trimNodes(params.children).length > 0) throw new Error("a MACRO with parameters has no port rule yet");
    let end = asAt + 1;
    while (end < nodes.length && !isOp(nodes[end], ";")) end++;
    const body = render(rewrite(trimNodes(nodes.slice(asAt + 1, end))));
    // A macro's type is its body's; the one macro there is returns a
    // pattern, so text. A second macro would need saying so here.
    return {
      text: `CREATE ${orReplace ? "OR REPLACE " : ""}FUNCTION ${name.v}() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT ${body} $$`,
      last: end - 1,
    };
  }
  return null;
}

function rewriteCall(name: string, children: Node[], siblings: Node[], callAt: number): string | null {
  const args = splitArgs(children);
  const arg = (k: number): Node[] => {
    const a = args[k];
    if (a === undefined) throw new Error(`${name} needs at least ${k + 1} arguments to be ported`);
    return a;
  };
  const r = (nodes: Node[]): string => render(rewrite(nodes));
  const regex = (nodes: Node[]): string => {
    const value = literalValue(nodes);
    return value === null ? r(nodes) : sqlString(wordBoundary(value));
  };

  switch (name) {
    case "cast": {
      const parts = splitCast(children);
      if (!parts) return null;
      const array = /^(.*?)\s*\[\]$/.exec(typeName(parts.type));
      // CAST(<json> AS T[]): Postgres casts no JSON to an array.
      if (array && containsCall(parts.expr, "json_extract")) {
        return array[1]!.toUpperCase() === "JSON"
          ? `beeline_json_array(${r(parts.expr)})`
          : `CAST(beeline_json_array_text(${r(parts.expr)}) AS ${r(parts.type)})`;
      }
      // CAST(json_extract(x, p) AS scalar): extract as text and cast that,
      // since Postgres cannot cast a jsonb null to a scalar.
      const inner = asCall(parts.expr);
      if (inner?.name === "json_extract" && !array) {
        const [x, p] = inner.args;
        if (!x || !p) throw new Error("json_extract needs two arguments to be ported");
        return `CAST((${r(x)} #>> ${jsonPath(p)}) AS ${r(parts.type)})`;
      }
      return null;
    }
    case "json_extract":
      return `(${r(arg(0))} #> ${jsonPath(arg(1))})`;
    case "json_extract_string":
      return `(${r(arg(0))} #>> ${jsonPath(arg(1))})`;
    case "try_cast": {
      const parts = splitCast(children);
      if (!parts) throw new Error("try_cast without AS");
      const type = typeName(parts.type).toLowerCase().replace(/ /g, "_");
      return `beeline_try_cast_${type}(CAST(${r(parts.expr)} AS text))`;
    }
    case "regexp_matches": {
      const flags = args[2] ? (literalValue(args[2]) ?? "") : "";
      return `(${r(arg(0))} ${flags.includes("i") ? "~*" : "~"} ${regex(arg(1))})`;
    }
    case "regexp_full_match": {
      const lit = literalValue(arg(1));
      const pattern = lit !== null ? sqlString(`^(?:${wordBoundary(lit)})$`) : `concat('^(?:', ${r(arg(1))}, ')$')`;
      return `(${r(arg(0))} ~ ${pattern})`;
    }
    case "regexp_replace":
      return `regexp_replace(${r(arg(0))}, ${regex(arg(1))}, ${r(arg(2))}${args[3] ? `, ${r(args[3])}` : ""})`;
    case "regexp_extract": {
      // DuckDB answers '' where nothing matches, and its group 0 is the match.
      const group = args[2] ? `(${r(args[2])}) + 1` : "1";
      return `coalesce((regexp_match(${r(arg(0))}, concat('(', ${regex(arg(1))}, ')')))[${group}], '')`;
    }
    case "round":
      // Postgres rounds a double to n places only by way of numeric, which
      // then prints its trailing zeros; back to a double, so both print alike.
      return args.length === 2 ? `CAST(round(CAST(${r(arg(0))} AS numeric), ${r(arg(1))}) AS double precision)` : null;
    case "str_split":
    case "string_split":
      return `string_to_array(${r(arg(0))}, ${r(arg(1))})`;
    case "str_split_regex":
    case "string_split_regex":
      return `regexp_split_to_array(${r(arg(0))}, ${regex(arg(1))})`;
    case "list":
      return `array_agg(${r(children)})`;
    case "list_sort": {
      const inner = asCall(arg(0));
      const x = inner?.name === "list" ? inner.args[0] : undefined;
      if (x) return `array_agg(${r(x)} ORDER BY ${r(x)})`;
      return `ARRAY(SELECT x FROM unnest(${r(arg(0))}) x ORDER BY x)`;
    }
    case "list_contains":
      return `(${r(arg(1))} = ANY(${r(arg(0))}))`;
    case "arg_min":
    case "arg_max": {
      if (isWord(siblings[nextSolid(siblings, callAt + 1)], "OVER")) {
        throw new Error(`${name} as a window function has no port rule yet`);
      }
      const dir = name === "arg_min" ? "ASC" : "DESC";
      return `(array_agg(${r(arg(0))} ORDER BY ${r(arg(1))} ${dir}) FILTER (WHERE ${r(arg(1))} IS NOT NULL))[1]`;
    }
    default:
      return null;
  }
}
