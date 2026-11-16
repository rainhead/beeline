-- What a published archive says now about each of its records: the newest
-- statement, by the order its versions were loaded in (schema/042).
CREATE VIEW archive_statement_current AS
SELECT dataset_key, occurrence_id, version, withdrawn, field_number, catalog_number, recorded_by, event_date,
       scientific_name, family, genus, subgenus, specific_epithet, taxon_rank, identified_by, date_identified, sex
FROM (
  SELECT s.*,
         row_number() OVER (PARTITION BY s.dataset_key, s.occurrence_id ORDER BY v.sequence DESC) AS rn
  FROM archive_statement s
  JOIN archive_version v ON v.dataset_key = s.dataset_key AND v.version = s.version
) ranked
WHERE rn = 1;
COMMENT ON VIEW archive_statement_current IS 'The newest statement of each record of each dataset, a withdrawal included.';

-- What a museum publishes about a specimen, for the specimen's page: one row
-- for each record of a dataset that names the specimen and is still
-- published. is_record says the specimen's determination of record is one a
-- load recorded from this dataset AND still says what the record says now,
-- so the page need not say it twice. A record the publisher has since
-- changed to something a load could not record (a name the tree lacks, a
-- determiner nobody has placed) is therefore not the record, and is shown.
-- agrees says the name the archive gives is the name of the
-- specimen's expert determination of record, with no qualifier on it. Where
-- neither holds, the museum publishes something Beeline does not say, and
-- the page shows it (Peter, 2026-11-15: every difference is visible).
CREATE VIEW archive_note AS
SELECT r.specimen_id, d.dataset_key, d.publisher, c.occurrence_id, c.version, c.catalog_number,
       c.scientific_name, c.subgenus, c.identified_by, c.date_identified, c.sex,
       r.animal_id, r.held,
       coalesce(ad.determination_id IS NOT NULL AND r.held IS NULL
                AND rec.animal_id = r.animal_id AND rec.qualifier IS NULL
                AND rec.sex IS NOT DISTINCT FROM r.sex
                AND rec.determined_on IS NOT DISTINCT FROM r.determined_on
                AND rec.determiner_name IS NOT DISTINCT FROM c.identified_by, false) AS is_record,
       coalesce(rec.is_expert AND rec.animal_id = r.animal_id AND rec.qualifier IS NULL, false) AS agrees
FROM archive_reading r
JOIN archive_dataset d ON d.dataset_key = r.dataset_key
JOIN archive_statement_current c ON c.dataset_key = r.dataset_key AND c.occurrence_id = r.occurrence_id
LEFT JOIN determination_of_record rec ON rec.specimen_id = r.specimen_id
LEFT JOIN archive_determination ad ON ad.determination_id = rec.entity_id AND ad.dataset_key = r.dataset_key
WHERE r.specimen_id IS NOT NULL AND NOT c.withdrawn;
COMMENT ON VIEW archive_note IS 'What a published archive says about a specimen now: its name as published, who identified it and in what year, and whether Beeline''s determination of record is one a load recorded from the dataset that still says the same (is_record), or gives the same name (agrees).';
COMMENT ON COLUMN archive_note.held IS 'Why the load could not read the statement as a determination (a name the tree lacks, a determiner nobody has placed), or NULL.';

-- Where a museum publishes a name other than the one Beeline's expert
-- determination of record gives: the worklist for a person, since nothing in
-- either source says which is newer. Split by season with settled, as every
-- check is (AGENTS.md).
CREATE VIEW archive_disagreement AS
SELECT n.dataset_key, n.publisher, n.occurrence_id, n.specimen_id, sp.field_number,
       n.scientific_name AS published_name, n.identified_by AS published_by, n.date_identified AS published_year,
       n.animal_id AS published_animal_id,
       rec.entity_id AS determination_id, rec.animal_id, rec.qualifier, rec.channel,
       sp.sample_id IN (SELECT sample_id FROM settled_sample) AS settled
FROM archive_note n
JOIN specimen sp ON sp.entity_id = n.specimen_id
JOIN determination_of_record rec ON rec.specimen_id = n.specimen_id AND rec.is_expert
WHERE NOT n.is_record AND NOT n.agrees;
COMMENT ON VIEW archive_disagreement IS 'Specimens whose expert determination of record gives a name other than the one a published archive gives, or gives it with a qualifier, or whose published name the tree could not place. Nothing is recorded for these: neither source says which name is newer.';
COMMENT ON COLUMN archive_disagreement.published_animal_id IS 'The published name as a node of the tree, or NULL where it could not be placed.';
COMMENT ON COLUMN archive_disagreement.settled IS 'Whether the specimen''s sample is from a settled season (settled_sample).';
