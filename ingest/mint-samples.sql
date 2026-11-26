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
-- WHAT IT NEVER DOES: rewrite a printed sample's date or number, the dates of
-- a sample that is not a single day, or a date staff set. sample.inat_observation_id stays scalar and
-- there is no sample_observation list, which is what makes that guarantee
-- cheap — and what protects a staff edit to any field minting writes.
-- sample_observation_number_mismatch and sample_multi_observation (schema/108)
-- are the cost of it, named rather than argued away. An UNPRINTED sample's
-- number follows its observation, as its locality does (below): until the
-- labels print the observation is the record, one observation is one sample,
-- and renumbering on iNaturalist is how a volunteer clears a duplicate number
-- (beeline-0199). So does an unprinted single-day sample's date (beeline-qu2c),
-- on the same terms, which is how a volunteer corrects a wrong date before it
-- is on a label, unless staff set the date (sample_date_override). A sample's specimen count follows its observation printed
-- or not, because the count is what the volunteer declares and what is on
-- paper is a separate fact (beeline-ni5m.18, GitHub #464) — except where
-- another sample cites the same observation or several observations claim
-- the sample, since one count cannot then be right, and for a printed sample
-- whose observation no longer carries its number and dates. Staff can set the
-- dates of any sample in the app, and a date they set is never moved (above),
-- so no staff edit is at risk there.

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
-- One sample per observation that sample_mint_pending (schema/108) lets through.
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
-- trap range is a fact iNaturalist does not carry. 'aerial net' is not a trap, so
-- kind 'net' is the method's own (sample_kind_method_mismatch stays empty).
INSERT INTO sample (entity_id, kind, sample_number,
                    date_start, date_end, specimen_count, inat_observation_id,
                    host_inat_taxon_id, host_name_as_observed, host_rank,
                    country, state_province, county, locality, protocol)
SELECT m.sample_id, 'net',
       m.sample_number, m.observed_on, m.observed_on, m.specimen_count,
       m.lead_inat_id,
       h.host_taxon_id, h.host_taxon_name, h.host_taxon_rank,
       pl.country_code, pl.state_province, pl.county_name, loc.locality,
       'aerial net'
FROM minted_sample m
-- observation_field's row, with the host as a sample takes it: none where the
-- taxon means no host, such as Homo sapiens, a user's flag (observation_host,
-- beeline-rfkj.11).
JOIN observation_host h ON h.inat_id = m.lead_inat_id
LEFT JOIN observation_place pl ON pl.inat_id = m.lead_inat_id
LEFT JOIN observation_locality loc ON loc.inat_id = m.lead_inat_id;

-- Their method: the constant the protocol above is, as the method it names
-- (beeline-ni5m.15). Written beside the sample, so that sample_method_out_of_step
-- stays empty and the nightly's check on it passes.
INSERT INTO sample_method (sample_id, method_code)
SELECT m.sample_id, 'aerial net' FROM minted_sample m;

-- Geography assigns the atlas, through the same lookup legacy promotion uses
-- (schema/010). No row means "no member atlas covers this", which is
-- ordinary; qc_rule_place_unrecognised is what fires when the place did not
-- resolve at all. A sample whose geography is not yet cached gets its row
-- from the fill-only refresh below on a later pass — the gap this INSERT
-- leaves is repairable now (beeline-6e9), not permanent.
INSERT INTO sample_atlas (sample_id, atlas_id)
SELECT m.sample_id, reg.atlas_id
FROM minted_sample m
JOIN observation_place pl ON pl.inat_id = m.lead_inat_id
JOIN atlas_region reg ON reg.state_province = pl.state_province
WHERE reg.atlas_id IS NOT NULL;

-- The observer becomes the primary collector, at position 1, so
-- sample_primary_collector_mismatch (schema/116) stays empty. That view's
-- comment named the arrival of a second writer as what it was waiting for:
-- this is that writer.
--
-- Taking the observer as collector is settled (Peter, 2026-08-29) and the
-- household-login risk it carries is 94% historical — split at
-- the 1 March line schema/102 drew at the time, 150 of the 903 minted samples from settled
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

-- ── A locality follows its observation until the labels print ───────────
-- The one descriptive field rewritten rather than filled, and only on a
-- sample not in printed_sample (schema/101): no label of its is on paper.
-- Until its labels print, a sample's locality is the volunteer's to fix on
-- iNaturalist (CONTEXT.md, Upstream). A place name too long for a label is
-- minted as written and flagged (schema/108), and nobody can edit an
-- iNat-linked sample in the app, so a fill-only locality would leave that
-- flag with no one able to clear it (beeline-kza). Nothing a person types is
-- at risk: the in-app editor refuses iNat-linked samples, so on these rows
-- the observation is the only writer. Once a label is on paper the locality
-- stays what the label says (beeline-1kb.2) — that is printed_sample's
-- definition, and it holds for every legacy sample, whose labels the old
-- system printed. A sample frozen into a run that has not printed yet still
-- follows: the snapshot on printed_label is what will print, and this
-- follows the record, so the two can disagree until the run is canceled or
-- printed, which the run page shows the proofer (beeline-1kb.3). The
-- fill-only refresh below still fills a gap on a printed sample, since a
-- label that printed nothing there is contradicted by nothing. A sample
-- whose observation is gone from observation_field keeps what it has. And
-- one a staff member has set stays set (sample_locality_override,
-- beeline-649): the observation is no longer the only writer on that row,
-- and the person outranks it. The override is re-applied after this file
-- runs, so on a rebuild the row briefly reads the observation's value and
-- then the staffer's; the exclusion here is what keeps the nightly from
-- flipping it back in between.
UPDATE sample SET locality = followed.locality
FROM (
  SELECT s.entity_id AS sample_id, loc.locality
  FROM sample s
  JOIN observation_field f ON f.inat_id = s.inat_observation_id
  LEFT JOIN observation_locality loc ON loc.inat_id = f.inat_id
  WHERE NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)
    AND NOT EXISTS (SELECT 1 FROM sample_locality_override o WHERE o.sample_id = s.entity_id)
) followed
WHERE sample.entity_id = followed.sample_id
  AND sample.locality IS DISTINCT FROM followed.locality;

-- ── So does its number (beeline-0199) ───────────────────────────────────
-- Two observations carrying one number are two samples with that number, and
-- duplicate_sample_number asks the volunteer to renumber all but one on
-- iNaturalist. That only works if the sample follows: so an unprinted
-- sample's number tracks its observation's, on the locality's terms and for
-- the same reason — until labels print, the observation is the record
-- (Peter, 2026-10-04). Once a label is on paper the number is the label's.
-- Only a number the observation still carries as a collection record: an
-- observation that drops its number or its count is
-- sample_observation_number_mismatch's to name, not this file's to follow.
UPDATE sample SET sample_number = followed.sample_number
FROM (
  SELECT s.entity_id AS sample_id, c.sample_number
  FROM sample s
  JOIN observation_sample_candidate c ON c.inat_id = s.inat_observation_id
  WHERE NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)
) followed
WHERE sample.entity_id = followed.sample_id
  AND sample.sample_number IS DISTINCT FROM followed.sample_number;

-- ── And its date, while it is one day (beeline-qu2c) ─────────────────────
-- A volunteer who fixes the date on iNaturalist before the labels print has
-- fixed it, and before this nothing carried it across: promotion never
-- rewrote a date, so a wrong date went onto a permanent label. Until the
-- labels print the observation is the record (the number and locality above
-- follow it for the same reason), so an unprinted sample's start and end both
-- become the observation's observed_on. Printed samples are the label's
-- (printed_sample, schema/101), and an observation edited after printing may
-- describe another sample, as the count's test below says.
--
-- Only a sample of a single day (date_end = date_start, which is how every
-- sample writes one day since beeline-ni5m.15): an observation carries one
-- date, so it cannot evidence a trap's range, and collapsing the range onto
-- it would lose the days staff or the form wrote. A sample frozen into a
-- prepared run that has not printed follows too, as the number and locality
-- do: its snapshot on printed_label keeps the old date, and
-- printed_label_out_of_date (schema/155) lists the label as out of date.
-- A sample whose observation is not a collection record
-- (observation_sample_candidate) keeps its date.
--
-- Never a sample staff set the dates of (sample_date_override, schema/030):
-- a date a person set is the sample's date, and staff set it when the
-- observation is wrong or no longer says what the sample did. Staff may do so
-- on any sample, printed or not, and every save of a date writes the row.
-- Taking a staff date away so the sample follows iNaturalist again is not
-- built.
--
-- Not where the observation is cited by another sample, nor where several
-- observations claim the sample (sample_several_observations, schema/108,
-- which counts only observations no other sample cites): one date cannot be
-- right for both. Not sample_multi_observation, which also counts the
-- observations other samples cite, so two samples minted from two observations
-- of one number would stall each other and a volunteer could never clear the
-- duplicate by redating.
--
-- Not where the move would give the sample a number its collector already
-- has on the new day. No constraint stops that (sample numbers are unique
-- only by checks, schema/120's sample_number_conflict, and the forms), so the
-- UPDATE would not fail: it would make a duplicate_sample_number flag for the
-- volunteer to chase. The test is that rule's, collector and day and exact
-- number, against the other samples' dates as they stand now, after the
-- minting above so a sample minted in this pass is among them. It judges
-- current dates only and never guesses where another sample is going: an
-- earlier version substituted the target dates of samples moving in the same
-- pass, and a sample held back by a third one made its neighbour move onto
-- it, a permanent duplicate. So a chain waits a night per link, a swap of two
-- samples' days stays where it is, and two samples that would both move onto
-- one day, the same collector and number, neither moves (the window count).
-- A sample left behind is not silent: qc_rule_observation_date_differs
-- (schema/120) blocks its labels, naming the date the observation says, until
-- staff set the date (which writes sample_date_override) or the volunteer
-- corrects the observation.
--
-- Only a sample with exactly one primary collector: the collision test and
-- the window count run once per sample_primary_collector row, so a sample with
-- two position-1 collectors (which schema/116 can name but the engine cannot
-- prevent) could move onto a day one of them holds. None exists on
-- production's copy of 2026-11-25.
--
-- A date that moves across the 1 March line moves the sample between the open
-- season and a settled one (season.active_since, settled_sample, schema/102):
-- both are read from the date as it stands, so the sample is in whichever
-- season its observation puts it, and a sample that arrives in a settled
-- season waits for staff to release it, as one minted there would.
UPDATE sample SET date_start = followed.observed_on, date_end = followed.observed_on
FROM (
  SELECT sample_id, observed_on
  FROM (
    SELECT s.entity_id AS sample_id, c.observed_on,
           count(*) OVER (PARTITION BY pc.person_id, s.sample_number, c.observed_on) AS movers
    FROM sample s
    JOIN observation_sample_candidate c ON c.inat_id = s.inat_observation_id
    JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
    WHERE (SELECT count(*) FROM sample_primary_collector x WHERE x.sample_id = s.entity_id) = 1
      AND s.date_end = s.date_start
      AND s.date_start <> c.observed_on
      AND NOT EXISTS (SELECT 1 FROM sample_date_override d WHERE d.sample_id = s.entity_id)
      AND NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)
      AND NOT EXISTS (
            SELECT 1 FROM sample o
            WHERE o.inat_observation_id = s.inat_observation_id AND o.entity_id <> s.entity_id)
      AND NOT EXISTS (SELECT 1 FROM sample_several_observations m WHERE m.sample_id = s.entity_id)
      AND NOT EXISTS (
            SELECT 1 FROM sample o
            JOIN sample_primary_collector opc ON opc.sample_id = o.entity_id
            WHERE opc.person_id = pc.person_id
              AND o.sample_number = s.sample_number
              AND o.date_start = c.observed_on
              AND o.entity_id <> s.entity_id)
  ) candidate
  WHERE movers = 1
) followed
WHERE sample.entity_id = followed.sample_id;

-- ── And its specimen count (beeline-ni5m.1, beeline-ni5m.18) ─────────────
-- The sample's count is the DECLARED count: what the volunteer says on
-- iNaturalist. What is on paper is a separate fact (specimen_on_paper,
-- schema/101) that this file never touches, so the count follows the
-- observation up and down whether or not the labels have printed (Peter,
-- 2026-11-25, GitHub #464: a volunteer raised the count after printing and
-- the extra labels never queued). The count decides how many labels a run
-- prints (pending_print_sample, schema/150) and nobody can edit an
-- iNat-linked sample in the app. A printed sample whose count rises has only
-- the new places pending, since the places already on paper are not
-- pending, and a settled one still waits for a release. A count falling
-- below what is on paper is count_below_printed's to name (schema/120).
-- Only a count the observation still carries as a collection record — a
-- positive whole number, which is what makes it a candidate — so an
-- observation whose count goes to zero or to junk is count_mismatch's to
-- name, not this file's to follow.
--
-- Only while exactly one sample cites the observation. The old system
-- printed some pairs of samples against one observation (observation
-- 366102324 is cited by a sample of 10 specimens and another of 7), and
-- copying the observation's count onto both would be wrong for one of them.
-- Such a sample keeps its count, and count_mismatch names the difference
-- (sample_shared_observation, schema/108, lists the pairs).
--
-- Nor where several observations claim the sample (sample_several_observations,
-- counting only observations no other sample cites): it cites one, so one
-- observation's count is not the sample's declared count (a printed sample's
-- count can be the total over all of them). It is the same kind of ambiguity
-- as a shared observation. Not sample_multi_observation, which also counts
-- observations other samples cite: two unprinted samples minted from two
-- observations of one number would never follow their own counts.
--
-- A PRINTED sample follows only while its observation still carries the
-- sample's number and a date within the sample's dates. An observation
-- renumbered or redated after printing may now describe a different
-- collecting event, and its count is then not the count of the bees on these
-- pins. An unprinted sample needs no such test: its number follows its
-- observation earlier in this file, and its dates follow it too unless staff
-- set them or the move was declined (the date follow above), in which case
-- qc_rule_observation_date_differs flags it.
--
-- Whether a sample shares its observation, or is claimed along with others,
-- is judged afresh on every promotion. If staff relink one sample of a pair,
-- the other starts following on the next nightly; that is accepted, since
-- relinking is a deliberate staff repair. A released sample's count stays
-- what it was released at (staff set or vouched for it), and promotion never
-- touches it. Trap samples follow like net samples: the declared count is the
-- observation's, or what staff set in Beeline.
UPDATE sample SET specimen_count = followed.specimen_count
FROM (
  SELECT s.entity_id AS sample_id, c.specimen_count
  FROM sample s
  JOIN observation_sample_candidate c ON c.inat_id = s.inat_observation_id
  WHERE NOT EXISTS (
          SELECT 1 FROM sample o
          WHERE o.inat_observation_id = s.inat_observation_id AND o.entity_id <> s.entity_id)
    -- Staff released it for printing: a count they set or vouched for is theirs
    -- (sample_print_release, schema/102; beeline-3vs.7).
    AND NOT EXISTS (SELECT 1 FROM sample_print_release r WHERE r.sample_id = s.entity_id)
    AND NOT EXISTS (SELECT 1 FROM sample_several_observations m WHERE m.sample_id = s.entity_id)
    AND (NOT EXISTS (SELECT 1 FROM printed_sample ps WHERE ps.sample_id = s.entity_id)
         OR (c.sample_number = s.sample_number AND c.observed_on BETWEEN s.date_start AND s.date_end))
) followed
WHERE sample.entity_id = followed.sample_id
  AND sample.specimen_count IS DISTINCT FROM followed.specimen_count;

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
-- CORRECTION to a field already filled — except an unprinted sample's
-- locality, which follows instead (above); sample_observation_number_mismatch
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

-- ── The floral host follows its observation, printed or not ─────────────
-- Not fill-only, and not stopped by printing (Peter, 2026-10-31,
-- beeline-ni5m.7). Host identifications on iNaturalist improve for years
-- after the observation, often a genuine correction by somebody who knows
-- the plant, and CONTEXT.md has always said Beeline wants those updates; a
-- label never carries the host, so nothing on paper is contradicted. The
-- three columns move together — the taxon id, the name as iNaturalist
-- writes it, and its rank, which decides the italics — so they can never
-- name three different things, which is what the fill-only rule this
-- replaces guarded against one column at a time: it filled the id only
-- where the legacy name agreed with the observation's (beeline-z9j), since
-- an id beside a name it does not belong to is worse than none.
--
-- Only while the observation carries a taxon. One that has none says the
-- bees came off no flower, or that an identification was withdrawn and the
-- community's is pending, and the sample keeps what it has until the
-- observation says something again; a legacy name typed for a sample whose
-- observation never named a plant stays. A sample with no observation is
-- the old system's record and keeps its host as imported.
--
-- Read through observation_host, so a taxon that means no host (Homo sapiens,
-- a user's flag; beeline-rfkj.11) reads as an observation with no taxon: a
-- flag added after a plant was identified does not overwrite the plant.
--
-- Not a sample whose host staff set in Beeline (sample_host_override,
-- beeline-hlay): it keeps what they set, however the observation changes,
-- until they choose to follow iNaturalist again. Both statements below skip it.
UPDATE sample SET
  host_inat_taxon_id    = f.host_taxon_id,
  host_name_as_observed = f.host_taxon_name,
  host_rank             = f.host_taxon_rank
FROM observation_host f
WHERE sample.inat_observation_id = f.inat_id
  AND NOT EXISTS (SELECT 1 FROM sample_host_override o WHERE o.sample_id = sample.entity_id)
  AND f.host_taxon_id IS NOT NULL
  AND (sample.host_inat_taxon_id    IS DISTINCT FROM f.host_taxon_id
    OR sample.host_name_as_observed IS DISTINCT FROM f.host_taxon_name
    OR sample.host_rank             IS DISTINCT FROM f.host_taxon_rank);

-- The flag keeps a plant, but not a host that is no plant. Before the flag,
-- the observation may have been identified as the bee (Apis mellifera), which
-- the sample took as its host and qc_rule_non_tracheophyte_host blocked; that
-- rule reads observation_host, so once the observation is flagged it goes
-- quiet, and the sample would print with the bee as its host. So where the
-- observation is flagged and the taxon cache knows the stored host's lineage
-- and Tracheophyta (211194) is not in it, the host is cleared. Lineage, not
-- standing: being a vascular plant does not change when iNaturalist retires a
-- taxon. A host with no id is kept, and so is one the cache has not read
-- yet, until it has: every sample's host id is on the cache's worklist
-- (inat_taxon_uncached), so the nightly step reads it and the next promotion
-- clears it.
UPDATE sample SET
  host_inat_taxon_id    = NULL,
  host_name_as_observed = NULL,
  host_rank             = NULL
FROM observation_field f
JOIN inat_taxon_not_a_host x ON x.inat_taxon_id = f.host_taxon_id
WHERE sample.inat_observation_id = f.inat_id
  AND NOT EXISTS (SELECT 1 FROM sample_host_override o WHERE o.sample_id = sample.entity_id)
  AND sample.host_inat_taxon_id IN (
    SELECT inat_taxon_id FROM inat_taxon_ancestor
    GROUP BY inat_taxon_id
    HAVING NOT bool_or(ancestor_id = 211194));

-- The atlas joins the refresh now (beeline-6e9). It could not while it was a
-- column on sample: DuckDB will not update an INDEXED column on a row an
-- incoming foreign key references — measured and pinned in test/schema.test.ts
-- — and every sample has a sample_collector row pointing at it, so
-- `UPDATE sample SET atlas_id` failed for every sample in the store, always,
-- and the atlas was set at INSERT or never. As a sample_atlas satellite
-- nothing references, the assignment is writable, and this INSERT drains
-- sample_atlas_unfilled (schema/108) on every promotion: a sample whose
-- geography was uncached when it was minted gets its atlas on the pass after
-- the places fetch instead of never. Fill-only in the same sense as the
-- UPDATE above — the view it reads excludes every human assignment
-- (assigned_by set), including "belongs to none", so the refresh cannot
-- argue with a person.
INSERT INTO sample_atlas (sample_id, atlas_id)
SELECT u.sample_id, u.should_be
FROM sample_atlas_unfilled u;
