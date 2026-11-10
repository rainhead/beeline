import { pathToFileURL } from "node:url";
import { configFromEnv } from "./app/config.js";
import { openDuckDb } from "./db.js";
import { describeVolunteerImport, readOldVolunteerRecords, recordOldVolunteerDeterminations } from "./legacy-volunteer-import.js";

// CLI: pnpm legacy:volunteer-import [db] [--dry-run]
// What the nightly legacy-volunteer-import job does (beeline-c43w), against a
// store the app is not holding: every volunteer determination in the old
// Beeline, read and compared with what the store holds, and each change
// recorded. --dry-run reads the old system and says what it would record
// without recording anything. The login comes from OLD_BEELINE_USERNAME and
// OLD_BEELINE_PASSWORD, as the app's does.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  for (const f of flags) if (f !== "--dry-run") throw new Error(`unknown option ${f}`);
  const dbPath = args.find((a) => !a.startsWith("--")) ?? process.env.BEELINE_DB ?? "beeline.duckdb";
  const { oldBeeline } = configFromEnv({ ...process.env, BEELINE_ENV: "development" });
  if (!oldBeeline) throw new Error("set OLD_BEELINE_USERNAME and OLD_BEELINE_PASSWORD");
  const records = await readOldVolunteerRecords(oldBeeline, { log: (m) => console.error(m) });
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  try {
    const result = await recordOldVolunteerDeterminations(conn, records, { dryRun: flags.has("--dry-run") });
    console.log(describeVolunteerImport(result));
    if (!flags.has("--dry-run")) await conn.run("CHECKPOINT");
  } finally {
    conn.closeSync();
  }
}
