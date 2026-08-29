-- iNaturalist's places, cached.
--
-- An observation carries `place_ids` — the places iNat stamped it with — and
-- `place_guess`, which is free text a volunteer typed ('Leach Botanical
-- Garden', 'Parkrose community orchard', '3334 NW Covey Run, Corvallis, OR
-- 97330, USA'). Only the first can answer "which state is this in", and it
-- answers with an id, so something has to know what an id means. That is this
-- table (beeline-2yt).
--
-- Why a cache rather than a lookup at read time: the ids are stable, the
-- corpus holds 2,556 distinct ones, and the alternative is an outbound HTTP
-- call inside promotion. Refreshed by `pnpm inat:fetch-places`
-- (src/fetch-places.ts), which fetches only ids it has never seen.
--
-- Not an entity (ADR 0002): nothing anchors on a place. No finding is about
-- one, no correction names one — it is reference data keyed by what it
-- describes, the same argument observation_field (schema/060) makes.
--
-- Deliberately not the whole place record. iNat returns geometry for every
-- place, which is megabytes and which nothing here reads: geography assigns
-- an atlas by *lookup, never a computation* (schema/010), so the polygons
-- would be storage with no reader.
CREATE TABLE inat_place (
  inat_place_id      BIGINT PRIMARY KEY,
  name               TEXT NOT NULL,
  admin_level        INTEGER,
  ancestor_place_ids BIGINT[],
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE inat_place IS 'iNaturalist places, cached so an observation''s place_ids can be read as country/state/county without an HTTP call inside promotion. Reference data, not an entity (ADR 0002): nothing anchors on a place.';
COMMENT ON COLUMN inat_place.admin_level IS 'iNat''s administrative rank: 0 country, 10 state/province, 20 county. NULL for the majority — ecoregions, parks, and the user-drawn places that make up most of an observation''s place_ids ("Willamette Valley EcoRegion", "Total Solar Eclipse 2017 Path of Totality"). Nullable because that is the common case, not an omission.';
COMMENT ON COLUMN inat_place.ancestor_place_ids IS 'Self-inclusive, and NULL on the continent-sized places that have no ancestors. Carried so a place can be told which country it is under without a second fetch — the discriminator between Georgia the state and Georgia the country.';
COMMENT ON COLUMN inat_place.fetched_at IS 'When this row was read from iNat. Places change shape and get merged upstream; nothing re-reads them on a schedule yet, so this is what would say how stale the answer is.';
