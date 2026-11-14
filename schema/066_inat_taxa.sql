-- iNaturalist's taxa, cached: the ones the store has referred to, their
-- ancestors and the taxa that replaced them (beeline-rfkj.1). Nothing leaves
-- the cache: a taxon that no sample names any more stays.
--
-- A floral host is stored as an iNaturalist taxon id and the name and rank as
-- observed (schema/030). Nothing in the store knows a host's genus, its
-- family, its common name, or whether iNaturalist has since retired it. This
-- is what knows, so a page, a count or an export can read it. iNaturalist's
-- taxonomy is the plant taxonomy (Peter, 2026-11-13); the cache holds only
-- taxa that something refers to, fetched by id from the API
-- (src/fetch-inat-taxa.ts), never the monthly taxonomy download.
--
-- STORED IDS AND NAMES ARE NEVER REWRITTEN TO FOLLOW iNATURALIST. A sample
-- keeps the host id its observation gave it. A retired taxon stays here as
-- retired, with the ids that replaced it, and a view resolves it to a current
-- taxon when somebody reads it.
--
-- Not an entity (ADR 0002), for the reason inat_place gives (schema/065):
-- nothing anchors on a taxon here, so it is reference data keyed by the id
-- iNaturalist gave it.
--
-- No foreign keys. An ancestor id or a replacement id is recorded before the
-- taxon it names has been fetched, and inat_taxon_uncached (schema/112) is
-- the list of exactly those gaps.
CREATE TABLE inat_taxon (
  inat_taxon_id         BIGINT PRIMARY KEY,
  name                  TEXT NOT NULL,
  rank                  TEXT NOT NULL,
  rank_level            DOUBLE NOT NULL,
  parent_id             BIGINT,
  is_active             BOOLEAN NOT NULL,
  preferred_common_name TEXT,
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE inat_taxon IS 'iNaturalist taxa the store has referred to (a sample''s or observation''s floral host), with their ancestors and replacements, read from the iNaturalist API by id (src/fetch-inat-taxa.ts). Reference data, not an entity (ADR 0002). A retired taxon is kept, with is_active false, because samples still name it. Nothing is deleted from the cache, including taxa that nothing refers to any more; inat_taxon_replacement says what replaced it.';
COMMENT ON COLUMN inat_taxon.name IS 'The scientific name iNaturalist uses for this taxon today.';
COMMENT ON COLUMN inat_taxon.rank IS 'The rank as iNaturalist writes it: species, subspecies, variety, genus, section, complex, hybrid and so on. Not narrowed to the ranks the model knows.';
COMMENT ON COLUMN inat_taxon.rank_level IS 'iNaturalist''s number for the rank, higher for broader ranks (species 10, genus 20, family 30, kingdom 70). Orders ranks without a list of their names.';
COMMENT ON COLUMN inat_taxon.parent_id IS 'The taxon one step up, as iNaturalist last said. NULL only for the root, Life (48460). A retired taxon''s parent is stale: it need not be an ancestor of the taxon that replaced it, so read lineage from the current taxon.';
COMMENT ON COLUMN inat_taxon.is_active IS 'False once iNaturalist has retired the taxon (a taxon swap, split or lump). The row stays because stored ids are never rewritten.';
COMMENT ON COLUMN inat_taxon.preferred_common_name IS 'The English name iNaturalist prefers for Oregon (preferred_place_id=10), or NULL where it has none. Until a program outside Oregon asks otherwise (Madrona against Arbutus), this is the common name.';
COMMENT ON COLUMN inat_taxon.fetched_at IS 'When this row was read from iNaturalist. Taxa are refreshed, a thirtieth of them each night (inat_taxon_stalest), so this says how stale the answer is.';

-- A taxon's lineage, one row per ancestor, including the taxon itself.
--
-- The self row (depth 0) is always written, because the two places that carry
-- a lineage disagree: the taxa endpoint's ancestor_ids leaves the taxon out,
-- while an observation's taxon.ancestor_ids includes it (schema/105). Keeping
-- the taxon in its own lineage makes "is this taxon, or under this one" a
-- single lookup that does not care which source a row came from.
CREATE TABLE inat_taxon_ancestor (
  inat_taxon_id BIGINT NOT NULL,
  ancestor_id   BIGINT NOT NULL,
  depth         INTEGER NOT NULL,
  PRIMARY KEY (inat_taxon_id, ancestor_id)
);
COMMENT ON TABLE inat_taxon_ancestor IS 'Every taxon above a taxon, and the taxon itself, as iNaturalist last gave them. Rewritten whole on each fetch of the taxon, so a taxon moved between genera leaves no stale rows. A retired taxon''s lineage is stale; read lineage from its current taxon.';
COMMENT ON COLUMN inat_taxon_ancestor.ancestor_id IS 'An iNaturalist taxon id. Need not be in inat_taxon yet: inat_taxon_uncached lists the ones to fetch.';
COMMENT ON COLUMN inat_taxon_ancestor.depth IS 'Steps up from the taxon: 0 for the taxon itself, 1 for its parent, and so on to Life.';

-- What replaced a retired taxon. A split is several rows.
CREATE TABLE inat_taxon_replacement (
  retired_taxon_id     BIGINT NOT NULL,
  replacement_taxon_id BIGINT NOT NULL,
  PRIMARY KEY (retired_taxon_id, replacement_taxon_id)
);
COMMENT ON TABLE inat_taxon_replacement IS 'iNaturalist''s current_synonymous_taxon_ids: the taxa a retired taxon was replaced by. Several rows for one retired taxon means iNaturalist split it, and a reader cannot pick one. A replacement may itself be retired later; follow the chain. Rewritten whole on each fetch of the retired taxon, so a reinstated taxon loses its rows.';
COMMENT ON COLUMN inat_taxon_replacement.retired_taxon_id IS 'The taxon iNaturalist retired. A taxon only has rows here when iNaturalist named replacements; some retired taxa have none.';
COMMENT ON COLUMN inat_taxon_replacement.replacement_taxon_id IS 'A taxon that took over from it. Need not be in inat_taxon yet.';

-- Taxon ids iNaturalist was asked for and did not return, on the terms of
-- inat_place_absent (schema/065): "uncached" means not yet tried, and an id
-- here means tried and gone.
CREATE TABLE inat_taxon_absent (
  inat_taxon_id BIGINT PRIMARY KEY,
  asked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE inat_taxon_absent IS 'Taxon ids iNaturalist was asked for and did not return (deleted upstream while a sample still names them). Subtracted from inat_taxon_uncached for 30 days (inat_taxon_known_absent) so the fetcher stops re-asking, then asked again; delete a row to ask sooner. A response that lists the taxon, as itself or as an ancestor, deletes its row. A stored taxon that a refresh no longer gets back is recorded here too and keeps its row.';
COMMENT ON COLUMN inat_taxon_absent.asked_at IS 'When iNaturalist was last asked and answered without it. Older than 30 days, the verdict no longer counts.';
