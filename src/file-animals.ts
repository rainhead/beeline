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
 *     tree lacks, each inserted under its Ecdysis parent only when that
 *     parent exists and sits under the same anchor as the node it is for,
 *     and so never as a root, nor in another family; a name that cannot be
 *     placed so is reported. A name the tree already holds, by rank and
 *     spelling, is reused and never inserted twice;
 *  2. restate animal_filing, the moved nodes, from the rule, with MERGE so a
 *     second run writes nothing. A row for a node the rule no longer reaches
 *     is deleted, so the filing depends only on the tree and the thesaurus:
 *     two stores holding the same ones agree. That is safe because every
 *     move keeps a node's anchor, so the creation parent that a deleted row
 *     falls back to has the same anchor, and no node leaves its family;
 *  3. report: each move, what was created, what could not be placed, and
 *     nodes the rule does not reach.
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
  /** Nodes that existed and now sit under another name (including a node whose filing row was deleted). */
  moved: FilingMove[];
  /** Subfamilies, tribes and subtribes created because the rule needed them. */
  created: { rank: string; name: string }[];
  /**
   * Subfamilies, tribes and subtribes the rule needs that could not be made
   * or used: the node that should hold the name sits in another family, or its
   * parent is missing or in another family. Nothing is filed under them.
   */
  unplaced: { rank: string; name: string }[];
  /** Subfamilies, tribes and subtribes with no node and no determination below them. */
  emptyIntermediates: number;
  /**
   * Nodes with an Ecdysis id that the rule does not reach, so that nothing
   * says whether they sit where Ecdysis files them: a genus whose family
   * Ecdysis spells differently, a synonym, a node Ecdysis has no parent for.
   * Roots are not counted.
   */
  unreached: number;
  /**
   * Set when the thesaurus is loaded but holds no subfamily or tribe at all,
   * as a store reseeded from a copy made before they were kept: nothing can
   * be filed until `pnpm ecdysis:taxonomy --cached` loads them.
   */
  needsCachedLoad: boolean;
}

export const NO_FILING: FilingResult = { moved: [], created: [], unplaced: [], emptyIntermediates: 0, unreached: 0, needsCachedLoad: false };

export async function fileAnimalsByEcdysis(conn: DuckDBConnection): Promise<FilingResult> {
  const rowsOf = async (sql: string, params: unknown[] = []) => (await conn.run(sql, params as never)).getRows();
  const [[loaded]] = (await rowsOf("SELECT count(*) FROM ecdysis_taxon")) as [[bigint]];
  if (Number(loaded) === 0) return { ...NO_FILING };
  const [[kept]] = (await rowsOf(`SELECT count(*) FROM ecdysis_taxon WHERE rank IN ('subfamily', 'tribe')`)) as [[bigint]];
  if (Number(kept) === 0) return { ...NO_FILING, needsCachedLoad: true };

  const before = new Map(
    ((await rowsOf("SELECT entity_id, filed_under_id FROM animal_tree")) as [number, number | null][]).map(([id, parent]) => [
      Number(id),
      parent === null ? null : Number(parent),
    ]),
  );

  // 1. The intermediates the rule needs and the tree lacks. A name is made
  // only under a parent that exists and has the same anchor as the node the
  // name is for (or is that anchor), so nothing is ever a root and nothing
  // lands in another family. A made name can be the parent of the next, so
  // this goes round until a pass makes nothing.
  const missingSql = `
    SELECT t.tid, t.rank, t.name, t.author, c.anchor_id,
           (SELECT min(p.entity_id) FROM animal_tree p WHERE p.ecdysis_tid = t.admitted_parent_tid) AS parent_node_id
    FROM animal_filing_chain c
    JOIN ecdysis_taxon t ON t.tid = c.tid AND t.status = 'accepted' AND t.rank IN (${INTERMEDIATE_SQL})
    WHERE NOT EXISTS (SELECT 1 FROM animal a WHERE a.ecdysis_tid = t.tid OR (a.rank = t.rank AND a.scientific_name = t.name))`;
  const created: FilingResult["created"] = [];
  for (let pass = 0; pass < 8; pass++) {
    const usable = (await rowsOf(`
      WITH m AS (${missingSql})
      SELECT DISTINCT tid, rank, name, author, parent_node_id FROM m
      WHERE parent_node_id IS NOT NULL
        AND (parent_node_id = anchor_id OR (SELECT a.anchor_id FROM animal_anchor a WHERE a.entity_id = m.parent_node_id) = anchor_id)
      ORDER BY tid`)) as [bigint, string, string, string | null, number][];
    let made = 0;
    for (const [tid, rank, name, author, parentId] of usable) {
      const inserted = (await (
        await conn.run(
          `INSERT INTO animal (parent_id, rank, scientific_name, authorship, ecdysis_tid)
           SELECT $1, $2, $3, $4, $5
           WHERE NOT EXISTS (SELECT 1 FROM animal a WHERE a.rank = $2 AND a.scientific_name = $3)
           RETURNING entity_id`,
          [parentId, rank, name, author, tid] as never,
        )
      ).getRows()) as unknown[][];
      if (inserted.length > 0) {
        created.push({ rank, name });
        made += 1;
      }
    }
    if (made === 0) break;
  }
  const unplaced = ((await rowsOf(`SELECT DISTINCT rank, name FROM (${missingSql}) ORDER BY name`)) as [string, string][]).map(([rank, name]) => ({
    rank,
    name,
  }));
  // A node holding a name needed, in another family, is reported too.
  const blocked = (await rowsOf(`
    SELECT DISTINCT a.rank, a.scientific_name FROM animal_filing_rule r JOIN animal a ON a.entity_id = r.target_id
    WHERE r.filed_under_id IS NULL AND r.target_id IS NOT NULL ORDER BY 2`)) as [string, string][];
  for (const [rank, name] of blocked) unplaced.push({ rank, name });

  // 2. animal_filing restated from the rule: a row is written where the rule
  // files a node away from where it was created, changed when the target
  // changes, and deleted when the rule files it where it was created or no
  // longer reaches it.
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
      INSERT (animal_id, parent_id, ecdysis_fetched_on) VALUES (s.entity_id, s.filed_under_id, s.fetched_on)
    WHEN NOT MATCHED BY SOURCE THEN DELETE`);

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
  const [[unreached]] = (await rowsOf(`
    SELECT count(*) FROM animal_tree t
    WHERE t.ecdysis_tid IS NOT NULL AND t.filed_under_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM animal_filing_rule r WHERE r.entity_id = t.entity_id)`)) as [[bigint]];
  return { moved, created, unplaced, emptyIntermediates: Number(empty), unreached: Number(unreached), needsCachedLoad: false };
}

/**
 * The filing in a sentence for a report: how many moved and the first few by
 * name (`limit`), then what was created, what could not be placed and what
 * the rule does not reach. Empty when nothing happened.
 */
export function describeFiling(f: FilingResult, limit = 10): string {
  const parts: string[] = [];
  if (f.needsCachedLoad) {
    parts.push("the loaded thesaurus holds no subfamily or tribe, so nothing was filed: run `pnpm ecdysis:taxonomy --cached`");
  }
  if (f.moved.length > 0) {
    const shown = f.moved.slice(0, limit).map((m) => `${m.name}: ${m.from} to ${m.to}`);
    parts.push(`${f.moved.length} filed under another name (the first ${Math.min(limit, f.moved.length)}: ${shown.join("; ")}${f.moved.length > limit ? "; …" : ""})`);
  }
  if (f.created.length > 0) parts.push(`${f.created.length} subfamilies, tribes and subtribes created`);
  if (f.unplaced.length > 0) {
    parts.push(`${f.unplaced.length} could not be placed in the right family: ${f.unplaced.slice(0, limit).map((u) => u.name).join(", ")}${f.unplaced.length > limit ? ", …" : ""}`);
  }
  if (f.emptyIntermediates > 0) parts.push(`${f.emptyIntermediates} subfamilies, tribes and subtribes have nothing filed under them`);
  if (f.unreached > 0) parts.push(`${f.unreached} nodes with an Ecdysis id are not reached by the filing rule (their family differs from Ecdysis's, or Ecdysis files them as synonyms)`);
  return parts.join("; ");
}
