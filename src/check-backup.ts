import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkBackup } from "./store-backup.js";

// CLI: pnpm backup:check <beeline-backup-….tar.gz> [dir]
// Extract a backup downloaded from the Bee Line folder into dir (a new
// temporary directory when none is given), check every file against the
// manifest, and open both stores. BEELINE_PRIVATE_DB_KEY opens the private
// store; without it that store is reported as not checked. The extracted
// files are left in place: they are what a restore puts back under /app/data,
// and what the drill opens a scratch app against.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const archive = process.argv[2];
  if (archive === undefined) {
    console.error("usage: pnpm backup:check <beeline-backup-….tar.gz> [dir]");
    process.exit(2);
  }
  const dir = process.argv[3] ?? (await mkdtemp(join(tmpdir(), "beeline-restore-")));
  const key = process.env.BEELINE_PRIVATE_DB_KEY?.trim() || null;
  const r = await checkBackup(archive, { dir, privateKey: key });
  const unopened = Object.keys(r.manifest.stores).filter((s) => !r.storesOpened.includes(s));
  console.log(`taken ${r.manifest.takenAt}${r.manifest.release ? ` by ${r.manifest.release}` : ""}`);
  console.log(`${r.files} files match the manifest; opened and counted ${r.storesOpened.join(" and ")}`);
  if (r.manifest.absent.length > 0) console.log(`not yet written when it was taken: ${r.manifest.absent.join(", ")}`);
  if (unopened.length > 0) console.log(`NOT checked: ${unopened.join(", ")} (set BEELINE_PRIVATE_DB_KEY to open it)`);
  console.log(`extracted to ${dir}`);
}
