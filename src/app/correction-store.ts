import { sql, type Kysely } from "kysely";
import type { CorrectionEvent } from "../corrections.js";
import type { Database } from "../model.js";

/**
 * Corrections an in-app save wrote to the corrections file, mirrored into the
 * store's own correction tables at once (beeline-p8y1). Legacy promotion
 * builds `legacy_app_correction` and `legacy_correction` from the files
 * (ingest/promote-legacy.sql), and `legacy_occurrence_corrected` reads the
 * old records through them; the legacy-format export and the copy into old
 * Beeline write a record's own method and end date from that view where a
 * sample's records disagree. Production is never promoted again (ADR 0006),
 * so without this a correction reached the live sample but never the export
 * of a sample whose records disagreed (the independent review on PR #314).
 * Same rule as the file: one row per record and field, the newest winning,
 * and the app's row over the git-curated one. A store nothing was promoted
 * into has neither table, and nothing to mirror.
 */
export async function mirrorCorrections(db: Kysely<Database>, events: CorrectionEvent[]): Promise<void> {
  if (events.length === 0) return;
  const tables = (
    await sql<{ table_name: string }>`
      SELECT table_name FROM duckdb_tables()
      WHERE table_name IN ('legacy_app_correction', 'legacy_correction') AND NOT temporary`.execute(db)
  ).rows.map((r) => r.table_name);
  const values = sql.join(
    events.map((e) => sql`(${e._id}, ${e.field}, ${e.base_value}, ${e.new_value}, ${e.author}, ${e.reason})`),
  );
  for (const table of tables) {
    const t = sql.table(table);
    await sql`
      DELETE FROM ${t} WHERE (_id, field) IN (SELECT _id, field FROM (VALUES ${values}) v(_id, field, base_value, new_value, author, reason))`.execute(db);
    await sql`
      INSERT INTO ${t} (_id, field, base_value, new_value, author, reason)
      SELECT * FROM (VALUES ${values}) v(_id, field, base_value, new_value, author, reason)`.execute(db);
  }
}
