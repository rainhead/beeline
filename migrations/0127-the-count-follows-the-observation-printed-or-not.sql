-- Migration for schema/030_samples_specimens.sql (beeline-ni5m.18, GitHub #464):
-- a sample's specimen count is the declared count and follows its observation
-- whether or not the labels have printed, so the comment that said the count
-- was free to move only until printing is replaced. Only the comment changes;
-- promotion writes the counts from the next nightly.
COMMENT ON COLUMN sample.specimen_count IS 'The declared count: what the volunteer says on iNaturalist, or what staff set in Beeline for a sample with no observation (or a released one). It follows the sample''s observation, printed or not, up or down, while the observation carries a positive whole number, exactly one sample cites it and no other observation claims the sample; a printed sample follows only while the observation still carries its number and dates (ingest/mint-samples.sql, beeline-ni5m.18). What is on paper is a separate fact (specimen_on_paper), never rewritten by the count.';
