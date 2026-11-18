-- The registration each person is linked to now: the latest decision about
-- them, where it names one (beeline-w8ab.1). A person whose latest decision
-- is an unlinking has no row, like a person nobody has decided about.
CREATE VIEW person_registration AS
SELECT person_id, ideal_logic_id, evidence, decided_by, decided_at
FROM (
  SELECT e.*, row_number() OVER (PARTITION BY person_id ORDER BY entity_id DESC) AS recency
  FROM person_registration_event e
) latest
WHERE recency = 1 AND ideal_logic_id IS NOT NULL;
COMMENT ON VIEW person_registration IS 'The Ideal Logic registration each person is linked to now, with the evidence and who decided. A person with no row is linked to none. Where a collector''s labels are mailed is looked up in Ideal Logic through this at the moment a print run''s addresses are downloaded; the address is never stored.';
