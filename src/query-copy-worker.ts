import {
  DuckDBDateValue,
  DuckDBTimestampValue,
  DuckDBTypeId,
  JsonDuckDBValueConverter,
  StatementType,
  type DuckDBConnection,
  type DuckDBPreparedStatement,
  type DuckDBValueConverter,
  type Json,
} from "@duckdb/node-api";
import { writeFileSync } from "node:fs";
import { openQueryCopy } from "./db.js";
import type { QueryColumn, QueryCopyErrorCode } from "./query-copy.js";

/**
 * The child process that answers one query (beeline-pnqr.4); the parent that
 * starts it, limits it and kills it is src/query-copy.ts, which has the reasons
 * for the process. In short: DuckDB's memory limit, interrupt and parser are
 * not guarantees (one query reached 16 GB under a 256 MB limit, one ignored
 * interrupt for over 30 seconds, one statement crashed the process), so the
 * query runs where it can be killed without touching the app.
 *
 * One file, two halves, as in src/label-pdf-worker.ts: `executeQuery` is the
 * whole job and is exported so tests can call it in their own process, and the
 * entry at the bottom runs only in the child. It opens the copy and nothing
 * else, read-only; it never opens the live store, so ADR 0005's one-writer
 * rule is untouched.
 */

export interface WorkerRequest {
  /** The copy to open. */
  path: string;
  memoryLimit: string;
  sql: string;
  /** Answer with the plan, by prefixing EXPLAIN, never EXPLAIN ANALYZE, which runs the statement. */
  explain: boolean;
  maxRows: number;
  maxBytes: number;
  /** A text or blob value larger than this is replaced by a note saying how large it was. */
  maxCellBytes: number;
}

export type WorkerReply =
  | { ok: true; columns: QueryColumn[]; rows: Json[][]; truncatedBy: "rows" | "bytes" | null }
  | { ok: false; code: QueryCopyErrorCode; message: string };

class Refusal extends Error {
  constructor(
    readonly code: QueryCopyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** `YYYY-MM-DD hh:mm:ss[.ffffff]`, DuckDB's text for a timestamp with no zone, as ISO 8601 in UTC. Anything else (infinity, BC) keeps DuckDB's text. */
function isoFromNaive(text: string): string {
  return /^\d{4,}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
}

/**
 * The one rule for values, so that JSON.stringify can carry every result:
 *
 *  - Integers: a JSON number when it is a safe integer (within 2^53 - 1),
 *    otherwise a decimal string. This is judged per value, so a BIGINT column
 *    can hold both; types up to INTEGER are always numbers.
 *  - DECIMAL: a JSON number when the column is at most 15 digits wide, since
 *    a double then shows every digit exactly (`12.50` arrives as 12.5);
 *    wider columns arrive as exact decimal strings.
 *  - FLOAT and DOUBLE: a number, or the string "NaN", "Infinity" or "-Infinity".
 *  - DATE: `YYYY-MM-DD`, or "infinity" or "-infinity". A TIMESTAMP, which means
 *    UTC in this store, is `YYYY-MM-DDTHH:MM:SS[.ffffff]Z`; a TIMESTAMPTZ is the
 *    same instant written in UTC, from DuckDB's own text for it and never
 *    through JavaScript's Date, so no year is out of range. A value that has no
 *    such form (infinity, before year 1) keeps DuckDB's text, which is UTC.
 *  - LIST and ARRAY: a JSON array; STRUCT: an object; MAP: an array of
 *    `{key, value}`; the elements follow these rules too.
 *  - BLOB: lowercase hexadecimal, without a prefix.
 *  - Everything else (text, UUID, TIME, ENUM, BIT, INTERVAL): as the
 *    library's own JSON conversion writes it.
 */
export const jsonValue: DuckDBValueConverter<Json> = (value, type, converter) => {
  if (value === null || value === undefined) return null;
  switch (type.typeId) {
    case DuckDBTypeId.BIGINT:
    case DuckDBTypeId.UBIGINT:
    case DuckDBTypeId.HUGEINT:
    case DuckDBTypeId.UHUGEINT:
    case DuckDBTypeId.BIGNUM: {
      const n = BigInt(value as bigint);
      return n >= -MAX_SAFE && n <= MAX_SAFE ? Number(n) : n.toString();
    }
    case DuckDBTypeId.DECIMAL: {
      const text = String(value);
      return (type as { width: number }).width <= 15 ? Number(text) : text;
    }
    case DuckDBTypeId.DATE: {
      const date = value as DuckDBDateValue;
      return date.isFinite ? date.toString() : date.days > 0 ? "infinity" : "-infinity";
    }
    case DuckDBTypeId.TIMESTAMP:
    case DuckDBTypeId.TIMESTAMP_S:
    case DuckDBTypeId.TIMESTAMP_MS:
    case DuckDBTypeId.TIMESTAMP_NS:
      return isoFromNaive(String(value));
    case DuckDBTypeId.TIMESTAMP_TZ: {
      // The library's own text for a TIMESTAMPTZ uses the machine's zone. The
      // instant's microseconds, read as a TIMESTAMP, are the same wall clock in UTC.
      const naive = new DuckDBTimestampValue((value as { micros: bigint }).micros);
      return naive.isFinite ? isoFromNaive(naive.toString()) : naive.toString();
    }
    case DuckDBTypeId.BLOB:
      return Buffer.from((value as { bytes: Uint8Array }).bytes).toString("hex");
    default:
      return JsonDuckDBValueConverter(value, type, converter);
  }
};

/** A column's expression in the projection that guards against one enormous value; null when the column needs none. */
function guard(i: number, type: { typeId: DuckDBTypeId; toString(): string }, maxCellBytes: number): string | null {
  const c = `"c${i}"`;
  const size = type.typeId === DuckDBTypeId.VARCHAR ? `strlen(${c})` : `octet_length(${c})`;
  const note = `concat('[', ${size}, ' bytes: too large to return]')`;
  if (type.typeId === DuckDBTypeId.VARCHAR) {
    return `CASE WHEN ${size} > ${maxCellBytes} THEN ${note} ELSE ${c} END`;
  }
  if (type.typeId === DuckDBTypeId.BLOB) {
    return `CASE WHEN ${size} > ${maxCellBytes} THEN ${note} ELSE lower(hex(${c})) END`;
  }
  // The library builds a struct as a plain object and so loses a field named
  // __proto__; DuckDB's own JSON keeps it, and JSON.parse makes it an own property.
  if (type.toString().includes("__proto__")) return `to_json(${c})::VARCHAR`;
  return null;
}

async function prepareOne(conn: DuckDBConnection, sql: string): Promise<DuckDBPreparedStatement> {
  let statements;
  try {
    statements = await conn.extractStatements(sql);
  } catch (err) {
    if (/^(\s|--[^\n]*(\n|$))*$/.test(sql)) throw new Refusal("empty", "The query is empty.");
    throw new Refusal("sql", messageOf(err));
  }
  if (statements.count !== 1) {
    throw new Refusal("not-one-statement", `Send exactly one statement; this has ${statements.count}.`);
  }
  try {
    return await statements.prepare(0);
  } catch (err) {
    throw new Refusal("sql", messageOf(err));
  }
}

/**
 * Open the copy, run the one statement, read the answer up to the limits, and
 * close everything. `bypassKindCheck` exists for tests that must show what the
 * layers underneath refuse when the check on the statement's kind has been
 * got past; the child never sets it.
 */
export async function executeQuery(req: WorkerRequest, opts: { bypassKindCheck?: boolean } = {}): Promise<WorkerReply> {
  let instance;
  try {
    instance = await openQueryCopy(req.path, { memoryLimit: req.memoryLimit });
  } catch (err) {
    return { ok: false, code: "copy-unreadable", message: `The copy of the store could not be opened: ${messageOf(err)}` };
  }
  let conn: DuckDBConnection | null = null;
  let result: Awaited<ReturnType<DuckDBConnection["stream"]>> | null = null;
  try {
    conn = await instance.connect();
    let prepared = await prepareOne(conn, req.sql);
    // Only a plain SELECT. EXPLAIN ANALYZE is typed EXPLAIN and executes what
    // it wraps, so `EXPLAIN ANALYZE COPY (...) TO '<the copy>'` is a write.
    if (prepared.statementType !== StatementType.SELECT && opts.bypassKindCheck !== true) {
      const kind = StatementType[prepared.statementType] ?? String(prepared.statementType);
      prepared.destroySync();
      throw new Refusal("not-allowed", `Only SELECT statements are allowed, not ${kind}. (For a plan, ask for one.)`);
    }
    const columns: QueryColumn[] = [];
    for (let i = 0; i < prepared.columnCount; i++) {
      columns.push({ name: prepared.columnName(i), type: prepared.columnType(i).toString() });
    }
    const parseAsJson = new Set<number>();
    if (req.explain) {
      // The prefix is ours and is not ANALYZE; check that what it made is still one plan.
      prepared.destroySync();
      prepared = await prepareOne(conn, `EXPLAIN ${req.sql}`);
      if (prepared.statementType !== StatementType.EXPLAIN) {
        prepared.destroySync();
        throw new Refusal("not-allowed", "That statement cannot be explained.");
      }
      columns.length = 0;
      for (let i = 0; i < prepared.columnCount; i++) {
        columns.push({ name: prepared.columnName(i), type: prepared.columnType(i).toString() });
      }
    } else if (prepared.statementType === StatementType.SELECT) {
      const exprs: string[] = [];
      let guarded = false;
      for (let i = 0; i < prepared.columnCount; i++) {
        const g = guard(i, prepared.columnType(i), req.maxCellBytes);
        if (g !== null) guarded = true;
        if (g?.startsWith("to_json")) parseAsJson.add(i);
        exprs.push(g === null ? `"c${i}"` : `${g} AS "c${i}"`);
      }
      if (guarded) {
        prepared.destroySync();
        // A trailing semicolon, and any comment after it, cannot sit inside the parentheses.
        const inner = req.sql.replace(/(\s|;|--[^\n]*(\n|$))+$/, "");
        const wrapped = `SELECT ${exprs.join(", ")} FROM (${inner}\n) AS q(${columns.map((_, i) => `"c${i}"`).join(", ")})`;
        prepared = await prepareOne(conn, wrapped);
        if (prepared.statementType !== StatementType.SELECT) {
          prepared.destroySync();
          throw new Refusal("not-allowed", "That statement cannot be limited in size.");
        }
      }
    }
    result = await prepared.stream();
    const rows: Json[][] = [];
    let truncatedBy: "rows" | "bytes" | null = null;
    let bytes = 0;
    reading: for await (const chunk of result.yieldConvertedRows(jsonValue)) {
      for (const row of chunk) {
        if (rows.length >= req.maxRows) {
          truncatedBy = "rows";
          break reading;
        }
        const out = row as Json[];
        for (const i of parseAsJson) if (typeof out[i] === "string") out[i] = JSON.parse(out[i] as string) as Json;
        const size = JSON.stringify(out).length;
        if (bytes + size > req.maxBytes) {
          truncatedBy = "bytes";
          break reading;
        }
        bytes += size;
        rows.push(out);
      }
    }
    return { ok: true, columns, rows, truncatedBy };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, code: err.code, message: err.message };
    return { ok: false, code: "sql", message: messageOf(err) };
  } finally {
    result?.closeSync();
    conn?.closeSync();
    instance.closeSync();
  }
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error: /, "");
}

/** The argument that makes this module run as the child rather than be imported. */
export const WORKER_FLAG = "--beeline-query-copy-worker";

if (process.argv.includes(WORKER_FLAG) && typeof process.send === "function") {
  // Ask the kernel to kill this process before the app if the machine runs short of memory.
  try {
    writeFileSync("/proc/self/oom_score_adj", "1000");
  } catch {
    // Not Linux, or not allowed.
  }
  // If the app goes away there is nobody to answer.
  process.on("disconnect", () => process.exit(1));
  process.once("message", (request: WorkerRequest) => {
    void executeQuery(request).then((reply) => process.send!(reply, () => process.exit(0)));
  });
}
