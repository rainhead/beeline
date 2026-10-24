# PROTOTYPE: localities from coordinates

Throwaway code for [beeline-7i6](../../.beads/issues.jsonl), step 1: can a locality be named from a sample's coordinates well enough that volunteers stop fixing iNaturalist's? It lives on the `prototype/coordinate-localities` branch only.

```bash
pnpm prototype:locality [store.duckdb]   # default data/sandbox/beeline.duckdb
```

This downloads the gazetteers (`fetch.sh`). It then builds every candidate name for a selection of samples (`build.sql`): the whole open season, every sample inside a refuge, and 4,000 random settled ones. Finally it writes `data/prototype-locality/PROTOTYPE-coordinate-locality.html`. The page holds the rule itself as a pure function (`Locality.pick` in `page.html`), with controls for its settings, statistics split by season, and tabs for the awkward cases. It contains sample coordinates, so it stays local.

The rule, in order: a point inside a national wildlife refuge is named for the refuge; inside a WDFW wildlife area unit, for the unit; inside a town's limits, for the town; within 1.5 km of a named place, for that place; out of town and near a notable peak, for the peak; otherwise for the nearby town with the best ratio of distance to size, from its own county if one qualifies. Every name is shortened only as far as the 18-character label needs and must pass the street-address check.

Sources: GeoNames (towns, peaks, named localities, city parks as points), OpenStreetMap via Geofabrik's extracts (park and reserve outlines for BC, WA, OR, ID and NM, under the ODbL, national forests left out; put `<region>-latest.osm.pbf` in the downloads folder), NPS unit boundaries, WA State Parks and BC provincial parks, Census cartographic boundaries 2023 (counties, town limits), BC ABMS (regional districts and municipalities as legally defined now), USFWS interest boundaries (refuges, easements excluded), WDFW wildlife area units.
