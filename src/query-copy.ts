import {
  DuckDBTypeId,
  JsonDuckDBValueConverter,
  StatementType,
  type DuckDBConnection,
  type DuckDBInstance,
  type DuckDBValueConverter,
  type Json,
} from "@duckdb/node-api";
import { stat } from "node:fs/promises";
import { openQueryCopy } from "./db.js";

/**
 * Run one SQL statement against last night's copy of the store
 * (beeline-pnqr.4), for the quick lookups staff and Claude otherwise download
 * a backup to answer.
 *
 * It does not run on the live store, for two reasons found by test on DuckDB
 * 2.0.0. A SELECT there can call `nextval`, and a sequence does not go back
 * when the transaction is rolled back, so a query could use up `entity_id_seq`
 * (whose ids are 32-bit) and stop every insert on a store that is never
 * reseeded. And a write inside a WITH clause is typed SELECT. So the nightly
 * backup job leaves a plain copy beside the store (`keepQueryCopy` in
 * src/store-backup.ts) and this module opens it as a second DuckDB instance in
 * the same process, with the settings in `openQueryCopy` (src/db.ts): read-only,
 * no file or extension access, a memory ceiling, one thread, and the
 * configuration locked. The data is up to a day old.
 *
 * What stands between a statement and the copy, each with a test:
 *
 *  1. Exactly one statement, counted by DuckDB's own statement extraction
 *     rather than by looking for semicolons.
 *  2. Only SELECT and EXPLAIN. Everything else (SET, ATTACH, COPY, LOAD,
 *     INSTALL, CREATE, PRAGMA, CALL, INSERT inside or outside a WITH) is
 *     refused before it runs, naming its kind.
 *  3. The instance itself refuses what slips past 1 and 2: `nextval` and a
 *     write in a WITH clause fail on a read-only database, `read_text` and
 *     `read_csv` fail with external access off, and a `SET` fails on a locked
 *     configuration.
 *  4. A time limit, enforced by interrupting the connection, and a cap on the
 *     rows returned, enforced by reading the result a chunk at a time and
 *     abandoning it, so a result of millions of rows is never held in Node.
 *  5. One query at a time. A second is refused, not queued.
 *
 * Each query gets a connection of its own, closed afterwards, so a temporary
 * table or a timed-out query cannot affect the next one.
 */

/** Why a query was not answered. `code` is stable; `message` is for a person. */
export type QueryCopyErrorCode =
  | "no-copy"
  | "busy"
  | "empty"
  | "not-one-statement"
  | "not-allowed"
  | "timeout"
  | "sql";

export class QueryCopyError extends Error {
  constructor(
    readonly code: QueryCopyErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "QueryCopyError";
  }
}

export interface QueryColumn {
  name: string;
  /** DuckDB's name for the type, such as `BIGINT`, `DECIMAL(10,2)` or `VARCHAR[]`. */
  type: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  /** One array per row, in column order, every value one that JSON can carry (see {@link jsonValue}). */
  rows: Json[][];
  /** True when the statement had more rows than `maxRows`, so these are only the first ones. */
  truncated: boolean;
  /** The limits this run was held to, so a caller can say them. */
  limits: { timeoutMs: number; maxRows: number };
  elapsedMs: number;
}

export interface QueryLimits {
  /** Milliseconds before the query is interrupted. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Rows after which the result is cut short. Default {@link DEFAULT_MAX_ROWS}. */
  maxRows?: number;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_ROWS = 5_000;
export const DEFAULT_MEMORY_LIMIT = "256MB";

/** The statement kinds that read. Any other is refused by name. */
const ALLOWED: ReadonlySet<StatementType> = new Set([StatementType.SELECT, StatementType.EXPLAIN]);

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

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
 *  - DATE: `YYYY-MM-DD`. A TIMESTAMP, which means UTC in this store, is
 *    `YYYY-MM-DDTHH:MM:SS[.ffffff]Z`; a TIMESTAMPTZ is the same instant written
 *    in UTC. A value DuckDB cannot write that way (infinity, before year 0)
 *    keeps DuckDB's own text.
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
    case DuckDBTypeId.TIMESTAMP:
    case DuckDBTypeId.TIMESTAMP_S:
    case DuckDBTypeId.TIMESTAMP_MS:
    case DuckDBTypeId.TIMESTAMP_NS: {
      // A wall-clock time with no zone, which this store means as UTC.
      const text = String(value);
      return /^\d{4,}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
    }
    case DuckDBTypeId.TIMESTAMP_TZ: {
      // From the instant itself: the library's own text uses the machine's zone.
      const micros = (value as { micros: bigint }).micros;
      return isoFromMicros(micros) ?? String(value);
    }
    case DuckDBTypeId.BLOB:
      return Buffer.from((value as { bytes: Uint8Array }).bytes).toString("hex");
    default:
      return JsonDuckDBValueConverter(value, type, converter);
  }
};

function isoFromMicros(micros: bigint): string | null {
  const wholeSeconds = micros / 1_000_000n - (micros % 1_000_000n < 0n ? 1n : 0n);
  const date = new Date(Number(wholeSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const fraction = String(micros - wholeSeconds * 1_000_000n)
    .padStart(6, "0")
    .replace(/0+$/, "");
  const base = date.toISOString().slice(0, 19);
  return fraction === "" ? `${base}Z` : `${base}.${fraction}Z`;
}

export interface QueryCopyOptions {
  /** The copy the nightly backup leaves (`queryCopyPath` in src/app/config.ts). */
  path: string;
  /** DuckDB's memory ceiling for the instance. Default {@link DEFAULT_MEMORY_LIMIT}. */
  memoryLimit?: string;
}

export interface QueryCopy {
  run(sql: string, limits?: QueryLimits): Promise<QueryResult>;
  /** Close the instance. A later `run` opens it again. */
  close(): void;
}

/**
 * The query runner for one copy. The instance is opened by the first query,
 * and reopened by the first query after the file at `path` has been replaced
 * (a different inode, modification time or size), closing the old one; the
 * backup job replaces it by rename, so the old file stays readable to the old
 * instance until then.
 */
export function createQueryCopy(options: QueryCopyOptions): QueryCopy {
  let open: { instance: DuckDBInstance; identity: string } | null = null;
  let running = false;

  const closeOpen = () => {
    if (open !== null) {
      try {
        open.instance.closeSync();
      } finally {
        open = null;
      }
    }
  };

  async function instanceFor(): Promise<DuckDBInstance> {
    let found;
    try {
      found = await stat(options.path);
    } catch (err) {
      closeOpen();
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new QueryCopyError(
          "no-copy",
          "There is no copy of the store to query yet: the nightly backup leaves one, and has not run here.",
        );
      }
      throw err;
    }
    const identity = `${found.dev}:${found.ino}:${found.mtimeMs}:${found.size}`;
    if (open !== null && open.identity !== identity) closeOpen();
    open ??= {
      instance: await openQueryCopy(options.path, { memoryLimit: options.memoryLimit ?? DEFAULT_MEMORY_LIMIT }),
      identity,
    };
    return open.instance;
  }

  return {
    close: closeOpen,
    async run(sql, limits = {}) {
      const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxRows = limits.maxRows ?? DEFAULT_MAX_ROWS;
      if (running) throw new QueryCopyError("busy", "Another query is running; try again when it has finished.");
      running = true;
      const started = Date.now();
      try {
        const instance = await instanceFor();
        const conn = await instance.connect();
        try {
          const result = await runOn(conn, sql, timeoutMs, maxRows);
          return { ...result, limits: { timeoutMs, maxRows }, elapsedMs: Date.now() - started };
        } finally {
          conn.closeSync();
        }
      } finally {
        running = false;
      }
    },
  };
}

async function runOn(
  conn: DuckDBConnection,
  sql: string,
  timeoutMs: number,
  maxRows: number,
): Promise<Pick<QueryResult, "columns" | "rows" | "truncated">> {
  let timedOut = false;
  // The clock covers planning and reading as well as executing: an interrupt
  // stops whichever of them is running.
  const timer = setTimeout(() => {
    timedOut = true;
    conn.interrupt();
  }, timeoutMs);
  let result: Awaited<ReturnType<DuckDBConnection["stream"]>> | null = null;
  try {
    const statements = await conn.extractStatements(sql).catch((err: unknown) => {
      if (sql.trim() === "" || /^(\s|--[^\n]*\n?)*$/.test(sql)) {
        throw new QueryCopyError("empty", "The query is empty.", { cause: err });
      }
      throw new QueryCopyError("sql", messageOf(err), { cause: err });
    });
    if (statements.count !== 1) {
      throw new QueryCopyError(
        "not-one-statement",
        `Send exactly one statement; this has ${statements.count}.`,
      );
    }
    const prepared = await statements.prepare(0);
    const kind = prepared.statementType;
    if (!ALLOWED.has(kind)) {
      prepared.destroySync();
      throw new QueryCopyError("not-allowed", `Only SELECT and EXPLAIN statements are allowed, not ${StatementType[kind] ?? kind}.`);
    }
    result = await prepared.stream();
    const columns = result.columnNames().map((name, i) => ({ name, type: result!.columnType(i).toString() }));
    const rows: Json[][] = [];
    let truncated = false;
    reading: for await (const chunk of result.yieldConvertedRows(jsonValue)) {
      for (const row of chunk) {
        if (rows.length >= maxRows) {
          truncated = true;
          break reading;
        }
        rows.push(row as Json[]);
      }
    }
    return { columns, rows, truncated };
  } catch (err) {
    if (err instanceof QueryCopyError) throw err;
    if (timedOut) {
      throw new QueryCopyError("timeout", `The query ran longer than ${timeoutMs / 1000} seconds and was stopped.`, { cause: err });
    }
    throw new QueryCopyError("sql", messageOf(err), { cause: err });
  } finally {
    clearTimeout(timer);
    // A result not read to the end holds the connection until it is closed.
    result?.closeSync();
  }
}

/** DuckDB's message without the node wrapper's prefix. */
function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/^Error: /, "");
}
