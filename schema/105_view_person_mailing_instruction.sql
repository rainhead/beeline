-- The people whose labels are not mailed: the latest decision about each
-- person, where it is anything but "mail" (beeline-w8ab.4). Mailing is the
-- default, so a person whose latest decision is "mail" has no row, like a
-- person nobody has decided about.
CREATE VIEW person_mailing_instruction AS
SELECT person_id, instruction, note, decided_by, decided_at
FROM (
  SELECT e.*, row_number() OVER (PARTITION BY person_id ORDER BY entity_id DESC) AS recency
  FROM person_mailing_event e
) latest
WHERE recency = 1 AND instruction <> 'mail';
COMMENT ON VIEW person_mailing_instruction IS 'The people whose labels are not mailed, with the instruction, the staff note and who decided. A person with no row is mailed their labels. The address download reads it to give such a collector a row saying where their labels are, in place of an address.';
