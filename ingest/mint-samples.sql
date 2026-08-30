-- Turn observations into samples (beeline-oyq).
--
-- Called from ingest/promote-observations.sql, inside its transaction, AFTER
-- the iNat account harvest and BEFORE the geoprivacy and location statements.
-- The order is load-bearing in both directions: minting resolves an observer
-- through inat_account, which the harvest writes, so minting first would mint
-- fewer samples on each pass and "promotion twice mints the same count" would
-- be a property of the fixture rather than of the design; and the geoprivacy
-- and location statements key on inat_observation_id, which this file has by
-- then just set, so a minted sample gets its coordinates on the same run
-- rather than the next one.
--
-- A pure function of observation_field, inat_place and the model, like the
-- rest of that file — idempotent, meant to re-run after every sync. The
-- reconcile it writes from is stated as views in schema/108, so beeline-e85's
-- unclaimed screen and the alarms read the same definitions this does.
--
-- WHAT IT NEVER DOES: rewrite an existing sample's number, date or specimen
-- count. sample.inat_observation_id stays scalar and there is no
-- sample_observation list, which is what makes that guarantee cheap — and
-- what protects a staff edit to any field minting writes.
-- sample_observation_number_mismatch and sample_multi_observation (schema/108)
-- are the cost of it, named rather than argued away.

-- ── Free links ───────────────────────────────────────────────────────────
-- An existing sample that cites no observation, and an unlinked observation
-- whose collector, number and date range it matches. Not a no-op: the link is
-- what carries believed-true coordinates, geoprivacy and the observer's
-- account onto a record the legacy dump supplied without them, and the
-- statements after this one in promote-observations.sql are what do it.
UPDATE sample SET inat_observation_id = l.lead_inat_id
FROM sample_mint_free_link l
WHERE sample.entity_id = l.sample_id;

-- ── Mint ─────────────────────────────────────────────────────────────────
-- One sample per group that matches nothing the store already holds.
-- Materialised first because the ids have to be drawn once and then used
-- three times — sample, sample_collector, and the descriptive fill below.
CREATE OR REPLACE TEMP TABLE minted_sample AS
SELECT p.person_id,
       p.sample_number,
       p.observed_on,
       p.specimen_count,
       p.lead_inat_id,
       nextval('entity_id_seq') AS sample_id
FROM sample_mint_pending p;

-- kind and protocol are CONSTANTS, not derived from the OBA Collection Method
-- observation field (Peter, 2026-08-29). 56,937 of the 57,278 iNat-backed
-- samples already in the store carry 'aerial net' whatever that field says;
-- its 83 non-net values disagree with the record about a third of the time;
-- and an observation carries one date, so it cannot evidence a trap's range
-- anyway. schema/060's comment on the column says the same thing.
--
-- date_start = date_end = observed_on follows from that: a net sample is one
-- day. Note this makes kind='trap' impossible here, which is deliberate — a
-- trap range is a fact iNaturalist does not carry.
INSERT INTO sample (entity_id, kind, collector_id, atlas_id, sample_number,
                    date_start, date_end, specimen_count, inat_observation_id,
                    host_inat_taxon_id, host_name_as_observed,
                    country, state_province, county, locality, protocol)
SELECT m.sample_id, 'net', m.person_id,
       -- Geography assigns the atlas, through the same lookup legacy
       -- promotion uses (schema/010). Null means "no member atlas covers
       -- this", which is ordinary; qc_rule_place_unrecognised is what fires
       -- when the place did not resolve at all.
       reg.atlas_id,
       m.sample_number, m.observed_on, m.observed_on, m.specimen_count,
       m.lead_inat_id,
       f.host_taxon_id, f.host_taxon_name,
       pl.country_code, pl.state_province, pl.county_name, loc.locality,
       'aerial net'
FROM minted_sample m
JOIN observation_field f ON f.inat_id = m.lead_inat_id
LEFT JOIN observation_place pl ON pl.inat_id = m.lead_inat_id
LEFT JOIN observation_locality loc ON loc.inat_id = m.lead_inat_id
LEFT JOIN atlas_region reg ON reg.state_province = pl.state_province;

-- The observer becomes the primary collector, at position 1, so
-- sample_primary_collector_mismatch (schema/116) stays empty. That view's
-- comment named the arrival of a second writer as what it was waiting for:
-- this is that writer.
--
-- Taking the observer as collector is settled (Peter, 2026-08-29) and the
-- household-login risk it carries is 94% historical — split at
-- season.started_on (schema/160), 150 of the 903 minted samples from settled
-- seasons land under a shared login against 9 of the 518 from the open one,
-- and collectors are being moved to individual iNaturalist accounts. Where that is wrong it is staff's to override, not the model's to
-- guess (beeline-v0j).
--
-- One collector, never a list: an observation carries one observer and
-- inventing a second would be a claim nothing here evidences. That leaves a
-- partner who collects in a pair invisible under `mine` scope, which is the
-- reach problem person_delegate exists for.
INSERT INTO sample_collector (sample_id, person_id, position)
SELECT m.sample_id, m.person_id, 1 FROM minted_sample m;

-- ── Descriptive fields: a fill-only refresh ──────────────────────────────
-- Write-once is right for number, date and count and WRONG for everything
-- descriptive. inat_place is network-fetched, so a reseeded store promotes
-- before pnpm inat:fetch-places has run and mints samples whose geography is
-- null — and since minting never rewrites, no later fetch could repair them.
-- The same applies to a locality the store learns to read later, and it has
-- already paid off once: beeline-4dt's anchored street-suffix predicate
-- fills in the six samples that were refused a locality only because 'st'
-- was in the word list — 4 open-season against 2 settled, so live work
-- rather than residue — on the next promotion, with no backfill script.
--
-- FILL-ONLY, never overwrite, and that is what makes it safe to run over
-- every iNat-linked sample rather than only over minted ones. It cannot
-- reach a value the legacy import stated or a staffer typed, because it
-- writes only where the store currently says nothing — so it needs no way to
-- tell a minted sample from an imported one, which is just as well, since by
-- design there is none. What it does not do is propagate an upstream
-- CORRECTION to a field already filled; sample_observation_number_mismatch
-- and the QC rules are how that stays visible.
UPDATE sample SET
  country        = coalesce(sample.country,        pl.country_code),
  state_province = coalesce(sample.state_province, pl.state_province),
  county         = coalesce(sample.county,         pl.county_name),
  locality       = coalesce(sample.locality,       loc.locality)
FROM observation_place pl
LEFT JOIN observation_locality loc ON loc.inat_id = pl.inat_id
WHERE sample.inat_observation_id = pl.inat_id
  AND (sample.country IS NULL OR sample.state_province IS NULL
    OR sample.county IS NULL OR sample.locality IS NULL);

-- THE ATLAS CANNOT JOIN THAT REFRESH, and the reason is an engine limitation
-- rather than a decision. DuckDB 1.5.5 will not update an INDEXED column on a
-- row that an incoming foreign key references: the update becomes a
-- delete-and-insert and the delete trips the inbound check. sample.atlas_id
-- carries a foreign key, which is indexed, and every sample has a
-- sample_collector row pointing at it — so `UPDATE sample SET atlas_id` fails
-- for every sample in the store, always. (An unindexed column is fine, which
-- is why the fill above works — and "indexed" means any index, a plain
-- CREATE INDEX as much as a PRIMARY KEY, UNIQUE or FOREIGN KEY. Writing the
-- value the column already holds fails too, so it is the statement and not
-- the change that is refused. Measured and pinned by test in
-- test/schema.test.ts under beeline-6e9, which also corrected schema/010 and
-- migration 0020 where they stated the rule as "a row an incoming foreign key
-- references" — a version that says this refresh is impossible.)
--
-- So the atlas is set once, in the INSERT above, and a sample minted before
-- its geography was known keeps a null atlas that nothing can repair.
-- sample_atlas_unfilled (schema/108) names that population — empty on the dev
-- store — and the reseed recipe runs pnpm inat:fetch-places BEFORE promoting
-- so it stays that way (docs/roadmap.md). Fixing it properly means being able
-- to reassign a sample's atlas and its collector at all, which the staff
-- override screen needs too (beeline-6e9).
