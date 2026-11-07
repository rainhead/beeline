import { pathToFileURL } from "node:url";
import { configFromEnv } from "./app/config.js";
import { openDuckDb } from "./db.js";
import { assertCopied, copyToOldBeeline, describeCopy } from "./legacy-copy.js";

// CLI: pnpm legacy:copy [db] [--dry-run] [--all]
// What the nightly legacy-copy job does (beeline-83b8.18), against a store the
// app is not holding: every specimen printed here, copied into the old
// Beeline. --dry-run signs in and reads the old system, and says what it would
// send without sending or recording anything; --all sends every printed
// specimen whether or not its row changed. The login comes from
// OLD_BEELINE_USERNAME and OLD_BEELINE_PASSWORD, as the app's does.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  for (const f of flags) if (f !== "--dry-run" && f !== "--all") throw new Error(`unknown option ${f}`);
  const dbPath = args.find((a) => !a.startsWith("--")) ?? process.env.BEELINE_DB ?? "beeline.duckdb";
  const { oldBeeline } = configFromEnv({ ...process.env, BEELINE_ENV: "development" });
  if (!oldBeeline) throw new Error("set OLD_BEELINE_USERNAME and OLD_BEELINE_PASSWORD");
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  try {
    const result = await copyToOldBeeline(conn, oldBeeline, {
      dryRun: flags.has("--dry-run"),
      all: flags.has("--all"),
      log: (m) => console.error(m),
    });
    console.log(describeCopy(result));
    assertCopied(result);
  } finally {
    conn.closeSync();
  }
}
