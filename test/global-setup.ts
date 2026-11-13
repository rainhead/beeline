import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every temporary folder a test run makes lands in one folder, removed when
// the run ends (beeline-qqcg). Tests and the code they call make theirs with
// mkdtemp under os.tmpdir(), and almost nothing removed them: on Hostess,
// where /tmp is held in memory, a week of runs left about 30,000 folders and
// over 5 GB there, most of it the backup tests' copies of stores. Node reads
// TMPDIR on every os.tmpdir() call, and Vitest's workers start after this
// runs and inherit the environment, so pointing TMPDIR at the run's own
// folder catches every one, including those a future test forgets.
// The kept copy of the store sits in a read-only folder on purpose
// (keepQueryCopy, src/store-backup.ts), which rmSync cannot empty until it is
// opened up again.
function openUp(dir: string): void {
  try {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) openUp(join(dir, entry.name));
    }
  } catch {
    // Gone already, or not ours.
  }
}

export default function setup() {
  const runDir = mkdtempSync(join(tmpdir(), "beeline-test-run-"));
  process.env.TMPDIR = runDir;
  // Named apart from TMPDIR, which a test may point elsewhere: where the
  // run's promoted stores are kept (test/promoted-store.ts, beeline-vwn4).
  process.env.BEELINE_TEST_RUN_DIR = runDir;
  return () => {
    openUp(runDir);
    rmSync(runDir, { recursive: true, force: true });
  };
}
