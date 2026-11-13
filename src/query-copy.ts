import type { Json } from "@duckdb/node-api";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_FLAG, type WorkerReply, type WorkerRequest } from "./query-copy-worker.js";

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
 * src/store-backup.ts), and a query reads that. The data is up to a day old,
 * and every result says when the copy was made (`copiedAt`).
 *
 * It does not run inside the app's process either. Review found three ways a
 * query could hurt the app that no DuckDB setting prevents: a query reached
 * 16 GB of memory under a 256 MB `memory_limit`; one ignored `interrupt` for
 * over 30 seconds, so a time limit that relies on it never ends; and a
 * statement of 50,000 nested subqueries crashed the process. So each query runs
 * in a child process of its own (src/query-copy-worker.ts, started as
 * src/label-pdf-worker.ts is, under tsx), which this module kills:
 *
 *  - at the time limit, with SIGKILL, so nothing depends on the query's help;
 *  - when its resident memory passes a ceiling, checked every 50 ms from
 *    /proc (where there is no /proc there is no memory watchdog, and the time
 *    limit and the kernel remain);
 *  - and the kernel is asked to kill it first if the machine runs short
 *    (`oom_score_adj` 1000).
 *
 * A child that dies without answering becomes a `timeout`, `memory` or
 * `crashed` error here; the app is untouched and the next query starts a fresh
 * child. One query runs at a time, and `busy` clears when the child has
 * exited, which a kill guarantees. A process costs a start-up on every query
 * (measured in docs/architecture/backups.md), which a lookup tool can pay.
 *
 * The child gets a minimal environment, so none of the app's secrets are in
 * a process that runs a stranger's SQL. It opens only the copy, read-only;
 * ADR 0005's one-writer rule is untouched.
 *
 * What stands between a statement and the copy, each with a test:
 *
 *  1. The parent refuses, before spawning, a statement over 20,000
 *     characters (a 6 MB one took 4.8 GB to parse), one containing a NUL, and
 *     limits that are not whole numbers within bounds.
 *  2. The child counts statements with DuckDB's own extraction, and accepts
 *     only a SELECT. Not EXPLAIN: `EXPLAIN ANALYZE` runs what it wraps, and
 *     `EXPLAIN ANALYZE COPY (...) TO '<the copy>'` overwrote it, because DuckDB
 *     keeps the database file and its `.wal*` paths open with external access
 *     off. A plan is asked for with `explain: true`, which prefixes EXPLAIN.
 *  3. The instance refuses what slips past: read-only, no external access, no
 *     extension loading, configuration locked (src/db.ts, `openQueryCopy`).
 *  4. The copy is in a folder of its own, mode 0500, and the file 0400
 *     (`keepQueryCopy`), so even a write that reached the operating system
 *     fails, except when the app runs as root.
 *  5. Rows and bytes of result are capped as they are read.
 */

/** Why a query was not answered. `code` is stable; `message` is for a person. */
export type QueryCopyErrorCode =
  | "no-copy"
  | "copy-unreadable"
  | "busy"
  | "invalid"
  | "empty"
  | "not-one-statement"
  | "not-allowed"
  | "timeout"
  | "memory"
  | "crashed"
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
  /** One array per row, in column order, every value one that JSON can carry (see `jsonValue` in src/query-copy-worker.ts). */
  rows: Json[][];
  /** True when the answer was cut short: there was more than `maxRows` rows or `maxBytes` bytes. */
  truncated: boolean;
  /** Which limit cut it short, or null. */
  truncatedBy: "rows" | "bytes" | null;
  /** When the copy was made (the file's modification time), since a failed night leaves an older copy in place. */
  copiedAt: string;
  limits: { timeoutMs: number; maxRows: number; maxBytes: number };
  elapsedMs: number;
}

export interface QueryLimits {
  /** Milliseconds before the child is killed: a whole number from 100 to 60,000. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Rows after which the result is cut short: a whole number from 1 to 50,000. Default {@link DEFAULT_MAX_ROWS}. */
  maxRows?: number;
  /** Bytes of JSON after which it is cut short: a whole number from 1,000 to 50 million. Default {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /** Answer with the query plan instead of the rows. It never runs the statement (no ANALYZE). */
  explain?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_ROWS = 5_000;
export const DEFAULT_MAX_BYTES = 5_000_000;
export const DEFAULT_MEMORY_LIMIT = "256MB";
/** Resident memory of the child above which it is killed. The DuckDB limit above is a request; this is the enforcement. */
export const DEFAULT_RSS_LIMIT_BYTES = 768 * 1024 * 1024;
export const MAX_STATEMENT_CHARS = 20_000;
/** A text or blob value larger than this is replaced by a note. */
export const MAX_CELL_BYTES = 1_000_000;

export interface QueryCopyOptions {
  /** The copy the nightly backup leaves (`queryCopyPath` in src/app/config.ts). */
  path: string;
  /** DuckDB's memory ceiling inside the child. Default {@link DEFAULT_MEMORY_LIMIT}. */
  memoryLimit?: string;
  /** Resident memory at which the child is killed. Default {@link DEFAULT_RSS_LIMIT_BYTES}. */
  rssLimitBytes?: number;
  /** The longest statement accepted. Default {@link MAX_STATEMENT_CHARS}; tests raise it. */
  maxStatementChars?: number;
  /** The module the child runs. Tests substitute one to look at the child's environment. */
  workerModule?: string;
}

export interface QueryCopy {
  run(sql: string, limits?: QueryLimits): Promise<QueryResult>;
}

const WORKER_MODULE = fileURLToPath(new URL("./query-copy-worker.ts", import.meta.url));

/**
 * What the child is given of the app's environment: what node and the
 * operating system need, and nothing else (HOME is there because DuckDB finds
 * its extensions under it, and without it cannot set the session's time zone), so a secret (BEELINE_DRIVE_KEY,
 * INAT_*, the Sentry DSN) is not in a process that runs somebody's SQL.
 */
/** An explicit list: NODE_AUTH_TOKEN and its like are NODE_* too. */
const CHILD_ENVIRONMENT = ["PATH", "HOME", "TZ", "TMPDIR", "NODE_ENV", "NODE_OPTIONS", "NODE_PATH"];

export function workerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && CHILD_ENVIRONMENT.includes(key)) {
      kept[key] = value;
    }
  }
  return kept;
}

/** As src/label-pdf-worker.ts: the child needs tsx to read TypeScript, which the app's own `node --import tsx` already has. */
function workerExecArgv(): string[] {
  const loaded = process.execArgv.some((arg) => arg === "tsx" || arg.includes("tsx/"));
  return loaded ? process.execArgv : [...process.execArgv, "--import", "tsx"];
}

const wholeNumber = (name: string, value: number, min: number, max: number) => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new QueryCopyError("invalid", `${name} must be a whole number from ${min} to ${max}, not ${String(value)}.`);
  }
};

/**
 * Whether two paths name files that must not both be the query copy and
 * something else: the same file, or a WAL file DuckDB would put beside it.
 * Compared as written; callers pass real paths where they can. Returns what
 * the target collides with, or null.
 */
export function queryCopyConflict(target: string, protectedPaths: string[]): string | null {
  const suffixes = ["", ".wal", ".wal.checkpoint", ".wal.recovery", ".tmp"];
  const t = resolve(target);
  for (const p of protectedPaths) {
    for (const suffix of suffixes) {
      if (t === resolve(`${p}${suffix}`)) return `${p}${suffix}`;
    }
  }
  return null;
}

export function createQueryCopy(options: QueryCopyOptions): QueryCopy {
  let running = false;
  const rssLimit = options.rssLimitBytes ?? DEFAULT_RSS_LIMIT_BYTES;
  const maxChars = options.maxStatementChars ?? MAX_STATEMENT_CHARS;

  return {
    async run(sql, limits = {}) {
      const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxRows = limits.maxRows ?? DEFAULT_MAX_ROWS;
      const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
      if (typeof sql !== "string") throw new QueryCopyError("invalid", "The query must be text.");
      if (sql.length > maxChars) {
        throw new QueryCopyError("invalid", `The query is ${sql.length} characters; the most accepted is ${maxChars}.`);
      }
      if (sql.includes("\0")) throw new QueryCopyError("invalid", "The query contains a NUL character.");
      wholeNumber("maxRows", maxRows, 1, 50_000);
      wholeNumber("timeoutMs", timeoutMs, 100, 60_000);
      wholeNumber("maxBytes", maxBytes, 1_000, 50_000_000);
      if (running) throw new QueryCopyError("busy", "Another query is running; try again when it has finished.");
      running = true;
      try {
        const started = Date.now();
        try {
          // Only to tell a missing copy from an unreadable one; when the copy was made is the child's to say, of the file it opened.
          await stat(options.path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new QueryCopyError(
              "no-copy",
              "There is no copy of the store to query yet: the nightly backup leaves one, and has not run here.",
            );
          }
          throw new QueryCopyError("copy-unreadable", `The copy of the store cannot be read: ${(err as Error).message}`, { cause: err });
        }
        const request: WorkerRequest = {
          path: options.path,
          memoryLimit: options.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
          sql,
          explain: limits.explain === true,
          maxRows,
          maxBytes,
          maxCellBytes: MAX_CELL_BYTES,
        };
        const reply = await runInChild(request, options.workerModule ?? WORKER_MODULE, timeoutMs, rssLimit);
        if (!reply.ok) throw new QueryCopyError(reply.code, reply.message);
        return {
          columns: reply.columns,
          rows: reply.rows,
          truncated: reply.truncatedBy !== null,
          truncatedBy: reply.truncatedBy,
          copiedAt: reply.copiedAt,
          limits: { timeoutMs, maxRows, maxBytes },
          elapsedMs: Date.now() - started,
        };
      } finally {
        running = false;
      }
    },
  };
}

const PAGE_BYTES = 4096;
const WATCH_INTERVAL_MS = 50;

/** One child, one request. Resolves once the child has exited, whatever way. */
function runInChild(request: WorkerRequest, workerModule: string, timeoutMs: number, rssLimit: number): Promise<WorkerReply> {
  return new Promise<WorkerReply>((resolveReply, reject) => {
    let child: ChildProcess;
    try {
      child = fork(workerModule, [WORKER_FLAG], {
        execArgv: workerExecArgv(),
        env: workerEnvironment(process.env),
        // Its standard error goes where the app's does, so a crash leaves a trace in the log.
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
    } catch (err) {
      reject(new QueryCopyError("crashed", `The query process could not be started: ${(err as Error).message}`, { cause: err }));
      return;
    }
    let reply: WorkerReply | null = null;
    let killedFor: "timeout" | "memory" | null = null;
    const kill = (why: "timeout" | "memory") => {
      if (killedFor === null) {
        killedFor = why;
        child.kill("SIGKILL");
      }
    };
    const clock = setTimeout(() => kill("timeout"), timeoutMs);
    const watch = existsSync("/proc/self/statm")
      ? setInterval(() => {
          const pid = child.pid;
          if (pid === undefined) return;
          readFile(`/proc/${pid}/statm`, "utf8").then(
            (text) => {
              const pages = Number(text.split(" ")[1]);
              if (Number.isFinite(pages) && pages * PAGE_BYTES > rssLimit) kill("memory");
            },
            () => undefined, // already gone
          );
        }, WATCH_INTERVAL_MS)
      : null;
    child.on("message", (message: WorkerReply) => {
      reply = message;
    });
    child.on("error", (err) => {
      clearTimeout(clock);
      if (watch !== null) clearInterval(watch);
      child.kill("SIGKILL");
      reject(new QueryCopyError("crashed", `The query process failed: ${err.message}`, { cause: err }));
    });
    child.on("close", (code, signal) => {
      clearTimeout(clock);
      if (watch !== null) clearInterval(watch);
      if (killedFor === "timeout") {
        reject(new QueryCopyError("timeout", `The query ran longer than ${timeoutMs / 1000} seconds and was stopped.`));
      } else if (killedFor === "memory") {
        reject(
          new QueryCopyError(
            "memory",
            `The query used more than ${Math.round(rssLimit / 1024 / 1024)} MB of memory and was stopped.`,
          ),
        );
      } else if (reply !== null) {
        resolveReply(reply);
      } else {
        reject(
          new QueryCopyError(
            "crashed",
            `The query process ended without an answer (${signal !== null ? `signal ${signal}` : `exit code ${String(code)}`}).`,
          ),
        );
      }
    });
    child.send(request);
  });
}

/**
 * Whether the query copy's folder is also the folder of a file the app writes,
 * compared as written. The folder is kept read-only, so sharing it would leave
 * the app unable to create files there. Returns the file whose folder it is, or null.
 */
export function queryCopyFolderConflict(target: string, files: string[]): string | null {
  const folder = dirname(resolve(target));
  return files.find((f) => dirname(resolve(f)) === folder) ?? null;
}
