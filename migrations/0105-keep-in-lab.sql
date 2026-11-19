-- Migration for schema/014_registrations.sql and
-- schema/105_view_person_mailing_instruction.sql (beeline-w8ab.4): where a
-- person's labels go when they are not mailed. A new table and a view; no
-- existing row changes.

CREATE TABLE person_mailing_event (
  entity_id   INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  person_id   INTEGER NOT NULL REFERENCES person(entity_id),
  instruction TEXT NOT NULL CHECK (instruction IN ('mail', 'keep_in_lab')),
  decided_by  TEXT NOT NULL,
  decided_at  TIMESTAMP NOT NULL DEFAULT current_timestamp,
  reference   TEXT
);
COMMENT ON TABLE person_mailing_event IS 'Decisions about whether a person''s printed labels are mailed or kept in the lab. Append-only; the latest row per person is the answer, which person_mailing_instruction reads. An instruction only, never an address or an email address, and no note: free text could hold an address.';
COMMENT ON COLUMN person_mailing_event.entity_id IS 'Drawn from the one sequence, so a later decision has a higher id: the order decisions are read in, since two made in one transaction share a decided_at.';
COMMENT ON COLUMN person_mailing_event.person_id IS 'The person whose labels the decision is about.';
COMMENT ON COLUMN person_mailing_event.instruction IS 'mail, the default: the labels are mailed to the address Ideal Logic holds; keep_in_lab: they are not mailed, and the address download says so in place of an address.';
COMMENT ON COLUMN person_mailing_event.decided_by IS 'The iNaturalist login of the member of staff who decided.';
COMMENT ON COLUMN person_mailing_event.decided_at IS 'When, in UTC.';
COMMENT ON COLUMN person_mailing_event.reference IS 'A pointer to the request behind a change made through the API, as api_key_use.reference: a message id or an issue link, never an address or a name.';

CREATE VIEW person_mailing_instruction AS
SELECT person_id, instruction, decided_by, decided_at
FROM (
  SELECT e.*, row_number() OVER (PARTITION BY person_id ORDER BY entity_id DESC) AS recency
  FROM person_mailing_event e
) latest
WHERE recency = 1 AND instruction <> 'mail';
COMMENT ON VIEW person_mailing_instruction IS 'The people whose labels are not mailed, with the instruction and who decided. A person with no row is mailed their labels. The address download reads it to give such a collector a row saying where their labels are, in place of an address.';
