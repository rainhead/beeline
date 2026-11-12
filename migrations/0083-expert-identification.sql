-- Migration for schema/111_view_expert_identification.sql (beeline-xegx):
-- the expert identifications of each specimen, for the front page's feed.

-- What experts have said each specimen is, as a story rather than as rows
-- (beeline-xegx): one row for each stretch of a specimen's expert
-- determinations that agree on the name, so a volunteer can be shown when
-- their bee was identified, and when an expert changed their mind.
--
-- Not one row per determination, because a new determination is not always
-- news. The Ecdysis loader records the identification Ecdysis calls current
-- as a new event even when it repeats the name the old Beeline already held
-- for the specimen (src/load-ecdysis.ts), and on production the first load
-- recorded 36,359 in one night (2026-11-04), most of them names volunteers
-- had already been shown. Consecutive determinations with the same node and
-- qualifier are therefore one identification; a different node or qualifier
-- starts the next, and so does a different person giving the same name where
-- both are people Beeline knows: an expert confirming a name, most often a
-- volunteer's own that Washington's staff uploaded to Ecdysis (514 on the store
-- of 2026-11-11, 469 of them the collector's). Two determinations naming nobody,
-- or one, stay one stretch, so the old Beeline's unattributed copy of a name
-- and Ecdysis's repeat of it are still one. Expert determinations only: a volunteer's own name for
-- their bee is not news to them, and an expert's stays the record whatever
-- a volunteer says after it (schema/110).
--
-- WHEN IT WAS IDENTIFIED, which is what the front page orders by, is the
-- earliest evidence any of the stretch's determinations carries:
--   - a day the determiner stated (determined_on with no precision);
--   - the moment it was entered in Ecdysis (ecdysis_identification.entered_at),
--     which Symbiota exports as wall-clock time with no zone. It is Pacific
--     time, the collection's (WSUC, in Pullman): the archive of 2026-11-04
--     enters nothing before 09:00 or after 21:00. Read as UTC it would put an
--     entry at 06:30 on the day before;
--   - the moment the expert's sheet was sent (worksheet_determination.file_modified_at),
--     used where the sheet stated less than a day. That is only the latest the
--     identification could have been made, and identified_at_is_bound says so:
--     none of the 1,832 determinations on the Idaho sheet states a date, and
--     the page says "on or before" rather than presenting the day the sheet
--     arrived as the day each bee was identified;
--   - for one made in Beeline, the moment Beeline recorded it;
--   - for one read from Ecdysis without an entry time, the moment Beeline
--     recorded it, which is only a bound, like a sheet's.
-- Not recorded_at in general: the 4 November load's identifications were
-- entered in Ecdysis between February and November 2026, and dated by the
-- load they would all read as that one night. A stated day is placed at noon
-- UTC, which is the same calendar day in Oregon, since the page shows the
-- day an instant fell on in Pacific time.
--
-- The old Beeline's expert determinations carry no date at all (none of
-- 187,743 on the store of 2026-11-11), so a stretch with one of them in it
-- has identified_at NULL: the old Beeline knew the name at a time it never
-- recorded, so a later Ecdysis entry or sheet repeating the name dates only
-- the repeat, not the identification. It is history that cannot be placed,
-- and is no news (Peter, 2026-11-12). On that store 20,902 of the 208,645
-- stretches are dated, against 45,120 if a later repeat dated the old
-- Beeline's names; an expert confirming such a name, being a different known
-- person, still starts a stretch of its own and is dated.
CREATE VIEW expert_identification AS
WITH evidence AS (
  SELECT d.entity_id, d.specimen_id, d.animal_id, d.qualifier,
         d.determiner_id, d.determiner_name, d.recorded_at,
         CASE
           WHEN d.determined_on IS NOT NULL AND d.determined_on_precision IS NULL
             THEN CAST(d.determined_on AS TIMESTAMPTZ) + INTERVAL '12 hours'
           WHEN ei.entered_at IS NOT NULL THEN ei.entered_at AT TIME ZONE 'America/Los_Angeles'
           WHEN wd.file_modified_at IS NOT NULL THEN wd.file_modified_at
           WHEN d.channel IN ('in_app', 'ecdysis_import') THEN d.recorded_at
         END AS evidence_at,
         -- A sheet's sending time, and Beeline's own record of an Ecdysis
         -- identification with no entry time, are bounds rather than the moment.
         CASE
           WHEN d.determined_on IS NOT NULL AND d.determined_on_precision IS NULL THEN 0
           WHEN ei.entered_at IS NOT NULL THEN 0
           WHEN wd.file_modified_at IS NOT NULL THEN 1
           WHEN d.channel = 'ecdysis_import' THEN 1
           ELSE 0
         END AS evidence_is_bound
  FROM determination d
  LEFT JOIN ecdysis_identification ei ON ei.determination_id = d.entity_id
  LEFT JOIN worksheet_determination wd ON wd.determination_id = d.entity_id
  WHERE d.is_expert
),
-- The last person Beeline knows to have given a name, at or before each
-- determination, so that a repeat naming nobody between a volunteer's name and
-- an expert's confirmation of it does not hide the change of person. Portable
-- without IGNORE NULLS: a running count of determinations that name somebody
-- groups each with the last one that did, which heads its group.
known_run AS (
  SELECT e.*,
         count(e.determiner_id) OVER (
           PARTITION BY e.specimen_id ORDER BY e.recorded_at, e.entity_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS known_seq
  FROM evidence e
),
known AS (
  SELECT k.*,
         first_value(k.determiner_id) OVER (
           PARTITION BY k.specimen_id, k.known_seq ORDER BY k.recorded_at, k.entity_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS last_known_id
  FROM known_run k
),
marked AS (
  SELECT e.*,
         CASE WHEN lag(e.entity_id) OVER w IS NOT NULL
                AND lag(e.animal_id) OVER w IS NOT DISTINCT FROM e.animal_id
                AND lag(e.qualifier) OVER w IS NOT DISTINCT FROM e.qualifier
                AND (lag(e.last_known_id) OVER w IS NULL OR e.determiner_id IS NULL
                     OR lag(e.last_known_id) OVER w = e.determiner_id)
              THEN 0 ELSE 1 END AS starts_stretch
  FROM known e
  WINDOW w AS (PARTITION BY e.specimen_id ORDER BY e.recorded_at, e.entity_id)
),
numbered AS (
  SELECT m.*,
         sum(m.starts_stretch) OVER (
           PARTITION BY m.specimen_id ORDER BY m.recorded_at, m.entity_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS stretch
  FROM marked m
),
credited AS (
  -- Who to credit: the first determination in the stretch that names
  -- anybody, since the old Beeline's copy of an identification often names
  -- nobody and Ecdysis's repeat of it does. One determination supplies both
  -- the person and the name, so the two can never belong to different people.
  SELECT n.*,
         first_value(n.entity_id) OVER (
           PARTITION BY n.specimen_id, n.stretch
           ORDER BY CASE WHEN n.determiner_id IS NULL AND n.determiner_name IS NULL THEN 1 ELSE 0 END,
                    n.recorded_at, n.entity_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
         ) AS credited_entity_id,
         -- Whether the stretch's earliest evidence is only a bound.
         first_value(n.evidence_is_bound) OVER (
           PARTITION BY n.specimen_id, n.stretch
           ORDER BY CASE WHEN n.evidence_at IS NULL THEN 1 ELSE 0 END, n.evidence_at, n.entity_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
         ) AS earliest_is_bound
  FROM numbered n
),
stretches AS (
  SELECT specimen_id, stretch, animal_id, qualifier,
         max(CASE WHEN entity_id = credited_entity_id THEN determiner_id END) AS determiner_id,
         max(CASE WHEN entity_id = credited_entity_id THEN determiner_name END) AS determiner_name,
         -- Undated where any determination in it is: the old Beeline's.
         CASE WHEN max(CASE WHEN evidence_at IS NULL THEN 1 ELSE 0 END) = 1 THEN NULL
              ELSE min(evidence_at) END AS identified_at,
         -- Only a dated identification can be a bound; an undated one is neither.
         max(CASE WHEN evidence_at IS NULL THEN 1 ELSE 0 END) = 0
           AND max(earliest_is_bound) = 1 AS identified_at_is_bound,
         min(recorded_at) AS first_recorded_at,
         max(recorded_at) AS last_recorded_at
  FROM credited
  GROUP BY specimen_id, stretch, animal_id, qualifier
)
SELECT s.specimen_id, CAST(s.stretch AS INTEGER) AS stretch, s.animal_id, s.qualifier,
       s.determiner_id, s.determiner_name,
       s.identified_at, s.identified_at_is_bound, s.first_recorded_at, s.last_recorded_at,
       lag(s.animal_id) OVER w AS previous_animal_id,
       lag(s.qualifier) OVER w AS previous_qualifier,
       lag(s.determiner_id) OVER w AS previous_determiner_id,
       lag(s.determiner_name) OVER w AS previous_determiner_name,
       s.stretch = max(s.stretch) OVER (PARTITION BY s.specimen_id) AS is_latest
FROM stretches s
WINDOW w AS (PARTITION BY s.specimen_id ORDER BY s.stretch);

COMMENT ON VIEW expert_identification IS 'One row per stretch of a specimen''s expert determinations that agree on the name (node and qualifier), in the order Beeline recorded them: when an expert first named the bee, each time an expert changed the name, and each time a different known person confirmed it (beeline-xegx). A repeat of the same name, such as Ecdysis re-recording what the old Beeline held, is not a new row.';
COMMENT ON COLUMN expert_identification.stretch IS 'The stretch''s place in the specimen''s history, from 1.';
COMMENT ON COLUMN expert_identification.determiner_id IS 'The person Beeline knows, from the first determination in the stretch that names anybody.';
COMMENT ON COLUMN expert_identification.determiner_name IS 'The name as written, from the same determination as determiner_id.';
COMMENT ON COLUMN expert_identification.identified_at IS 'The earliest evidence of when the name was given: a stated day (at noon UTC), Ecdysis''s entry time, the time an expert''s sheet was sent, or, made in Beeline, when it was recorded. NULL when the old Beeline, which kept no dates, held the name in the stretch: whatever repeated it later dates only the repeat.';
COMMENT ON COLUMN expert_identification.identified_at_is_bound IS 'True when identified_at is only the latest the name could have been given: the time an expert''s sheet was sent, the sheet stating no day, or Beeline''s record of an Ecdysis identification that came with no entry time.';
COMMENT ON COLUMN expert_identification.first_recorded_at IS 'When Beeline first recorded this name for the specimen.';
COMMENT ON COLUMN expert_identification.previous_animal_id IS 'The name the stretch before said, if any: what an expert changed it from.';
COMMENT ON COLUMN expert_identification.previous_determiner_id IS 'Who gave the name the stretch before, if Beeline knows them: a volunteer, where Washington''s staff uploaded the collector''s own identification to Ecdysis, where it reads as an expert''s.';
COMMENT ON COLUMN expert_identification.previous_determiner_name IS 'Who gave the name the stretch before, as written there.';
COMMENT ON COLUMN expert_identification.is_latest IS 'Whether this is the expert name the specimen has now, which is its determination of record (schema/110).';
