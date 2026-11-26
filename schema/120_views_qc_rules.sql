-- QC rule definitions: one view per rule, each producing
-- (sample_id, specimen_id, rule_name, details). Findings are derived, never
-- stored. Metadata (severity) lives in qc_rule (schema/050) and the copy
-- shown with a finding in the message catalog; the union in schema/130. These views see only rows that made it past the
-- ingestion boundary — findings about source records that failed to become
-- samples (unparseable specimen counts, missing identity fields) hang on the
-- ingestion staging layer, designed with phase 2.

-- Label-required fields (mirrors the reference LABEL_REQUIRED_FIELDS).
-- Collector, dates, sample number, and kind are NOT NULL by schema; these are
-- the nullable-by-stance fields the label needs. Coordinates are required as
-- the *presence of a sample_location row* — but only for unobscured samples:
-- when geoprivacy is in play, the obscured_no_true_coordinates rule carries
-- the actionable instructions instead, and firing both would double-flag one
-- root cause.
-- The method is required as the presence of a sample_method row (beeline-ni5m.15),
-- the way the location is: a sample with no method text, or one the list of
-- methods does not know, has none. The finding still names it "protocol", the
-- word the flag chips, the legacy reconciliation and the QC page read.
CREATE VIEW qc_rule_missing_required_field AS
SELECT sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'missing_required_field' AS rule_name,
       concat_ws(', ',
         CASE WHEN missing_location THEN 'location' END,
         CASE WHEN country IS NULL THEN 'country' END,
         CASE WHEN state_province IS NULL THEN 'state_province' END,
         CASE WHEN locality IS NULL THEN 'locality' END,
         CASE WHEN missing_method THEN 'protocol' END
       ) AS details
FROM (
  SELECT s.entity_id AS sample_id, s.country, s.state_province, s.locality,
         (loc.sample_id IS NULL AND s.geoprivacy IS NULL AND s.taxon_geoprivacy IS NULL) AS missing_location,
         (m.sample_id IS NULL) AS missing_method
  FROM sample s
  LEFT JOIN sample_location loc ON loc.sample_id = s.entity_id
  LEFT JOIN sample_method m ON m.sample_id = s.entity_id
) t
WHERE missing_location
   OR country IS NULL OR state_province IS NULL
   OR locality IS NULL OR missing_method;

-- Flagged when empty but not label-blocking (reference nonEmptyFields minus
-- LABEL_REQUIRED_FIELDS). Elevation is deliberately absent from both rules:
-- it is derived from coordinates, never the collector's gap to fill.
CREATE VIEW qc_rule_missing_recommended_field AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'missing_recommended_field' AS rule_name,
       'county' AS details
FROM sample s
WHERE s.county IS NULL;

-- An obscured sample without believed-true coordinates has no location at all
-- in the sample layer (shifted pairs never enter it) — this rule, not
-- missing_required_field, carries the actionable fix (CONTEXT.md, Coordinates
-- & privacy).
CREATE VIEW qc_rule_obscured_no_true_coordinates AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'obscured_no_true_coordinates' AS rule_name,
       concat_ws(', ',
         CASE WHEN s.geoprivacy IS NOT NULL THEN concat('geoprivacy=', s.geoprivacy) END,
         CASE WHEN s.taxon_geoprivacy IS NOT NULL THEN concat('taxon_geoprivacy=', s.taxon_geoprivacy) END
       ) AS details
FROM sample s
LEFT JOIN sample_location loc ON loc.sample_id = s.entity_id
WHERE (s.geoprivacy IS NOT NULL OR s.taxon_geoprivacy IS NOT NULL)
  AND loc.sample_id IS NULL;

-- Locality must fit a 3-5pt label cell: 18 characters at most, no comma and
-- no double quote (single quotes are fine — O'Brien is a name). Those are the
-- label's physical limits, from the reference implementation
-- (OccurrenceService.updateErrorFlags).
--
-- A street address is NOT flagged, though the reference forbade one and this
-- rule followed it until 2026-10-31: Andony no longer remembers why, and a
-- volunteer who writes one has made their choice (Peter, relaying Andony).
-- Beeline still never OFFERS a street as a locality (src/locality-rule.ts,
-- looksLikeStreet), and minting still skips a street component of an
-- observation's place guess (observation_locality, schema/108); since
-- Beeline is to name every locality itself, that is beeline-kkst's to settle.
--
-- A locality that is only a county ("Benton County") is still flagged, as it
-- was when the street suffixes caught it: the county prints in its own place
-- on the label, so as a locality it says nothing. Whether that, too, is the
-- volunteer's call is not decided.
CREATE VIEW qc_rule_locality_format AS
SELECT sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'locality_format' AS rule_name,
       concat_ws('; ',
         CASE WHEN len > 18 THEN concat('longer than 18 chars (', len, ')') END,
         CASE WHEN has_comma THEN 'contains comma' END,
         CASE WHEN has_quote THEN 'contains double quote' END,
         CASE WHEN is_county THEN 'names only a county' END
       ) AS details
FROM (
  SELECT s.entity_id AS sample_id,
         length(s.locality) AS len,
         position(',' IN s.locality) > 0 AS has_comma,
         position('"' IN s.locality) > 0 AS has_quote,
         rtrim(lower(trim(s.locality)), '. ') LIKE '% county' AS is_county
  FROM sample s
  WHERE s.locality IS NOT NULL
) flags
WHERE len > 18 OR has_comma OR has_quote OR is_county;

-- Country must be an abbreviation (≤ 3 chars), state/province likewise
-- (≤ 2): the label cell is tiny. Length checks exactly as the reference —
-- no abbreviation table involved (its Wyoming bug lived in the ingest-side
-- mapping, not here).
CREATE VIEW qc_rule_place_unabbreviated AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'place_unabbreviated' AS rule_name,
       concat_ws(', ',
         CASE WHEN length(s.country) > 3 THEN concat('country ''', s.country, '''') END,
         CASE WHEN length(s.state_province) > 2 THEN concat('state_province ''', s.state_province, '''') END
       ) AS details
FROM sample s
WHERE length(s.country) > 3 OR length(s.state_province) > 2;

-- Whether the stated place resolves to a region at all — the rule that keeps
-- sample.atlas_id honest (beeline-lcl). Collecting outside the six atlases is
-- ordinary and unflagged: atlas_region carries a row for every US state and
-- Canadian province, and a NULL atlas on one of those rows means "no member
-- atlas covers this", not "something went wrong". What this fires on is a
-- place the lookup cannot find, and a place whose country contradicts it —
-- Bonnie Zand collecting in Kane County, Utah with her usual CAN in the
-- country field, which the old six-way CASE filed silently under "outside".
-- A missing state_province is missing_required_field's to report, not this
-- rule's: one root cause, one flag.
CREATE VIEW qc_rule_place_unrecognised AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'place_unrecognised' AS rule_name,
       CASE WHEN reg.state_province IS NULL
            THEN concat('state_province ''', s.state_province, ''' is not a US state or Canadian province')
            ELSE concat('country ''', s.country, ''' disagrees: ', s.state_province, ' is in ', reg.country)
       END AS details
FROM sample s
LEFT JOIN atlas_region reg ON reg.state_province = s.state_province
WHERE s.state_province IS NOT NULL
  AND (reg.state_province IS NULL OR (s.country IS NOT NULL AND s.country <> reg.country));

-- How precise a coordinate has to be before a label may carry it, and from
-- when. Two numbers, because the rule changed and could not change
-- retroactively (#22).
--
-- 100 m is the answer and always was: it is the resolution of three decimal
-- places of latitude, which is what a GPS reports (Andony, 2026-08-31). The
-- 250 m that had been in force was a transcription error, not a decision.
--
-- It cannot be applied backwards everywhere. A volunteer can tighten the pin
-- on their own iNaturalist observation and the next sync picks it up — but
-- only while they still have the specimens, and for older records the bees
-- have often long since left their possession. Blocking those would demand a
-- correction nobody is able to make. So records predating the change keep
-- 250 m where that is so: once printed, or once their season has settled and
-- staff have not released them for printing (sample_coordinate_limit, below,
-- which says why the line moved there).
--
-- Judged on date_end: a trap line that ran across the boundary is held to
-- the limit in force when it was emptied.
CREATE VIEW coordinate_precision_rule AS
SELECT 100 AS uncertainty_m,
       250 AS grandfathered_uncertainty_m,
       DATE '2026-09-02' AS effective_from;
COMMENT ON VIEW coordinate_precision_rule IS 'One row: the coordinate uncertainty a label may carry, the looser limit records predating the change keep, and the date dividing them (#22).';

-- The limit that applies to one sample, named once so the rule below and
-- anything else that has to explain itself to a volunteer agree about it.
--
-- The grandfathered 250 m is for records nobody can fix any more, and that
-- turned out to be narrower than "collected before the change". Peter,
-- 2026-11-04, before the first production print run: an unprinted sample in
-- an active season is held to 100 m whenever it was collected, because its
-- collector can still tighten the pin and a label with a 180 m circle would
-- also go out with no elevation (elevation_derivation_limit). So 250 m stays
-- only for a sample that has printed, whose label is on a pin already, and
-- for one from a settled season that staff have not released, which never
-- prints and whose collector has mostly long since handed the bees over. A
-- released settled sample will print, so it is held to 100 m like an active
-- one (beeline-3vs.7, settled_unreleased_sample, schema/102).
--
-- Of the unprinted samples in the 100-250 m band on the morning of
-- 2026-11-04, 4 were in active seasons (3 of them, 10 labels, in that day's
-- run) and 38 settled.
--
-- Printed and settled-unreleased are LEFT JOINs that found nothing, where they were NOT
-- EXISTS inside the CASE. It is one of three shapes changed together so that
-- a sample page, asking for one sample's findings, does not work out which
-- of all 70,000 samples have printed (beeline-poon; the others are in
-- sample_number_conflict and qc_rule_sample_number below). Together they
-- took one sample's findings from 35 ms to 23 on production's store of
-- 2026-11-17. Each of the two views has at most one row per sample, so the
-- joins add no rows.
CREATE VIEW sample_coordinate_limit AS
SELECT s.entity_id AS sample_id,
       CASE WHEN s.date_end >= r.effective_from
              OR (p.sample_id IS NULL AND st.sample_id IS NULL)
            THEN r.uncertainty_m
            ELSE r.grandfathered_uncertainty_m END AS uncertainty_m
FROM sample s
CROSS JOIN coordinate_precision_rule r
LEFT JOIN printed_sample p ON p.sample_id = s.entity_id
LEFT JOIN settled_unreleased_sample st ON st.sample_id = s.entity_id;
COMMENT ON VIEW sample_coordinate_limit IS 'Per sample: the coordinate uncertainty above which it cannot be printed. 100 m, except 250 m for a sample collected before 2 September 2026 that has printed or is in a settled season and not released for printing.';

CREATE VIEW qc_rule_coordinate_uncertainty AS
SELECT loc.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'coordinate_uncertainty' AS rule_name,
       -- Names the limit that applied, not a constant: two are in force, and
       -- a volunteer reading the flag needs to know which one their record
       -- was held to.
       concat(loc.coordinate_uncertainty_m, ' m > ', lim.uncertainty_m, ' m') AS details
FROM sample_location loc
JOIN sample_coordinate_limit lim ON lim.sample_id = loc.sample_id
WHERE loc.coordinate_uncertainty_m > lim.uncertainty_m;

-- A coordinate that cannot be where the record says it is: outside North
-- America and its waters, on a record whose own country is a North American
-- one or is absent (beeline-iwf).
--
-- The signature is a pin that moved after its place_guess was written.
-- iNaturalist recomputes place_ids and leaves place_guess alone, so such an
-- observation carries an Oregon locality string and an EMPTY place list —
-- an open-ocean point is inside no place. Nothing else in the store notices:
-- the atlas comes from state_province rather than from the point, so the
-- record looks well placed everywhere except the point itself.
--
-- coordinate_uncertainty catches one of these today, and only by luck — the
-- observation behind sample 122269 carries an accuracy circle of 1,196 km.
-- The others do not: two of the four are a longitude with its sign flipped
-- (44.1360, +120.7010 and 44.6807, +121.1523 — central Oregon written as
-- central Asia), which is as precise as any other pin.
--
-- The box is deliberately generous: 14..84 N, 172..50 W is Mexico through
-- Alaska and Greenland, plus coastal water. A member collecting in Baja or
-- the Yukon is not a defect, and the atlases' own footprint would be the
-- wrong bound — 144 open-season locations sit outside the western states,
-- which is members travelling.
--
-- The country clause is what stops this being the kind of finding that
-- damages data (beeline-4dt): a record that says NZL and sits in New Zealand
-- is honest, there is no way to satisfy a flag on it, and findings have no
-- accepted state. Four rows fire on the dev store, all settled, all of them
-- errors; the fifth row outside the box is that New Zealand record.
CREATE VIEW qc_rule_coordinate_out_of_region AS
SELECT loc.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'coordinate_out_of_region' AS rule_name,
       concat(round(loc.latitude, 4), ', ', round(loc.longitude, 4),
              ' is not in North America, but this record says ',
              coalesce(s.country, 'no country at all')) AS details
FROM sample_location loc
JOIN sample s ON s.entity_id = loc.sample_id
WHERE NOT (loc.latitude BETWEEN 14 AND 84 AND loc.longitude BETWEEN -172 AND -50)
  AND (s.country IS NULL OR s.country IN ('USA', 'CAN', 'MEX'));

-- Same collector, same day, same sample number, more than once: an identity
-- collision the reference implementation silently merged — and so, it turned
-- out, did Beeline. Counting samples, the rule never fired once (0 findings
-- on the sandbox, 2026-10-04): legacy promotion and minting both merge on
-- that very key first, so the duplicate lands inside one sample, claimed by
-- several observations. Peter, 2026-10-04: several observations claiming one
-- sample number is collector error. So a conflict is either shape: two
-- samples sharing the key, or one sample several observations claim
-- (sample_several_observations, schema/108).
--
-- The first shape joins each sample to the samples that share its key, itself
-- among them, and counts them. Counting every key first and joining the
-- counts back gives the same rows, but counts all 70,000 samples to answer
-- for one (beeline-poon); this way the one sample is looked up and its key
-- matched. The collector is grouped on as well as the sample, so that a
-- sample with two collectors at position 1, which the engine cannot prevent
-- (schema/116), is counted once under each and not as a duplicate of itself.
CREATE VIEW sample_number_conflict AS
SELECT s.sample_id,
       concat('sample number ', s.sample_number, ' used ', count(*), ' times on ', s.date_start) AS details
FROM (SELECT s.entity_id AS sample_id, pc.person_id, s.date_start, s.sample_number
      FROM sample s
      JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id) s
JOIN (SELECT pc.person_id, s.date_start, s.sample_number
      FROM sample s
      JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id) same
  ON same.person_id = s.person_id
 AND same.date_start = s.date_start
 AND same.sample_number = s.sample_number
GROUP BY s.sample_id, s.person_id, s.sample_number, s.date_start
HAVING count(*) > 1
UNION ALL
SELECT s.entity_id,
       concat('sample number ', s.sample_number, ' is on ', o.observations, ' observations: ', o.inat_ids)
FROM sample s
JOIN sample_several_observations o ON o.sample_id = s.entity_id;
COMMENT ON VIEW sample_number_conflict IS 'A sample whose number its collector used more than once that day: two samples sharing (collector, date, number), or several observations claiming one (beeline-0199). qc_rule_sample_number flags it where the sample is not yet printed; a printed one is named here and flagged nowhere.';

-- Only a sample not yet printed is flagged: renumbering is the fix, asked of
-- the volunteer, and since an unprinted sample's number follows its
-- observation (ingest/mint-samples.sql), renumbering on iNaturalist clears it
-- on the next nightly. A printed one is not flagged at all (Peter,
-- 2026-10-04): its pins carry the number for good and there is nothing left
-- to do — legacy promotion already splits a merged sample by observation —
-- so sample_number_conflict still names it, for reporting, and nothing asks.
--
-- One finding per sample, its two cases joined: a waiver names a flag by its
-- sample and rule (schema/050), and two findings under one rule would let a
-- waiver on one hide the other.
--
-- Not printed is "no specimen of it is on paper", which is printed_sample's
-- own test (schema/101) without the pass that reduces 400,000 specimens to
-- one row per sample, which this has no use for.
CREATE VIEW qc_rule_sample_number AS
SELECT c.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'duplicate_sample_number' AS rule_name,
       string_agg(c.details, '; ' ORDER BY c.details) AS details
FROM sample_number_conflict c
WHERE NOT EXISTS (SELECT 1 FROM specimen_on_paper p WHERE p.sample_id = c.sample_id)
GROUP BY c.sample_id;

-- The evidencing observation's taxon is the floral host in this protocol,
-- and a host must be a vascular plant: anything else — a moss, a fungus, or
-- the bee itself — means the observation is identified as the wrong subject.
-- Mirrors the reference phylumPlant ≠ Tracheophyta check, with ancestry read
-- from the stored projection (observation_field, schema/060) instead of a
-- Darwin Core phylum string. IS FALSE keeps stale loads silent: NULL means
-- no taxon or a load predating ancestor_ids, not a non-plant host. Read
-- through observation_host, so a taxon that means no host (Homo sapiens, a
-- user's flag, beeline-rfkj.11) is no host here either, as it is to minting:
-- the 46 samples it blocked on production's store of 2026-11-15 were not a
-- volunteer's mistake to fix.
--
-- This rule's detail IS a scientific name, so it is the one rule that reports
-- a taxon rather than prose about one, and it says so in its own columns
-- (beeline-dys). Rendered from `details` it reached the screen inside a
-- <code>, which /design/type and /design/names both forbid: Andrena and
-- Apis mellifera want italics, Life and Insecta must not have them, and no view can
-- tell which is which from a string. Name and rank are what TaxonName needs
-- to decide, so both travel. `details` is then the fallback and only the
-- fallback — the projection occasionally has an id and no name.
CREATE VIEW qc_rule_non_tracheophyte_host AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'non_tracheophyte_host' AS rule_name,
       CASE WHEN f.host_taxon_name IS NULL
            THEN concat('observation taxon ', CAST(f.host_taxon_id AS TEXT), ' is not a vascular plant')
       END AS details,
       f.host_taxon_name AS detail_taxon_name,
       f.host_taxon_rank AS detail_taxon_rank
FROM sample s
JOIN observation_host f ON f.inat_id = s.inat_observation_id
WHERE f.host_is_tracheophyte IS FALSE
  AND NOT EXISTS (SELECT 1 FROM sample_host_override o WHERE o.sample_id = s.entity_id)
UNION ALL
-- A host staff set is judged by that host and never by the observation
-- (beeline-hlay). It was checked when it was set, so this fires only on a row
-- that reached the overlay file another way, and only where the taxon cache's
-- lineage says the host is no vascular plant: an unknown lineage does not, and
-- no floral host never does.
SELECT s.entity_id, CAST(NULL AS INTEGER), 'non_tracheophyte_host',
       CASE WHEN o.host_name IS NULL
            THEN concat('staff host taxon ', CAST(o.host_inat_taxon_id AS TEXT), ' is not a vascular plant')
       END,
       o.host_name, o.host_rank
FROM sample s
JOIN sample_host_override o ON o.sample_id = s.entity_id
JOIN sample_host h ON h.sample_id = s.entity_id
WHERE h.is_vascular IS FALSE;

-- The sample's evidencing observation asserts a different specimen count
-- than the sample carries, or one that is not a count at all. Warning. A
-- sample's count follows its observation, printed or not, while the
-- observation still carries a positive whole number and no other sample
-- cites it (ingest/mint-samples.sql, beeline-ni5m.1 and beeline-ni5m.18), so
-- this can only say: the observation's count is zero, negative or not a
-- number ('lots'); or the observation is shared with another sample, which
-- keeps its own count; or the sample was released for printing, whose count
-- is then staff's. A count the observation does not carry at all is not a
-- disagreement.
CREATE VIEW qc_rule_count_mismatch AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'count_mismatch' AS rule_name,
       CASE WHEN try_cast(f.specimen_count_raw AS INTEGER) IS NULL
            THEN concat('observation says ''', f.specimen_count_raw, ''', which is not a count, but sample count is ', s.specimen_count)
            ELSE concat('observation says ', f.specimen_count_raw, ' but sample count is ', s.specimen_count) END AS details
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
WHERE nullif(trim(f.specimen_count_raw), '') IS NOT NULL
  AND try_cast(f.specimen_count_raw AS INTEGER) IS DISTINCT FROM s.specimen_count;

-- The sample's evidencing observation stopped coming back: a completed run
-- that should have covered it (same source, window containing its observed
-- date, started after the observation was last seen) did not return it. That
-- means deleted, removed from the project, or its date edited out of the
-- window — all "staff investigate", and printing more specimens on vanished
-- evidence would be a mistake, so the rule blocks. Presence comes from
-- observation_seen: loads are hash-deduped, so absence of a load row cannot
-- distinguish unchanged from gone. A later run that sees the observation
-- again clears the finding by advancing last_seen_at.
--
-- Every condition on the run is in the one join, so a pair of observation and
-- run is judged once, and everything the join needs about the observation is
-- in one row before it, so the planner cannot take the conditions apart. It
-- did: written as three WITH steps (migrations/0056), DuckDB 1.5 judged a
-- pair once, and DuckDB 2.0 first paired each observation with every run
-- that started after it was last seen, two million pairs on production's
-- store of 2026-11-17, nearly all of them an old observation against a
-- weekly sweep whose year-long window never reached it, and only then looked
-- at the window. Asked on its own, or for its text as a sample page asks,
-- that took 78 ms; inside a listing's count of flags the planner happened to
-- choose well and it took about 15. This takes 29 however it is asked
-- (beeline-poon).
--
-- It starts from the sample so that a page asking about one sample reads
-- that sample's sightings and no others. What it cannot avoid, asked about
-- every sample, is reading all of observation_seen, which is why that table
-- keeps only the latest sighting of an observation by each source
-- (schema/060, beeline-amdt).
CREATE VIEW qc_rule_observation_missing_upstream AS
SELECT o.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'observation_missing_upstream' AS rule_name,
       -- Says when the observation was last returned, which stays put until
       -- a sync returns it again and the flag clears: a waiver is tied to
       -- what the flag says (schema/050), and a count of the runs that
       -- missed it changed with every sync.
       concat('observation ', o.inat_observation_id, ' not returned by a sync since ',
              CAST(CAST(o.last_seen_at AS DATE) AS VARCHAR)) AS details
FROM (
  -- A sample's observation, once per source that has returned it, with the
  -- last time any source did.
  SELECT s.entity_id AS sample_id, s.inat_observation_id, f.user_id, f.observed_on, seen_by.source,
         max(max(seen_by.started_at)) OVER (PARTITION BY s.entity_id) AS last_seen_at
  FROM sample s
  JOIN observation_field f ON f.inat_id = s.inat_observation_id
  JOIN observation_seen sn ON sn.inat_id = s.inat_observation_id
  JOIN sync_run seen_by ON seen_by.entity_id = sn.sync_run_id
  GROUP BY s.entity_id, s.inat_observation_id, f.user_id, f.observed_on, seen_by.source
) o
JOIN sync_run r
  ON r.source = o.source
 AND r.completed_at IS NOT NULL
 AND r.started_at > o.last_seen_at
 -- Incremental (updated_since) runs fetch only the changed subset: they can
 -- never prove an observation gone, so they are not covering runs.
 AND r.updated_since IS NULL
 -- A run that asked for one observer's observations (the dashboard's
 -- "Check iNaturalist now", beeline-yso) proves absence for that observer
 -- only: it covers everyone else's observations no more than an
 -- incremental run does.
 AND (r.observer_user_id IS NULL OR r.observer_user_id = o.user_id)
 -- A run that asked for particular observations by id (beeline-7vsw) is
 -- silent about every observation it did not ask for.
 AND NOT coalesce(r.fetched_by_id, false)
 AND (r.window_start IS NULL OR o.observed_on >= r.window_start)
 AND (r.window_end IS NULL OR o.observed_on <= r.window_end)
GROUP BY o.sample_id, o.inat_observation_id, o.last_seen_at
-- And the observation no sync ever returned, which iNaturalist answered
-- without when asked for it by id (schema/060 observation_absent,
-- beeline-wcc6): the legacy records cite hundreds deleted before the first
-- sync, and the branch above cannot see them, since it starts from a
-- projection they never had. The date is the first time iNaturalist said so,
-- which stays put for the waiver's sake as last_seen_at does above.
UNION ALL
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'observation_missing_upstream' AS rule_name,
       concat('observation ', s.inat_observation_id, ' not found on iNaturalist since ',
              CAST(CAST(ab.absent_since AS DATE) AS VARCHAR)) AS details
FROM sample s
JOIN observation_absent ab ON ab.inat_id = s.inat_observation_id
WHERE NOT EXISTS (SELECT 1 FROM observation_field f WHERE f.inat_id = s.inat_observation_id);

-- Post-print trouble: count fell below the number of specimens already frozen
-- — individuated ones (schema/117), so a canceled run's leftovers do not
-- raise it; a prepared run's do, which is the proofer's signal.
CREATE VIEW qc_rule_count_below_printed AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'count_below_printed' AS rule_name,
       concat(printed.n, ' specimens printed but count is ', s.specimen_count) AS details
FROM sample s
JOIN (
  SELECT sample_id, count(*) AS n FROM individuated_specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE printed.n > s.specimen_count;

-- An unprinted sample whose one day is not its observation's (beeline-qu2c).
-- The date follow in ingest/mint-samples.sql moves an unprinted one-day
-- sample onto its observation's date, but declines where the move would
-- collide (a day another sample of the collector holds with the number, two
-- samples moving onto one day, a swap), where the observation is shared with
-- another sample or several observations claim the sample, or where it
-- cannot tell which one sample is meant. Nothing else would say so, and the
-- labels would print a date the volunteer has said is wrong. Blocking, so
-- they wait for staff to set the date (which writes sample_date_override and
-- clears the flag) or for the volunteer to correct the observation's date or
-- number. A sample whose date staff set, one of several days (an observation
-- cannot evidence a range) and a printed one (its date is the label's; not
-- on paper is specimen_on_paper's own test, schema/101, as qc_rule_sample_number
-- asks it) never raise it. Measured on production's copy of 2026-11-25: no
-- sample is in this state, so it raises nothing when deployed.
CREATE VIEW qc_rule_observation_date_differs AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'observation_date_differs' AS rule_name,
       concat('observation says ', CAST(c.observed_on AS TEXT), ', sample says ', CAST(s.date_start AS TEXT)) AS details
FROM sample s
JOIN observation_sample_candidate c ON c.inat_id = s.inat_observation_id
WHERE s.date_end = s.date_start
  AND s.date_start <> c.observed_on
  AND NOT EXISTS (SELECT 1 FROM sample_date_override d WHERE d.sample_id = s.entity_id)
  AND NOT EXISTS (SELECT 1 FROM specimen_on_paper p WHERE p.sample_id = s.entity_id);
COMMENT ON VIEW qc_rule_observation_date_differs IS 'An unprinted sample of one day whose observation says another day, and whose date staff have not set: the date follow in ingest/mint-samples.sql declined to move it (a collision, a shared observation, several observations claiming it), so its labels would print a date the volunteer has said is wrong. Blocking (beeline-qu2c).';

-- A sample staff are holding back from printing (beeline-plu, schema/050).
-- The reason is the details, because it is what both readers need: the
-- collector, who may have something to fix, and the printer.
CREATE VIEW qc_rule_staff_hold AS
SELECT h.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'staff_hold' AS rule_name,
       h.reason AS details
FROM sample_hold h;
