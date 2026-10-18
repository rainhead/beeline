/**
 * A path nobody named, falling back to where the deployment keeps the file.
 *
 * The files under `data/` are the deployment's own record — the change logs,
 * the overlays, the corrections, the rendered sheets and exports — and every
 * one of them is gitignored, so on a developer's machine they are that
 * developer's store. A test that builds the app or a job and forgets one path
 * is answered by the default, and writes into the real file: forty fake
 * sample-history entries authored 'trapline' were found in the dev store's
 * `data/sample-change.csv` on 2026-10-10, from test/sample-edit.test.ts
 * (beeline-yq65).
 *
 * So under Vitest the fallback refuses rather than answering, and the test
 * that reached for it fails naming the file. Everywhere else it is the path
 * it was given: the app's own processes always pass every path from
 * src/app/config.ts, and the CLIs keep their defaults.
 */
export function deploymentPath(path: string): string {
  if (process.env.VITEST !== undefined) {
    throw new Error(`a test fell back to the deployment's own ${path}: pass it a path in a temporary directory`);
  }
  return path;
}
