# Plant taxa

Part of Beeline's architecture notes; the index is [README.md](README.md).

A floral host is stored as an iNaturalist taxon id, with the name and rank as they were observed. On its own that tells nothing about the plant: not its genus or family, not its common name, and not whether iNaturalist has since retired the taxon. The taxon cache is how the store comes to know. The plan and its decisions are in beeline-rfkj; this file covers the part built first, beeline-rfkj.1.

**iNaturalist's taxonomy is the plant taxonomy** (Peter, 2026-11-13). The store holds only taxa that something has referred to, plus their ancestors and the taxa that replaced them, each fetched by id from the API. It never loads iNaturalist's monthly taxonomy download. **Stored ids and names are never rewritten to follow iNaturalist's taxonomy.** A sample's host does change when its observation does: promotion copies the observation's taxon id, name and rank whenever the observation carries a taxon ([ingestion-jobs-and-elevation.md](ingestion-jobs-and-elevation.md)), and that is how most retirements reach a sample, since iNaturalist re-identifies the observations of a taxon it retires. What nothing does is replace a stored id because iNaturalist retired it. A sample whose host no observation will update keeps the id it has, and a later piece (beeline-rfkj.3) reads that taxon's current replacement when a page needs it.

## What is stored

`schema/066_inat_taxa.sql` holds four tables, each documented with `COMMENT ON`:

- `inat_taxon`: the id, name, rank as iNaturalist writes it (species, subspecies, variety, section, hybrid and so on), the rank's number, the parent, whether the taxon is active, iNaturalist's preferred English name for Oregon, and when the row was read. Varieties and subspecies are kept at the rank observed, because some protected populations are identified at that rank.
- `inat_taxon_ancestor`: every taxon above a taxon, **and the taxon itself at depth 0**. The two places that carry a lineage disagree about this (the taxa endpoint's `ancestor_ids` leaves the taxon out, an observation's `taxon.ancestor_ids` includes it), so the table always includes the taxon and a reader never has to know which source a row came from.
- `inat_taxon_replacement`: what a retired taxon was replaced by. A split is several rows, and a reader cannot pick one.
- `inat_taxon_absent`: ids iNaturalist was asked for and did not return, on the terms of `inat_place_absent` except that the verdict lasts 30 days. After that the id is asked for again, and any response that shows the taxon (as a result or as an ancestor, including one already stored) deletes the row at once.

Nothing leaves the cache: a taxon that no sample names any more stays. There are no foreign keys: an ancestor or replacement is recorded before the taxon it names has been read.

**A retired taxon's own lineage is stale.** Aster chilensis adscendens (322554) is a subspecies that iNaturalist replaced with Symphyotrichum ascendens (79294), a different species from the one its parent still names (56861). Anything that needs a host's genus or family must read the current taxon's lineage, never the retired taxon's.

## The worklist

`inat_taxon_uncached` (`schema/112_views_inat_taxon.sql`) is the one definition of what is missing: the ids named by `sample.host_inat_taxon_id` and by `observation_field.host_taxon_id` (the dashboard shows the hosts of observations not yet minted), and the ancestors and replacements already stored, with no `inat_taxon` row and not recorded absent. Fetching a taxon can add to the list, so the fetcher reads the view again after every batch until it is empty. beeline-rfkj.2 adds the old plant list's entries as one more branch of that view.

## The fetcher

`src/fetch-inat-taxa.ts` is modelled on `src/fetch-places.ts`, with two differences: taxa are refreshed, where places are fetched once, and the worklist grows as it is worked.

It uses iNaturalist's **v2 API** with an explicit `fields` list. v2 returns retired taxa with `current_synonymous_taxon_ids`, each taxon's ancestors with name, rank, parent and common name in the same response, and the Oregon common name when asked with `preferred_place_id=10` and `locale=en`. v1 returns whole records: 512 KB for ten taxa, where a v2 response for thirty is a few tens of kilobytes. Requests carry up to 30 ids, no more than one every 1.1 seconds, and no token.

Two things the response does not do, found by calling it. `ancestor_ids` leaves out the taxon itself, so the self row is added here. The `ancestors` array leaves out the root, Life (48460), though `ancestor_ids` names it, so Life is fetched by id like any other missing taxon. Ancestors in a response are stored as taxa, so a lineage costs no requests of its own, but only active ones that are not yet stored: an ancestor in a response carries no replacements, so a retired one goes through the worklist and is fetched itself. Nothing is taken from the response of a retired taxon, whose lineage is stale, nor for an ancestor that its `ancestor_ids` does not list, which would be stored with only its own row.

Each fetch of a taxon deletes and re-inserts its ancestor and replacement rows in one transaction with the batch, so a reinstated or re-split taxon leaves nothing stale and an interrupted run keeps the batches it finished.

**Refresh.** After the worklist, each run reads again two sets of stored taxa, both defined as views in `schema/112_views_inat_taxon.sql` and both leaving out a taxon read within the last 12 hours, so a cold fill does not read everything twice and a nightly run, about a day after the last, always finds a taxon due. `inat_taxon_recheck` is the stored replacements of retired taxa. It is what follows a chain: a replacement that iNaturalist later retires is noticed the night after, when it is read again, and what replaced it joins the worklist. A chain already formed when a taxon is first fetched is followed in that same run. `inat_taxon_stalest` is the stalest thirtieth of what is stored, so every taxon is read again within about a month. A stored taxon that a refresh no longer gets back keeps its row and is recorded absent, which also stops the refresh choosing it every night until the verdict is 30 days old.

**When the API refuses a batch.** A single unknown id answers 404 with an empty list, and several ids answer 200 with the ones iNaturalist holds (checked 2026-11-13), so a deleted taxon is not an error. A batch that is refused for another reason is asked again in halves, down to single ids, so that one id the API cannot answer costs only itself: it is reported as failed, not recorded absent, and asked again next run. Three single ids in a row failing means the API is down, and that phase stops; the refresh phase still runs when the worklist phase failed. The result says what went wrong (`errors`, `failed`) instead of throwing.

## Running it

`pnpm inat:fetch-taxa [db]` by hand. In the nightly pipeline it is the step "fetch taxa", after the other store steps and before the check that fails the run over a refused history snapshot (`refreshInatTaxa` in `src/app/jobs/registry.ts`). It never fails the run, since a cache a night out of date costs a page its common name and nothing else, and it is capped at 60 requests (about two minutes) and at 8 minutes for the whole step, whatever the requests are doing, so that it cannot delay the 3am backup (the nightly starts at 2am and has taken from 36 seconds to 8 minutes). Taxa stored before the cap or the deadline stay stored. A cold fill on production, measured on a copy on 2026-11-13, is 111 requests and about 3 minutes, so it takes two nights.

`db:reseed` carries the four tables across (`CARRIED_TABLES`), on the same terms as `inat_place`: they come from an outbound fetch nothing in the store can recompute. Production is never reseeded (ADR 0006), so this serves dev stores only. The migration is `migrations/0090-inat-taxa.sql`.

## Tests

`test/fetch-inat-taxa.test.ts` uses responses captured from the real API on 2026-11-13 (`test/fixtures/inat-taxa/`): 56861 (current), 322554 (retired, replaced by a species its stale parent is not), 887293 (a genus replaced by a section, 742759), 1415100 (the replacement of two retired names, 148304 and 78444), 1588297 (a species split into three, with its three replacements, `split.json`) and the 404 body for an id that returns nothing (`absent.json`). The fake API answers as the real one does: 200 with the ids it holds for several ids, and the captured 404 for a single unknown one. They are the shapes iNaturalist sends, which is what a parser tested only on strings we wrote would miss.
