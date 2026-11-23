import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * File each node of the tree under the subfamily, tribe or subtribe Ecdysis
 * files it under (beeline-stoi): Melissodes under Eucerina, not under Apidae.
 *
 * The rule is the view animal_filing_rule (schema/117): a node's anchor is
 * its nearest ancestor that is not a subfamily, tribe or subtribe, and when
 * that is the one Ecdysis reaches walking up past those ranks, the node
 * belongs under the name Ecdysis gives as its admitted_parent_tid. It
 * follows Ecdysis between tribes of one family, never moves a node across
 * families, and leaves alone a node whose anchor Ecdysis disagrees with.
 *
 * Three steps, none of them a change to animal.parent_id, which DuckDB 2.0
 * will not UPDATE on a row anything refers to (schema/020):
 *  1. create the subfamilies, tribes and subtribes the rule needs and the
 *     tree lacks, from the top down and each inserted with its parent,
 *     reusing one the tree already holds by rank and spelling;
 *  2. restate animal_filing, the moved nodes, from the rule, with MERGE so a
 *     second run writes nothing;
 *  3. report: each move, what was created, and intermediates nothing sits
 *     under.
 *
 * Run wherever the tree or the thesaurus changes, straight after
 * matchAnimalsToEcdysis (src/load-ecdysis-taxonomy.ts), inside the caller's
 * transaction: the taxonomy load, legacy promotion, adoption and the
 * curation file. animal_filing_stale is empty after it.
 */

export const INTERMEDIATE_RANKS = ["subfamily", "tribe", "subtribe"] as const;
const INTERMEDIATE_SQL = INTERMEDIATE_RANKS.map((r) => `'${r}'`).join(", ");

export interface FilingMove {
  rank: string;
  name: string;
  /** The name it sat under before, and the name it sits under now. */
  from: string;
  to: string;
}

export interface FilingResult {
  /** Nodes that existed and were filed under another name. */
  moved: FilingMove[];
  /** Subfamilies, tribes and subtribes created because the rule needed them. */
  created: { rank: string; name: string }[];
  /** Subfamilies, tribes and subtribes with no node and no determination below them. */
  emptyIntermediates: number;
  /**
   * Set when the thesaurus is loaded but holds no subfamily or tribe at all,
   * as a store reseeded from a copy made before they were kept: nothing can
   * be filed until `pnpm ecdysis:taxonomy --cached` loads them.
   */
  needsCachedLoad: boolean;
}

const NOTHING: FilingResult = { moved: [], created: [], emptyIntermediates: 0, needsCachedLoad: false };

export async function fileAnimalsByEcdysis(conn: DuckDBConnection): Promise<FilingResult> {
  const rowsOf = async (sql: string, params: unknown[] = []) => (await conn.run(sql, params as never)).getRows();
  const [[loaded]] = (await rowsOf("SELECT count(*) FROM ecdysis_taxon")) as [[bigint]];
  if (Number(loaded) === 0) return { ...NOTHING };
  const [[kept]] = (await rowsOf(
    `SELECT count(*) FROM ecdysis_taxon WHERE rank IN ('subfamily', 'tribe')`,
  )) as [[bigint]];
  if (Number(kept) === 0) return { ...NOTHING, needsCachedLoad: true };

  const before = new Map(
    ((await rowsOf("SELECT entity_id, filed_under_id FROM animal_tree")) as [number, number | null][]).map(([id, parent]) => [
      Number(id),
      parent === null ? null : Number(parent),
    ]),
  );

  // 1. The intermediates the rule needs and the tree lacks. The names wanted
  // are those the rule files a node under, and each one's own chain up
  // through the three ranks; the ones already in the tree, by id or by rank
  // and spelling, drop out. Ordered by rank so a parent is there first.
  const missing = (await rowsOf(`
    WITH RECURSIVE need(tid, depth) AS (
      SELECT DISTINCT filed_under_tid, 0 FROM animal_filing_rule WHERE filed_under_id IS NULL
      UNION ALL
      SELECT t.admitted_parent_tid, need.depth + 1
      FROM need JOIN ecdysis_taxon t ON t.tid = need.tid
      WHERE t.admitted_parent_tid IS NOT NULL AND need.depth < 8
    )
    SELECT DISTINCT t.tid, t.rank, t.name, t.author, r.ordinal, t.admitted_parent_tid
    FROM need
    JOIN ecdysis_taxon t ON t.tid = need.tid AND t.status = 'accepted'
    JOIN animal_rank r ON r.rank = t.rank
    WHERE t.rank IN (${INTERMEDIATE_SQL})
      AND NOT EXISTS (SELECT 1 FROM animal a WHERE a.ecdysis_tid = t.tid OR (a.rank = t.rank AND a.scientific_name = t.name))
    ORDER BY r.ordinal, t.name`)) as [bigint, string, string, string | null, number, bigint | null][];
  const created: FilingResult["created"] = [];
  for (const [tid, rank, name, author, , parentTid] of missing) {
    await conn.run(
      `INSERT INTO animal (parent_id, rank, scientific_name, authorship, ecdysis_tid)
       SELECT (SELECT min(a.entity_id) FROM animal a JOIN ecdysis_taxon p ON p.tid = $1
                WHERE a.ecdysis_tid = p.tid OR (a.rank = p.rank AND a.scientific_name = p.name)),
              $2, $3, $4, $5`,
      [parentTid, rank, name, author, tid],
    );
    created.push({ rank, name });
  }

  // 2. animal_filing restated from the rule. A node whose rule says where it
  // was created has no row, and loses one it had.
  await conn.run(`
    MERGE INTO animal_filing AS f
    USING (
      SELECT r.entity_id, r.filed_under_id, r.created_under_id,
             (SELECT max(fetched_on) FROM ecdysis_taxon) AS fetched_on
      FROM animal_filing_rule r
      WHERE r.filed_under_id IS NOT NULL
    ) AS s ON f.animal_id = s.entity_id
    WHEN MATCHED AND s.filed_under_id IS NOT DISTINCT FROM s.created_under_id THEN DELETE
    WHEN MATCHED AND f.parent_id IS DISTINCT FROM s.filed_under_id THEN
      UPDATE SET parent_id = s.filed_under_id, ecdysis_fetched_on = s.fetched_on, filed_at = current_timestamp
    WHEN NOT MATCHED AND s.filed_under_id IS DISTINCT FROM s.created_under_id THEN
      INSERT (animal_id, parent_id, ecdysis_fetched_on) VALUES (s.entity_id, s.filed_under_id, s.fetched_on)`);

  // 3. The report.
  const names = new Map(
    ((await rowsOf("SELECT entity_id, scientific_name, rank FROM animal")) as [number, string, string][]).map(([id, name, rank]) => [
      Number(id),
      { name, rank },
    ]),
  );
  const after = (await rowsOf("SELECT entity_id, filed_under_id FROM animal_tree")) as [number, number | null][];
  const moved: FilingMove[] = [];
  for (const [id, parent] of after) {
    const was = before.get(Number(id));
    if (was === undefined) continue; // created just now
    const now = parent === null ? null : Number(parent);
    if (was === now || was === null || now === null) continue;
    const node = names.get(Number(id))!;
    moved.push({ rank: node.rank, name: node.name, from: names.get(was)?.name ?? String(was), to: names.get(now)?.name ?? String(now) });
  }
  moved.sort((a, b) => a.name.localeCompare(b.name));
  const [[empty]] = (await rowsOf(`
    SELECT count(*) FROM animal_tree t
    WHERE t.rank IN (${INTERMEDIATE_SQL})
      AND NOT EXISTS (SELECT 1 FROM animal_tree c WHERE c.filed_under_id = t.entity_id)
      AND NOT EXISTS (SELECT 1 FROM determination d WHERE d.animal_id = t.entity_id)`)) as [[bigint]];
  return { moved, created, emptyIntermediates: Number(empty), needsCachedLoad: false };
}

/** The filing in a sentence for a report: each move, then what was created. Empty when nothing happened. */
export function describeFiling(f: FilingResult, limit = 10): string {
  const parts: string[] = [];
  if (f.needsCachedLoad) {
    parts.push("the loaded thesaurus holds no subfamily or tribe, so nothing was filed: run `pnpm ecdysis:taxonomy --cached`");
  }
  if (f.moved.length > 0) {
    const shown = f.moved.slice(0, limit).map((m) => `${m.name}: ${m.from} to ${m.to}`);
    parts.push(`${f.moved.length} filed under another name (${shown.join("; ")}${f.moved.length > limit ? "; …" : ""})`);
  }
  if (f.created.length > 0) parts.push(`${f.created.length} subfamilies, tribes and subtribes created`);
  if (f.emptyIntermediates > 0) parts.push(`${f.emptyIntermediates} with nothing filed under them`);
  return parts.join("; ");
}
