// One promotion at a time from the app, on its one promotion connection
// (`mintConn`, src/app/main.ts). Promotion is one raw BEGIN/COMMIT
// transaction, and two at once on one connection would race one transaction
// against another, which DuckDB cannot hold — the print runs' lock exists for
// the same reason (src/print-run.ts). Shared by the two app-side promotions:
// connecting a collector on /unclaimed (beeline-e85) and a volunteer's
// "Check iNaturalist now" (beeline-yso).
let queue: Promise<unknown> = Promise.resolve();

export function withPromotionLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}
