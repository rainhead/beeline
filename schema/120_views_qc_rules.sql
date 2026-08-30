-- QC rule definitions: one view per rule, each producing
-- (sample_id, specimen_id, rule_name, details). Findings are derived, never
-- stored. Metadata (severity, instructions) lives in qc_rule (schema/050);
-- the union in schema/130. These views see only rows that made it past the
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
CREATE VIEW qc_rule_missing_required_field AS
SELECT sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'missing_required_field' AS rule_name,
       concat_ws(', ',
         CASE WHEN missing_location THEN 'location' END,
         CASE WHEN country IS NULL THEN 'country' END,
         CASE WHEN state_province IS NULL THEN 'state_province' END,
         CASE WHEN locality IS NULL THEN 'locality' END,
         CASE WHEN protocol IS NULL THEN 'protocol' END
       ) AS details
FROM (
  SELECT s.entity_id AS sample_id, s.country, s.state_province, s.locality, s.protocol,
         (loc.sample_id IS NULL AND s.geoprivacy IS NULL AND s.taxon_geoprivacy IS NULL) AS missing_location
  FROM sample s
  LEFT JOIN sample_location loc ON loc.sample_id = s.entity_id
) t
WHERE missing_location
   OR country IS NULL OR state_province IS NULL
   OR locality IS NULL OR protocol IS NULL;

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

-- Locality must fit a 3-5pt label cell: short place name, no punctuation, no
-- street addresses. Semantics follow the reference implementation
-- (OccurrenceService.updateErrorFlags + includesIllegalSuffix): length > 18,
-- comma or double quote (single quotes are fine — O''Brien Rd is a name),
-- or a word-bounded street/county suffix. norm pads the locality with
-- spaces, turns periods into spaces and isolates commas, which is what
-- supplies the word boundaries the reference got from lookarounds — so no
-- lookbehind is needed and a plain alternation is a faithful translation.
--
-- The one place it deliberately parts from the reference is WHERE the
-- suffix may sit: it has to end its phrase, or 'St Helens' is a street
-- address. locality_street_suffix_pattern (schema/108) carries that
-- argument and the measurements behind it (beeline-4dt).
--
-- The second accepted DuckDB-flavoured seam, after the JSON shredding in
-- schema/105, and a deliberate one (Peter, 2026-08-28; beeline-2c3.37).
-- `regexp_matches` returns a boolean here and text[] on Postgres, so a port
-- rewrites this predicate — which is a known line of work rather than a
-- silent difference, and worth it: nineteen LIKE passes over every locality
-- in the store cost 187 ms, one alternation costs 15 ms, and with the
-- observation projection stored (beeline-2c3.36) this rule *was* the entire
-- remaining cost of scanning qc_finding. Every QC read in the app goes
-- through that union.
--
-- Do NOT reach for `~` when porting or when writing the next one of these:
-- DuckDB's `~` is regexp_full_match and Postgres's is a partial match, so
-- the same operator quietly answers differently in the two engines. That is
-- the one spelling here that would fail without erroring.
CREATE VIEW qc_rule_locality_format AS
SELECT sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'locality_format' AS rule_name,
       concat_ws('; ',
         CASE WHEN len > 18 THEN concat('longer than 18 chars (', len, ')') END,
         CASE WHEN has_comma THEN 'contains comma' END,
         CASE WHEN has_quote THEN 'contains double quote' END,
         CASE WHEN is_street THEN 'looks like a street address' END
       ) AS details
FROM (
  SELECT norm.sample_id,
         length(norm.locality) AS len,
         position(',' IN norm.locality) > 0 AS has_comma,
         position('"' IN norm.locality) > 0 AS has_quote,
         -- The same seventeen words the reference checks, each still
         -- required to stand alone between spaces — and, since beeline-4dt,
         -- to END its phrase, because `st` is Saint and State as well as
         -- Street. The predicate lives in locality_street_suffix_pattern
         -- (schema/108), which says why — and as a macro, because a regex
         -- read from a subquery is recompiled per row — because
         -- observation_locality applies it too, to pick a locality that does
         -- not exist yet where this judges one that does.
         regexp_matches(norm.norm, locality_street_suffix_pattern()) AS is_street
  FROM (
    -- A comma ends a phrase, so it survives normalisation as its own token
    -- rather than becoming a space: 'NW Harrison Blvd, Corvallis' is an
    -- address and the anchor has to be able to see that.
    SELECT s.entity_id AS sample_id, s.locality,
           concat(' ', replace(replace(lower(s.locality), '.', ' '), ',', ' , '), ' ') AS norm
    FROM sample s
    WHERE s.locality IS NOT NULL
  ) norm
) flags
WHERE len > 18 OR has_comma OR has_quote OR is_street;

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

CREATE VIEW qc_rule_coordinate_uncertainty AS
SELECT loc.sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'coordinate_uncertainty' AS rule_name,
       concat(loc.coordinate_uncertainty_m, ' m > 250 m') AS details
FROM sample_location loc
WHERE loc.coordinate_uncertainty_m > 250;

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

-- Same collector, same day, same sample number, more than one sample: an
-- identity collision the reference implementation silently merged.
CREATE VIEW qc_rule_duplicate_sample_number AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'duplicate_sample_number' AS rule_name,
       concat('sample number ', s.sample_number, ' used ', dup.n, ' times on ', s.date_start) AS details
FROM sample s
JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
JOIN (
  SELECT pc.person_id, s.date_start, s.sample_number, count(*) AS n
  FROM sample s
  JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
  GROUP BY pc.person_id, s.date_start, s.sample_number
  HAVING count(*) > 1
) dup ON dup.person_id = pc.person_id
     AND dup.date_start = s.date_start
     AND dup.sample_number = s.sample_number;

-- The evidencing observation's taxon is the floral host in this protocol,
-- and a host must be a vascular plant: anything else — a moss, a fungus, or
-- the bee itself — means the observation is identified as the wrong subject.
-- Mirrors the reference phylumPlant ≠ Tracheophyta check, with ancestry read
-- from the stored projection (observation_field, schema/060) instead of a
-- Darwin Core phylum string. IS FALSE keeps stale loads silent: NULL means
-- no taxon or a load predating ancestor_ids, not a non-plant host.
CREATE VIEW qc_rule_non_tracheophyte_host AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'non_tracheophyte_host' AS rule_name,
       concat('observation taxon ', coalesce(f.host_taxon_name, CAST(f.host_taxon_id AS TEXT)),
              ' is not a vascular plant') AS details
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
WHERE f.host_is_tracheophyte IS FALSE;

-- The sample's evidencing observation asserts a different specimen count
-- than the sample carries: someone changed one side. Warning — counts move
-- legitimately until printing; staff/self-service reconcile.
CREATE VIEW qc_rule_count_mismatch AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'count_mismatch' AS rule_name,
       concat('observation says ', f.specimen_count_raw, ' but sample count is ', s.specimen_count) AS details
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
WHERE try_cast(f.specimen_count_raw AS INTEGER) IS NOT NULL
  AND try_cast(f.specimen_count_raw AS INTEGER) <> s.specimen_count;

-- The sample's evidencing observation stopped coming back: a completed run
-- that should have covered it (same source, window containing its observed
-- date, started after the observation was last seen) did not return it. That
-- means deleted, removed from the project, or its date edited out of the
-- window — all "staff investigate", and printing more specimens on vanished
-- evidence would be a mistake, so the rule blocks. Presence comes from
-- observation_seen: loads are hash-deduped, so absence of a load row cannot
-- distinguish unchanged from gone. A later run that sees the observation
-- again clears the finding by advancing last_seen_at.
CREATE VIEW qc_rule_observation_missing_upstream AS
WITH last_seen AS (
  SELECT sn.inat_id, max(r.started_at) AS last_seen_at
  FROM observation_seen sn
  JOIN sync_run r ON r.entity_id = sn.sync_run_id
  GROUP BY sn.inat_id
), seen_source AS (
  SELECT DISTINCT sn.inat_id, r.source
  FROM observation_seen sn
  JOIN sync_run r ON r.entity_id = sn.sync_run_id
)
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'observation_missing_upstream' AS rule_name,
       concat('observation ', s.inat_observation_id, ' missing from ',
              count(*), ' completed covering run(s), latest started ',
              max(r.started_at)) AS details
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
JOIN last_seen ls ON ls.inat_id = f.inat_id
JOIN seen_source ss ON ss.inat_id = f.inat_id
JOIN sync_run r
  ON r.source = ss.source
 AND r.completed_at IS NOT NULL
 AND r.started_at > ls.last_seen_at
 -- Incremental (updated_since) runs fetch only the changed subset: they can
 -- never prove an observation gone, so they are not covering runs.
 AND r.updated_since IS NULL
 AND (r.window_start IS NULL OR f.observed_on >= r.window_start)
 AND (r.window_end IS NULL OR f.observed_on <= r.window_end)
GROUP BY s.entity_id, s.inat_observation_id;

-- Post-print trouble: count fell below the number of specimens already frozen.
CREATE VIEW qc_rule_count_below_printed AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'count_below_printed' AS rule_name,
       concat(printed.n, ' specimens printed but count is ', s.specimen_count) AS details
FROM sample s
JOIN (
  SELECT sample_id, count(*) AS n FROM specimen GROUP BY sample_id
) printed ON printed.sample_id = s.entity_id
WHERE printed.n > s.specimen_count;
