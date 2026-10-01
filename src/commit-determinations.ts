import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * The overnight commit (beeline-bcq): every volunteer's drafts become
 * determinations, channel 'in_app', in one transaction.
 *
 * A draft is the volunteer's to change all day; this is the moment it stops
 * being theirs to change and becomes an event — a later change then sits
 * beside it, the way every correction does (schema/040). It runs at 1am
 * Pacific, ahead of the 4am legacy export, so the export carries what was
 * entered that day.
 *
 * Only drafts last changed before the run began are taken, and only those
 * are removed, so somebody still typing at 1am keeps their latest change as
 * a draft for the next night rather than losing it. A draft with no taxon —
 * a sex set on a specimen nobody has named — cannot be a determination and
 * waits. A draft that says what the newest volunteer determination already
 * says is removed without recording anything.
 */
export interface CommitCounts {
  committed: number;
  unchanged: number;
  waiting: number;
}

const count = async (conn: DuckDBConnection, query: string): Promise<number> => {
  const reader = await conn.runAndReadAll(query);
  return Number(reader.getRows()[0]?.[0] ?? 0);
};

export async function commitDeterminationDrafts(conn: DuckDBConnection): Promise<CommitCounts> {
  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE commit_draft AS
      SELECT dd.*, a.scientific_name,
             (vol.specimen_id IS NOT NULL
               AND vol.animal_id = dd.animal_id
               AND vol.sex IS NOT DISTINCT FROM dd.sex
               AND vol.caste IS NOT DISTINCT FROM dd.caste) AS unchanged
      FROM determination_draft dd
      JOIN animal a ON a.entity_id = dd.animal_id
      LEFT JOIN (
        SELECT specimen_id, animal_id, sex, caste FROM (
          SELECT d.*, row_number() OVER (PARTITION BY d.specimen_id ORDER BY d.recorded_at DESC, d.entity_id DESC) AS rn
          FROM determination d WHERE NOT d.is_expert
        ) ranked WHERE rn = 1
      ) vol ON vol.specimen_id = dd.specimen_id
      WHERE dd.updated_at <= now()`);
    const committed = await count(conn, "SELECT count(*) FROM commit_draft WHERE NOT unchanged");
    const unchanged = await count(conn, "SELECT count(*) FROM commit_draft WHERE unchanged");
    await conn.run(`
      INSERT INTO determination (specimen_id, animal_id, verbatim_identification, sex, caste,
                                 determiner_id, is_expert, channel, determined_on)
      SELECT specimen_id, animal_id, scientific_name, sex, caste,
             determiner_id, false, 'in_app', CAST(updated_at AT TIME ZONE 'America/Los_Angeles' AS DATE)
      FROM commit_draft WHERE NOT unchanged
      ORDER BY updated_at, specimen_id`);
    await conn.run(`
      DELETE FROM determination_draft
      WHERE EXISTS (
        SELECT 1 FROM commit_draft c
        WHERE c.specimen_id = determination_draft.specimen_id
          AND c.determiner_id = determination_draft.determiner_id
          AND c.updated_at = determination_draft.updated_at)`);
    const waiting = await count(conn, "SELECT count(*) FROM determination_draft");
    await conn.run("DROP TABLE commit_draft");
    await conn.run("COMMIT");
    return { committed, unchanged, waiting };
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}
