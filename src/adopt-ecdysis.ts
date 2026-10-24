import type { DuckDBConnection } from "@duckdb/node-api";
import { matchAnimalsToEcdysis } from "./load-ecdysis-taxonomy.js";

/**
 * Adopt accepted Ecdysis names into the curated taxonomy (beeline-45v.1.1,
 * from ITIS until beeline-7gob).
 *
 * Ecdysis's thesaurus is the program's default, but the tree only ever held
 * the names the legacy records happened to use, plus the curation file's
 * additions — so a name Ecdysis accepts and the legacy data never used had
 * no way in. The Ecdysis archive of 2026-09-24 held back 446 specimens'
 * records that way, nearly all bycatch: Chrysididae, Ichneumonoidea,
 * Lepidoptera. Adopting such a name is not a taxonomic claim, which is why it
 * is not a kind in ingest/taxon-curation.csv: it takes Ecdysis's word, as
 * every matched node already does.
 *
 * A name is adopted only when Ecdysis has exactly one accepted insect name at
 * that spelling — two accepted names are a homonym, which is a taxonomist's
 * choice (the curation file's `homonym`) — never at subspecies rank, since
 * whether the program records subspecies is undecided (beeline-45v.1.2), and
 * never where the name holds anything but ASCII: the Code allows no
 * diacritics in a scientific name, and the ones Ecdysis holds are
 * double-encoded text (`hÃÂ¶nei`), not names. The name comes in with whatever
 * ancestors the tree lacks, walking ecdysis_taxon.admitted_parent_tid up to
 * the nearest node the tree already holds, matched by id or by rank and
 * spelling, and each new node carries its id and Ecdysis's authorship. A name
 * whose chain reaches nothing the tree holds is left unadopted, as is one the
 * tree already spells at any rank.
 *
 * Runs inside the caller's transaction, and restates animal.ecdysis_tid
 * after, as every writer of the tree does.
 */

export interface AdoptedName {
  name: string;
  rank: string;
  tid: number;
  /** Ancestors created on the way up, nearest first. */
  ancestors: string[];
}

export async function adoptEcdysisNames(conn: DuckDBConnection, names: readonly string[]): Promise<AdoptedName[]> {
  if (names.length === 0) return [];
  const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
  await conn.run(`CREATE OR REPLACE TEMP TABLE adopt_request AS
                  SELECT DISTINCT name FROM (VALUES ${names.map((n) => `(${literal(n)})`).join(", ")}) v(name)`);
  // The names to adopt: one accepted Ecdysis insect name at the spelling, no
  // node spelled so at any rank, not a subspecies, nothing but ASCII, and not
  // one of the genera Ecdysis spells like a subgenus (src/load-ecdysis-taxonomy.ts).
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE adopt_start AS
    SELECT t.tid, t.name
    FROM adopt_request q
    JOIN ecdysis_taxon t ON t.name = q.name AND t.status = 'accepted'
    WHERE t.rank <> 'subspecies'
      AND t.name = regexp_replace(t.name, '[^ -~]', '', 'g')
      AND NOT (t.rank = 'genus' AND t.name LIKE '%(%')
      AND NOT EXISTS (SELECT 1 FROM animal a WHERE a.scientific_name = q.name)
      AND (SELECT count(*) FROM ecdysis_taxon u WHERE u.name = q.name AND u.status = 'accepted') = 1`);
  // Each one's chain up to the nearest node the tree holds. The walk stops at
  // a held node, so the anchor is the last step and everything below it is
  // to be created.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE adopt_chain AS
    WITH RECURSIVE held AS (
      SELECT a.ecdysis_tid AS tid, a.entity_id FROM animal a WHERE a.ecdysis_tid IS NOT NULL
      UNION ALL
      SELECT t.tid, a.entity_id
      FROM ecdysis_taxon t JOIN animal a ON a.rank = t.rank AND a.scientific_name = t.name
      WHERE t.status = 'accepted'
    ),
    up AS (
      SELECT s.name AS start, s.tid, 0 AS depth, (SELECT min(h.entity_id) FROM held h WHERE h.tid = s.tid) AS node
      FROM adopt_start s
      UNION ALL
      SELECT up.start, t.admitted_parent_tid, up.depth + 1, (SELECT min(h.entity_id) FROM held h WHERE h.tid = t.admitted_parent_tid)
      FROM up JOIN ecdysis_taxon t ON t.tid = up.tid
      WHERE up.node IS NULL AND t.admitted_parent_tid IS NOT NULL
    )
    SELECT up.*, t.rank, t.name, t.author, r.ordinal
    FROM up JOIN ecdysis_taxon t ON t.tid = up.tid JOIN animal_rank r ON r.rank = t.rank`);
  // Only chains that reached the tree are adopted.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE adopt_reached AS
    SELECT DISTINCT start FROM adopt_chain WHERE node IS NOT NULL`);

  // Create the missing nodes from the top down, so each parent exists first.
  // A node two chains share is created once.
  const toCreate = (await (
    await conn.run(`
      SELECT DISTINCT c.tid, c.rank, c.name, c.author, c.ordinal,
             (SELECT x.admitted_parent_tid FROM ecdysis_taxon x WHERE x.tid = c.tid) AS parent_tid
      FROM adopt_chain c
      WHERE c.node IS NULL AND c.start IN (SELECT start FROM adopt_reached)
      ORDER BY c.ordinal, c.name`)
  ).getRows()) as [bigint, string, string, string | null, number, bigint][];
  for (const [tid, rank, name, author, , parentTid] of toCreate) {
    await conn.run(
      `INSERT INTO animal (parent_id, rank, scientific_name, authorship, ecdysis_tid)
       SELECT (SELECT min(a.entity_id) FROM animal a, ecdysis_taxon p
                WHERE p.tid = $1 AND (a.ecdysis_tid = p.tid OR (a.rank = p.rank AND a.scientific_name = p.name))),
              $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM animal a WHERE a.rank = $2 AND a.scientific_name = $3)`,
      [parentTid, rank, name, author, tid],
    );
  }
  await matchAnimalsToEcdysis(conn);

  const adopted = (await (
    await conn.run(`
      SELECT s.name, t.rank, s.tid,
             coalesce(string_agg(c.name, '|' ORDER BY c.depth) FILTER (WHERE c.depth > 0 AND c.node IS NULL), '') AS ancestors
      FROM adopt_start s
      JOIN ecdysis_taxon t ON t.tid = s.tid
      JOIN adopt_chain c ON c.start = s.name
      WHERE s.name IN (SELECT start FROM adopt_reached)
      GROUP BY s.name, t.rank, s.tid
      ORDER BY s.name`)
  ).getRows()) as [string, string, bigint, string][];
  return adopted.map(([name, rank, tid, ancestors]) => ({
    name,
    rank,
    tid: Number(tid),
    ancestors: ancestors === "" ? [] : ancestors.split("|"),
  }));
}
