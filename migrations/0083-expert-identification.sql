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
-- starts the next. Expert determinations only: a volunteer's own name for
-- their bee is not news to them, and an expert's stays the record whatever
-- a volunteer says after it (schema/110).
--
-- WHEN IT WAS IDENTIFIED, which is what the front page orders by, is the
-- earliest evidence any of the stretch's determinations carries:
--   - a day the determiner stated (determined_on with no precision);
--   - the moment it was entered in Ecdysis (ecdysis_identification.entered_at);
--   - the moment the expert's sheet was sent (worksheet_determination.file_modified_at),
--     an upper bound, used where the sheet stated less than a day;
--   - for one made in Beeline or read from Ecdysis without an entry time,
--     the moment Beeline recorded it.
-- Not recorded_at in general: the 4 November load's identifications were
-- entered in Ecdysis between February and November 2026, and dated by the
-- load they would all read as that one night. A stated day is placed at noon
-- UTC, which is the same calendar day in Oregon, since the page shows the
-- day an instant fell on in Pacific time. Ecdysis's entry time arrives with
-- no zone and is read as UTC, as the loader reads it.
--
-- The old Beeline's expert determinations carry no date at all (none of
-- 187,743 on the store of 2026-11-11), so a stretch made only of them has
-- identified_at NULL: it is history that cannot be placed, and the front
-- page leaves it out. Where Ecdysis later repeated the same name, the
-- stretch takes Ecdysis's entry time.
CREATE VIEW expert_identification AS
WITH evidence AS (
  SELECT d.entity_id, d.specimen_id, d.animal_id, d.qualifier,
         d.determiner_id, d.determiner_name, d.recorded_at,
         CASE
           WHEN d.determined_on IS NOT NULL AND d.determined_on_precision IS NULL
             THEN CAST(d.determined_on AS TIMESTAMPTZ) + INTERVAL '12 hours'
           WHEN ei.entered_at IS NOT NULL THEN CAST(ei.entered_at AS TIMESTAMPTZ)
           WHEN wd.file_modified_at IS NOT NULL THEN wd.file_modified_at
           WHEN d.channel IN ('in_app', 'ecdysis_import') THEN d.recorded_at
         END AS evidence_at
  FROM determination d
  LEFT JOIN ecdysis_identification ei ON ei.determination_id = d.entity_id
  LEFT JOIN worksheet_determination wd ON wd.determination_id = d.entity_id
  WHERE d.is_expert
),
marked AS (
  SELECT e.*,
         CASE WHEN lag(e.entity_id) OVER w IS NOT NULL
                AND lag(e.animal_id) OVER w IS NOT DISTINCT FROM e.animal_id
                AND lag(e.qualifier) OVER w IS NOT DISTINCT FROM e.qualifier
              THEN 0 ELSE 1 END AS starts_stretch
  FROM evidence e
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
  -- nobody and Ecdysis's repeat of it does.
  SELECT n.*,
         first_value(n.determiner_id) OVER (
           PARTITION BY n.specimen_id, n.stretch
           ORDER BY CASE WHEN n.determiner_id IS NULL THEN 1 ELSE 0 END, n.recorded_at, n.entity_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
         ) AS credited_id,
         first_value(n.determiner_name) OVER (
           PARTITION BY n.specimen_id, n.stretch
           ORDER BY CASE WHEN n.determiner_name IS NULL THEN 1 ELSE 0 END, n.recorded_at, n.entity_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
         ) AS credited_name
  FROM numbered n
),
stretches AS (
  SELECT specimen_id, stretch, animal_id, qualifier,
         min(credited_id) AS determiner_id,
         min(credited_name) AS determiner_name,
         min(evidence_at) AS identified_at,
         min(recorded_at) AS first_recorded_at,
         max(recorded_at) AS last_recorded_at
  FROM credited
  GROUP BY specimen_id, stretch, animal_id, qualifier
)
SELECT s.specimen_id, s.stretch, s.animal_id, s.qualifier,
       s.determiner_id, s.determiner_name,
       s.identified_at, s.first_recorded_at, s.last_recorded_at,
       lag(s.animal_id) OVER w AS previous_animal_id,
       lag(s.qualifier) OVER w AS previous_qualifier,
       s.stretch = max(s.stretch) OVER (PARTITION BY s.specimen_id) AS is_latest
FROM stretches s
WINDOW w AS (PARTITION BY s.specimen_id ORDER BY s.stretch);

COMMENT ON VIEW expert_identification IS 'One row per stretch of a specimen''s expert determinations that agree on the name (node and qualifier), in the order Beeline recorded them: when an expert first named the bee, and each time an expert changed the name (beeline-xegx). A repeat of the same name, such as Ecdysis re-recording what the old Beeline held, is not a new row.';
COMMENT ON COLUMN expert_identification.stretch IS 'The stretch''s place in the specimen''s history, from 1.';
COMMENT ON COLUMN expert_identification.determiner_id IS 'The first determination in the stretch that names a person Beeline knows.';
COMMENT ON COLUMN expert_identification.determiner_name IS 'The first determination in the stretch that names anybody, as written.';
COMMENT ON COLUMN expert_identification.identified_at IS 'The earliest evidence of when the name was given: a stated day (at noon UTC), Ecdysis''s entry time, the time an expert''s sheet was sent, or, made in Beeline, when it was recorded. NULL when only the old Beeline, which kept no dates, ever held it.';
COMMENT ON COLUMN expert_identification.first_recorded_at IS 'When Beeline first recorded this name for the specimen.';
COMMENT ON COLUMN expert_identification.previous_animal_id IS 'The name the stretch before said, if any: what an expert changed it from.';
COMMENT ON COLUMN expert_identification.is_latest IS 'Whether this is the expert name the specimen has now, which is its determination of record (schema/110).';
