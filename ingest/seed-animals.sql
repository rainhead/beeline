-- Seed the curated animal tree: a fixed spine, the staff-curated bee list
-- (family,genus,species CSV exported from the legacy system), and every
-- taxon verbatim determinations assert that the list doesn't cover — those
-- extras are queryable for curator review (legacy_taxon_uncurated).
--
-- Ranks derive from the data, not the legacy taxonRank column: subgenus
-- determinations sometimes arrive as 'Lasioglossum (Dialictus)' in the genus
-- column, and most genus rows carry no family (resolved via the curated CSV).
-- Species attach to their genus (subgenus nodes exist but are leaves for
-- now); nodes join uniquely on (rank, scientific_name) — subgenus names are
-- stored as 'Genus (Subgenus)'.

CREATE TABLE legacy_taxonomy_csv AS
SELECT trim(family) AS family, trim(genus) AS genus, trim(species) AS species
FROM read_csv('{{TAXONOMY_CSV}}', header = true);

-- ── Spine ───────────────────────────────────────────────────────────────
INSERT INTO animal (rank, scientific_name) VALUES ('kingdom', 'Animalia');
INSERT INTO animal (rank, scientific_name, parent_id)
SELECT 'phylum', 'Arthropoda', entity_id FROM animal WHERE scientific_name = 'Animalia';
INSERT INTO animal (rank, scientific_name, parent_id)
SELECT 'class', 'Insecta', entity_id FROM animal WHERE scientific_name = 'Arthropoda';

-- ── Normalized determination taxonomy from staging ──────────────────────
CREATE OR REPLACE VIEW legacy_det_taxa AS
SELECT _id,
  nullif(trim("order"), '')                                    AS ord,
  nullif(trim(family), '')                                     AS family,
  nullif(regexp_extract(trim(genus), '^([A-Za-z]+)', 1), '')   AS base_genus,
  coalesce(nullif(trim(subgenus), ''),
           nullif(regexp_extract(trim(genus), '\(([A-Za-z]+)\)', 1), '')) AS sub,
  nullif(trim(specificEpithet), '')                            AS epithet,
  nullif(trim(scientificName), '')                             AS sci,
  taxonRank                                                    AS legacy_rank
FROM legacy_promotable;

-- ── Orders ──────────────────────────────────────────────────────────────
INSERT INTO animal (rank, scientific_name, parent_id)
SELECT 'order', o.ord, (SELECT entity_id FROM animal WHERE scientific_name = 'Insecta')
FROM (
  SELECT DISTINCT ord FROM legacy_det_taxa WHERE ord IS NOT NULL
  UNION SELECT 'Hymenoptera'
) o;

-- ── Families ────────────────────────────────────────────────────────────
-- Staging families always carry their order (surveyed); curated-CSV
-- families are bees.
CREATE TABLE legacy_family_order AS
SELECT family, arg_max(ord, n) AS ord FROM (
  SELECT family, ord, count(*) AS n
  FROM legacy_det_taxa WHERE family IS NOT NULL AND ord IS NOT NULL
  GROUP BY 1, 2
) GROUP BY family;

INSERT INTO animal (rank, scientific_name, parent_id)
SELECT 'family', f.family, o.entity_id
FROM (
  SELECT family FROM legacy_family_order
  UNION SELECT DISTINCT family FROM legacy_taxonomy_csv
) f
LEFT JOIN legacy_family_order fo ON fo.family = f.family
JOIN animal o ON o.rank = 'order'
  AND o.scientific_name = coalesce(fo.ord, 'Hymenoptera');

-- ── Genera ──────────────────────────────────────────────────────────────
-- Family via the curated CSV first, then staging co-occurrence; a genus
-- with no known family attaches to its order (or Insecta) and shows up in
-- legacy_taxon_uncurated.
CREATE TABLE legacy_genus_family AS
SELECT g.base_genus,
  coalesce(
    (SELECT any_value(c.family) FROM legacy_taxonomy_csv c WHERE c.genus = g.base_genus),
    (SELECT arg_max(t.family, cnt) FROM (
       SELECT family, count(*) AS cnt FROM legacy_det_taxa d
       WHERE d.base_genus = g.base_genus AND d.family IS NOT NULL GROUP BY 1
     ) t)
  ) AS family,
  (SELECT arg_max(t.ord, cnt) FROM (
     SELECT ord, count(*) AS cnt FROM legacy_det_taxa d
     WHERE d.base_genus = g.base_genus AND d.ord IS NOT NULL GROUP BY 1
   ) t) AS ord
FROM (
  SELECT DISTINCT base_genus FROM legacy_det_taxa WHERE base_genus IS NOT NULL
  UNION SELECT DISTINCT genus FROM legacy_taxonomy_csv
  UNION SELECT DISTINCT nullif(trim(genusVolDet), '') FROM legacy_promotable
          WHERE nullif(trim(genusVolDet), '') IS NOT NULL
) g;

INSERT INTO animal (rank, scientific_name, parent_id)
SELECT 'genus', g.base_genus,
  coalesce(fam.entity_id, ord.entity_id,
           (SELECT entity_id FROM animal WHERE scientific_name = 'Insecta'))
FROM legacy_genus_family g
LEFT JOIN animal fam ON fam.rank = 'family' AND fam.scientific_name = g.family
LEFT JOIN animal ord ON ord.rank = 'order' AND ord.scientific_name = g.ord;

-- ── Subgenera ───────────────────────────────────────────────────────────
INSERT INTO animal (rank, scientific_name, parent_id)
SELECT 'subgenus', concat(s.base_genus, ' (', s.sub, ')'), gen.entity_id
FROM (
  SELECT DISTINCT base_genus, sub FROM legacy_det_taxa
  WHERE base_genus IS NOT NULL AND sub IS NOT NULL
) s
JOIN animal gen ON gen.rank = 'genus' AND gen.scientific_name = s.base_genus;

-- ── Species ─────────────────────────────────────────────────────────────
-- Authorship best-effort from the verbatim scientificName remainder.
INSERT INTO animal (rank, scientific_name, parent_id, authorship)
SELECT 'species', concat(sp.genus, ' ', sp.epithet), gen.entity_id, sp.authorship
FROM (
  SELECT genus, epithet, any_value(authorship) AS authorship FROM (
    SELECT base_genus AS genus, epithet,
      nullif(trim(regexp_replace(sci, '^[A-Za-z]+( \([A-Za-z]+\))? [a-z-]+', '')), '') AS authorship
    FROM legacy_det_taxa WHERE base_genus IS NOT NULL AND epithet IS NOT NULL
    UNION ALL
    SELECT genus, species, NULL FROM legacy_taxonomy_csv
    UNION ALL
    SELECT nullif(trim(genusVolDet), ''), nullif(trim(speciesVolDet), ''), NULL
    FROM legacy_promotable
    WHERE nullif(trim(genusVolDet), '') IS NOT NULL AND nullif(trim(speciesVolDet), '') IS NOT NULL
  ) GROUP BY genus, epithet
) sp
JOIN animal gen ON gen.rank = 'genus' AND gen.scientific_name = sp.genus;

-- ── Subspecies (trinomials in scientificName) ───────────────────────────
INSERT INTO animal (rank, scientific_name, parent_id)
SELECT 'subspecies', t.sci, sp.entity_id
FROM (
  SELECT DISTINCT sci, base_genus, epithet FROM legacy_det_taxa
  WHERE legacy_rank = 'Subspecies' AND sci IS NOT NULL
    AND base_genus IS NOT NULL AND epithet IS NOT NULL
) t
JOIN animal sp ON sp.rank = 'species'
  AND sp.scientific_name = concat(t.base_genus, ' ', t.epithet);

-- ── Curator review: model nodes the curated list doesn't cover ──────────
CREATE OR REPLACE VIEW legacy_taxon_uncurated AS
SELECT a.rank, a.scientific_name
FROM animal a
WHERE (a.rank = 'species' AND NOT EXISTS (
         SELECT 1 FROM legacy_taxonomy_csv c
         WHERE concat(c.genus, ' ', c.species) = a.scientific_name))
   OR (a.rank = 'genus' AND NOT EXISTS (
         SELECT 1 FROM legacy_taxonomy_csv c WHERE c.genus = a.scientific_name))
   OR (a.rank = 'family' AND NOT EXISTS (
         SELECT 1 FROM legacy_taxonomy_csv c WHERE c.family = a.scientific_name));
