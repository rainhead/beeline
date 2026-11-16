import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchEcdysisTaxonomy, type FetchEcdysisTaxonomyOptions, type FetchEcdysisTaxonomyResult } from "./fetch-ecdysis-taxonomy.js";

/**
 * The fetch of Ecdysis's taxonomy in a process of its own (beeline-xni1), for
 * the weekly job, which otherwise runs inside the app.
 *
 * The fetch keeps every name in memory until it writes the file: measured on
 * 2026-11-16 with the whole thesaurus (1,028,386 names), the process stood at
 * 1.3 GB when the fetch ended, and Node does not hand that back promptly. On
 * production that would sit beside the app's own memory, DuckDB's allowance
 * of 1,536 MB among it, on a machine of 3 GB. In a child process it is
 * returned when the child exits. What crosses back is only the result: the
 * file's path, the day, and counts.
 *
 * Cancelling the job (its signal) kills the child; a child that ends without
 * answering is a failed fetch, which never replaces the last good file,
 * since the fetch writes it only once whole.
 */

const CHILD_FLAG = "--fetch-ecdysis-taxonomy-child";

/** As src/query-copy.ts: the child needs tsx to read TypeScript, which the app's own `node --import tsx` already has. */
function childExecArgv(): string[] {
  const loaded = process.execArgv.some((arg) => arg === "tsx" || arg.includes("tsx/"));
  return loaded ? process.execArgv : [...process.execArgv, "--import", "tsx"];
}

type Reply = { ok: true; result: FetchEcdysisTaxonomyResult } | { ok: false; message: string };

/** fetchEcdysisTaxonomy, run in a child process. Only `dir` and `signal` are used. */
export function fetchEcdysisTaxonomyInChild(options: FetchEcdysisTaxonomyOptions = {}): Promise<FetchEcdysisTaxonomyResult> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [CHILD_FLAG, options.dir ?? ""], {
      execArgv: childExecArgv(),
      // Nothing secret is needed: Ecdysis's taxonomy exports need no sign-in.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    let reply: Reply | null = null;
    const abort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("message", (message: Reply) => {
      reply = message;
    });
    child.on("error", (err) => {
      options.signal?.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      reject(new Error(`the fetch of Ecdysis's taxonomy could not run: ${err.message}`, { cause: err }));
    });
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      const r = reply as Reply | null;
      if (options.signal?.aborted) reject(new Error("the fetch of Ecdysis's taxonomy was cancelled"));
      else if (r?.ok === true) resolve(r.result);
      else if (r?.ok === false) reject(new Error(r.message));
      else reject(new Error(`the fetch of Ecdysis's taxonomy ended without an answer (${signal !== null ? `signal ${signal}` : `exit code ${String(code)}`})`));
    });
  });
}

// The child: fetch into the folder it was given, answer, and exit.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv[2] === CHILD_FLAG) {
  const dir = process.argv[3] || undefined;
  const send = (reply: Reply) =>
    new Promise<void>((done) => {
      if (process.send) process.send(reply, () => done());
      else done();
    });
  try {
    await send({ ok: true, result: await fetchEcdysisTaxonomy({ dir }) });
  } catch (err) {
    await send({ ok: false, message: (err as Error).message });
  }
  process.exit(0);
}
