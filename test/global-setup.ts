import { mkdtempSync, rmSync } from "node:fs";
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
export default function setup() {
  const runDir = mkdtempSync(join(tmpdir(), "beeline-test-run-"));
  process.env.TMPDIR = runDir;
  return () => rmSync(runDir, { recursive: true, force: true });
}
