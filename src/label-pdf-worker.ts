import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { renderLabelsPdf, type LabelRow, type RenderOptions } from "./label-pdf.js";

/**
 * The sheet render, moved off the app's one thread (beeline-1kb.19).
 *
 * `renderLabelsPdf` is CPU-bound from end to end — shrink-to-fit measurement,
 * a DataMatrix per label, then pdf-lib serialising the document — and Node
 * runs it on the thread that also serves every request. During the first
 * demonstration (2026-09-18) Fly's health check failed at 21:33 UTC, not at a
 * deploy, while a 5,000-label run's sheets were rendering: the process was
 * alive and answering nothing. PR #79 took that render from 7.2 s to 2.9 s on
 * a workstation, which on the sandbox's two shared threads is still long
 * enough to drop a health check.
 *
 * So it runs in a worker. The boundary is the reason this is the cheap fix
 * rather than the tidy-but-large one (rendering at approve time as a job):
 * the input is plain rows and a date, the output is bytes, and nothing in
 * between touches the database, the session or the store's connection. The
 * renderer itself is untouched, so the sheets stay byte-identical — the
 * property two tests pin and that `print_run.pdf_sha256` records.
 *
 * One file, two halves: the spawner below runs on the main thread and the
 * body at the bottom runs in the worker, which is spawned from this same
 * module URL. Keeping them adjacent is the point — the message shape is the
 * whole interface, and split across two files it is the kind of pair that
 * drifts.
 *
 * NOT moved: the freeze's own TypeScript half, which composes and sorts a
 * run's labels. It is the same shape of work but it runs inside the freeze's
 * transaction on the print connection, so it cannot cross a thread boundary
 * without the transaction crossing with it.
 */

interface RenderRequest {
  rows: LabelRow[];
  preparedAt: Date;
  fontPath: string | undefined;
}

type RenderReply = { ok: true; bytes: Uint8Array } | { ok: false; message: string; stack: string | undefined };

/**
 * Renders the rows to a PDF on a worker thread.
 *
 * Every render goes to a worker, including a small one, because a second
 * path taken below some threshold is a second behaviour to keep correct for
 * the sake of the milliseconds a ten-label run would save. Spawning costs
 * about as much as loading pdf-lib and fontkit, and a run's sheets are
 * rendered once and then cached (`runPdf`), so it is paid once per run.
 */
export function renderLabelsPdfOffThread(rows: LabelRow[], opts: RenderOptions): Promise<Uint8Array> {
  const request: RenderRequest = { rows, preparedAt: opts.preparedAt, fontPath: opts.fontPath };
  return new Promise<Uint8Array>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: request, execArgv: workerExecArgv() });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      void worker.terminate();
    };
    worker.on("message", (reply: RenderReply) => {
      if (reply.ok) return done(() => resolve(reply.bytes));
      // The worker catches its own failures and reports them, so a render
      // that throws reads as that error rather than as "worker exited 1".
      const err = new Error(reply.message);
      err.stack = reply.stack ?? err.stack;
      done(() => reject(err));
    });
    worker.on("error", (err: Error) => done(() => reject(err)));
    // Only a failure: the success path has already settled on its message.
    worker.on("exit", (code) => done(() => reject(new Error(`label render worker exited with code ${code}`))));
  });
}

/**
 * A worker inherits the parent's Node flags and nothing else — it builds its
 * own module loader — so the entry being TypeScript is the worker's problem
 * to solve. In production the process is already `node --import tsx`
 * (infra/fly/entrypoint.sh) and the inherited flags carry it; under vitest
 * the parent resolves TypeScript through vite, which a raw worker has no
 * part in, and the import of ./label-pdf.js fails before the render starts.
 * So the loader is stated rather than assumed. tsx is a runtime dependency
 * on purpose and not a dev tool (Dockerfile), which is what makes naming it
 * here honest about how the app actually runs.
 */
function workerExecArgv(): string[] {
  const loaded = process.execArgv.some((arg) => arg === "tsx" || arg.includes("tsx/"));
  return loaded ? process.execArgv : [...process.execArgv, "--import", "tsx"];
}

if (!isMainThread && parentPort !== null) {
  const port = parentPort;
  const { rows, preparedAt, fontPath } = workerData as RenderRequest;
  void renderLabelsPdf(rows, { preparedAt, fontPath }).then(
    // Copied rather than transferred: a few megabytes of structured clone is
    // nothing beside the render, and transferring the backing buffer of a
    // view that may not own all of it is a bug waiting for a pdf-lib change.
    (bytes) => port.postMessage({ ok: true, bytes } satisfies RenderReply),
    (err: Error) => port.postMessage({ ok: false, message: err.message, stack: err.stack } satisfies RenderReply),
  );
}
