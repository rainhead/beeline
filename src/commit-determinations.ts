import type { DuckDBConnection } from "@duckdb/node-api";
import { adoptEcdysisNames } from "./adopt-ecdysis.js";
import { BEE_FAMILIES } from "./bee-families.js";

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
 *
 * A draft may name a taxon from Ecdysis that the tree does not hold yet
 * (determination_draft.ecdysis_tid, beeline-4wx3). Its name is adopted into
 * the tree here, in the same transaction and with the ancestors the tree
 * lacks (src/adopt-ecdysis.ts), and the determination is recorded against
 * the new node. Adopting at the commit rather than when the name was picked
 * means the tree gains a name only when a determination uses it: a pick made
 * by mistake and changed the same day leaves nothing behind. A draft whose
 * name cannot be adopted, because a later fetch of Ecdysis made it a synonym
 * or dropped it, waits, and is counted apart so the job's report says so.
 */
export interface CommitCounts {
  committed: number;
  unchanged: number;
  waiting: number;
  /** Names from Ecdysis added to the tree for tonight's drafts. */
  adopted: string[];
  /** Drafts waiting because their name from Ecdysis could not be adopted. */
  unadoptable: number;
}

const count = async (conn: DuckDBConnection, query: string): Promise<number> => {
  const reader = await conn.runAndReadAll(query);
  return Number(reader.getRows()[0]?.[0] ?? 0);
};

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** The node a draft names: its own, or the one adopted for its name from Ecdysis. */
const DRAFT_NODE = `coalesce(dd.animal_id, (SELECT min(t.entity_id) FROM animal t WHERE t.ecdysis_tid = dd.ecdysis_tid))`;

export async function commitDeterminationDrafts(conn: DuckDBConnection): Promise<CommitCounts> {
  await conn.run("BEGIN TRANSACTION");
  try {
    // The names from Ecdysis that tonight's drafts chose, adopted first. Only
    // names ecdysis_adoptable still offers, and never a bee's, which the
    // picker does not offer either (src/app/determine.ts).
    const wanted = (
      await conn.runAndReadAll(`
        SELECT DISTINCT e.name
        FROM determination_draft dd
        JOIN ecdysis_adoptable e ON e.tid = dd.ecdysis_tid
        WHERE dd.ecdysis_tid IS NOT NULL AND dd.updated_at <= now()
          AND (e.family IS NULL OR e.family NOT IN (${BEE_FAMILIES.map(sqlString).join(", ")}))
        ORDER BY e.name`)
    )
      .getRows()
      .map((r) => String(r[0]));
    const adopted = (await adoptEcdysisNames(conn, wanted)).map((a) => a.name);

    await conn.run(`
      CREATE OR REPLACE TEMP TABLE commit_draft AS
      SELECT dd.specimen_id, dd.determiner_id, a.entity_id AS animal_id, dd.sex, dd.caste, dd.updated_at,
             a.scientific_name,
             (vol.specimen_id IS NOT NULL
               AND vol.animal_id = a.entity_id
               AND vol.sex IS NOT DISTINCT FROM dd.sex
               AND vol.caste IS NOT DISTINCT FROM dd.caste) AS unchanged
      FROM determination_draft dd
      JOIN animal a ON a.entity_id = ${DRAFT_NODE}
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
    const unadoptable = await count(
      conn,
      "SELECT count(*) FROM determination_draft WHERE ecdysis_tid IS NOT NULL AND animal_id IS NULL AND updated_at <= now()",
    );
    await conn.run("DROP TABLE commit_draft");
    await conn.run("COMMIT");
    return { committed, unchanged, waiting, adopted, unadoptable };
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}
