-- Migration for schema/065 and schema/107: record the place ids iNaturalist
-- was asked for and did not return, and stop asking for them (beeline-0oj).
--
-- Places get merged and deleted upstream while an observation keeps naming
-- the old id, and /v1/places/{id} answers such an id with HTTP 200 and an
-- empty results array. Three of them are on the corpus — 117476 (a curated
-- area around Burns, Oregon, on 4,127 observations), 59614 and 186423 — so
-- inat_place_uncached could never be empty and the fetcher spent a request
-- per run re-asking. The nightly pipeline now runs that fetch between sync
-- and promote, which is one request a night for nothing without this.
--
-- Not seeded here: the first fetch after this migration asks once, gets the
-- same answer, and records it. A migration stating what upstream does not
-- have would be a claim about iNaturalist at the moment it was written.
CREATE TABLE inat_place_absent (
  inat_place_id BIGINT PRIMARY KEY,
  asked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE inat_place_absent IS 'Place ids iNaturalist was asked for and did not return — merged or deleted upstream while an observation still names them. Subtracted from inat_place_uncached so "uncached" means "not yet tried" and the fetcher stops re-asking; delete a row to ask again. Kept apart from inat_place so observation_place never reads a placeholder as a place.';
COMMENT ON COLUMN inat_place_absent.asked_at IS 'When iNat was last asked and answered without it. A place can in principle come back (an undeleted or re-created id), so this is what would say how old the verdict is.';

CREATE OR REPLACE VIEW inat_place_uncached AS
SELECT DISTINCT unnest(CAST(coalesce(json_extract(o.content, '$.private_place_ids'),
                                     json_extract(o.content, '$.place_ids')) AS BIGINT[])) AS inat_place_id
FROM observation_current o
EXCEPT
SELECT inat_place_id FROM inat_place
EXCEPT
SELECT inat_place_id FROM inat_place_absent;
