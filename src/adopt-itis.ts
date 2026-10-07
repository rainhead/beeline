import type { DuckDBConnection } from "@duckdb/node-api";
import { matchAnimalsToItis } from "./load-itis.js";

/**
 * Adopt current ITIS names into the curated taxonomy (beeline-45v.1.1).
 *
 * ITIS is the program's default (beeline-45v), but the tree only ever held
 * the names the legacy records happened to use, plus the curation file's
 * additions — so a name ITIS accepts and the legacy data never used had no
 * way in. The Ecdysis archive of 2026-09-24 held back 446 specimens' records
 * that way, nearly all bycatch: Chrysididae, Ichneumonoidea, Lepidoptera.
 * Adopting such a name is not a taxonomic claim, which is why it is not a
 * kind in ingest/taxon-curation.csv: it takes ITIS's word, as every matched
 * node already does.
 *
 * A name is adopted only when ITIS has exactly one current insect name at
 * that spelling — two current names are a homonym, which is a taxonomist's
 * choice (the curation file's `homonym`) — and never at subspecies rank,
 * since whether the program records subspecies is undecided (beeline-45v.1.2).
 * The name comes in with whatever ancestors the tree lacks, walking
 * itis_taxon.admitted_parent_tsn up to the nearest node the tree already
 * holds, matched by TSN or by rank and spelling, and each new node carries
 * its TSN and ITIS's authorship. A name whose chain reaches nothing the tree
 * holds — a store whose ITIS extract predates admitted_parent_tsn — is left
 * unadopted, as is one the tree already spells at any rank.
 *
 * Runs inside the caller's transaction, and restates animal.itis_tsn after,
 * as every writer of the tree does.
 */

export interface AdoptedName {
  name: string;
  rank: string;
  tsn: number;
  /** Ancestors created on the way up, nearest first. */
  ancestors: string[];
}

export async function adoptItisNames(conn: DuckDBConnection, names: readonly string[]): Promise<AdoptedName[]> {
  if (names.length === 0) return [];
  const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
  await conn.run(`CREATE OR REPLACE TEMP TABLE adopt_request AS
                  SELECT DISTINCT name FROM (VALUES ${names.map((n) => `(${literal(n)})`).join(", ")}) v(name)`);
  // The names to adopt: one current ITIS insect name at the spelling, no node
  // spelled so at any rank, and not a subspecies.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE adopt_start AS
    SELECT t.tsn, t.name
    FROM adopt_request q
    JOIN itis_taxon t ON t.name = q.name AND t.usage = 'valid'
    WHERE t.rank <> 'subspecies'
      AND NOT EXISTS (SELECT 1 FROM animal a WHERE a.scientific_name = q.name)
      AND (SELECT count(*) FROM itis_taxon u WHERE u.name = q.name AND u.usage = 'valid') = 1`);
  // Each one's chain up to the nearest node the tree holds. The walk stops at
  // a held node, so the anchor is the last step and everything below it is
  // to be created.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE adopt_chain AS
    WITH RECURSIVE held AS (
      SELECT a.itis_tsn AS tsn, a.entity_id FROM animal a WHERE a.itis_tsn IS NOT NULL
      UNION ALL
      SELECT t.tsn, a.entity_id
      FROM itis_taxon t JOIN animal a ON a.rank = t.rank AND a.scientific_name = t.name
      WHERE t.usage = 'valid'
    ),
    up AS (
      SELECT s.name AS start, s.tsn, 0 AS depth, (SELECT min(h.entity_id) FROM held h WHERE h.tsn = s.tsn) AS node
      FROM adopt_start s
      UNION ALL
      SELECT up.start, t.admitted_parent_tsn, up.depth + 1, (SELECT min(h.entity_id) FROM held h WHERE h.tsn = t.admitted_parent_tsn)
      FROM up JOIN itis_taxon t ON t.tsn = up.tsn
      WHERE up.node IS NULL AND t.admitted_parent_tsn IS NOT NULL
    )
    SELECT up.*, t.rank, t.name, t.author, r.ordinal
    FROM up JOIN itis_taxon t ON t.tsn = up.tsn JOIN animal_rank r ON r.rank = t.rank`);
  // Only chains that reached the tree are adopted.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE adopt_reached AS
    SELECT DISTINCT start FROM adopt_chain WHERE node IS NOT NULL`);

  // Create the missing nodes from the top down, so each parent exists first.
  // A node two chains share is created once.
  const toCreate = (await (
    await conn.run(`
      SELECT DISTINCT c.tsn, c.rank, c.name, c.author, c.ordinal,
             (SELECT p.tsn FROM itis_taxon x JOIN itis_taxon p ON p.tsn = x.admitted_parent_tsn WHERE x.tsn = c.tsn) AS parent_tsn
      FROM adopt_chain c
      WHERE c.node IS NULL AND c.start IN (SELECT start FROM adopt_reached)
      ORDER BY c.ordinal, c.name`)
  ).getRows()) as [bigint, string, string, string | null, number, bigint][];
  for (const [tsn, rank, name, author, , parentTsn] of toCreate) {
    await conn.run(
      `INSERT INTO animal (parent_id, rank, scientific_name, authorship, itis_tsn)
       SELECT (SELECT min(a.entity_id) FROM animal a, itis_taxon p
                WHERE p.tsn = $1 AND (a.itis_tsn = p.tsn OR (a.rank = p.rank AND a.scientific_name = p.name))),
              $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM animal a WHERE a.rank = $2 AND a.scientific_name = $3)`,
      [parentTsn, rank, name, author, tsn],
    );
  }
  await matchAnimalsToItis(conn);

  const adopted = (await (
    await conn.run(`
      SELECT s.name, t.rank, s.tsn,
             coalesce(string_agg(c.name, '|' ORDER BY c.depth) FILTER (WHERE c.depth > 0 AND c.node IS NULL), '') AS ancestors
      FROM adopt_start s
      JOIN itis_taxon t ON t.tsn = s.tsn
      JOIN adopt_chain c ON c.start = s.name
      WHERE s.name IN (SELECT start FROM adopt_reached)
      GROUP BY s.name, t.rank, s.tsn
      ORDER BY s.name`)
  ).getRows()) as [string, string, bigint, string][];
  return adopted.map(([name, rank, tsn, ancestors]) => ({
    name,
    rank,
    tsn: Number(tsn),
    ancestors: ancestors === "" ? [] : ancestors.split("|"),
  }));
}
