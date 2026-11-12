# Melittoflora: what it is, where its data comes from, and its 2026 redesign

Read 2026-11-11 (Peter, with Claude), from the deployed tool at [oregon-bee-project.github.io/melittoflora/viz.html](https://oregon-bee-project.github.io/melittoflora/viz.html), its repository ([oregon-bee-project/melittoflora](https://github.com/oregon-bee-project/melittoflora)), the data files it loads, and Peter's email about it from April to November 2026. The email is silent on anything before 2026, so the early history comes from the repository alone.

## What it is

Melittoflora is a public web page for exploring which bees were collected from which plants. It has a map, filters by taxon and by region, lists of bees and plants, and two views of the bee–plant network: a diagram linking bees to plants, and a matrix. It is the earliest tool of its kind in the program, and the one the others are measured against: Bonnie Zand's BC reporting app ([bc-reporting-app.md](bc-reporting-app.md)) is meant to feed a data tab on the redesigned version.

Antranig Basman (IMERSS, the Institute for Multidisciplinary Ecological Research in the Salish Sea) built it on IMERSS's biodiversity visualisation platform. The repository starts on 24 February 2025 with "Initial import of Melittoflora visualisation", and the first public version went out for a demonstration on 28 February 2025. The version deployed now is 1.2, with data revision V3, both dated 17 February 2026, prepared for the March 2026 conference. It is a static site on GitHub Pages, with no server: the page downloads its whole dataset and filters it in the browser. A USDA NIFA grant pays for it, and that grant ends in May 2027 (Jen Larsen's communiqué, 11 August 2026).

## Where its data comes from

The page loads three files from `docs/data/b-team/`:

- **Occurrences** (`plant-pollinators-OBA-2025-labels.viz`, zlib-compressed CSV, 38 MB uncompressed): 181,522 specimens collected between March 2017 and September 2025 by 269 collectors, every one with a bee determination and a host plant. The columns are old Beeline's occurrences export, the same file [`src/legacy-export.ts`](../../src/legacy-export.ts) writes, plus the iNaturalist taxon ids of the bee and the plant. They also say which of 19 kinds of region each specimen falls in, worked out ahead of time: counties, level III and IV ecoregions, BLM districts, field offices and monuments, national forests, wildlife refuges, national and state parks, and several land trusts' holdings.
- **Taxa** (`plant-pollinators-OBA-2025-assigned-taxa.viz`): iNaturalist's taxonomy for the 590 bee taxa and 2,028 plant taxa in the occurrences, with a common name and a photo for each.
- **Region names** (`plant-pollinators-OBA-2025-regionIndirection.csv`): the names behind the region numbers in the occurrences.

The dataset is Oregon's, despite covering several states. 176,000 specimens are from Oregon, 2017–2024, against only 2,053 from Oregon in 2025, so the 2025 season had mostly not been determined when it was made. Washington has 2,600, Nevada 300, and California and Idaho fewer than 100 each. The page is set to Oregon (`stateCode: "OR"`).

It is updated by hand: Antranig commits a new export ("Latest OBA data update", 5 March 2026). The page gives each specimen's exact coordinates and collector's name. Only 39,639 specimens carry a coordinate uncertainty: none from 2017 or 2018, and almost none from 2022 or 2024.

## The volunteer reports it hosts

The same repository holds 376 PDF reports, one per volunteer per season: Oregon 2023 (201), Washington 2024 (141) and British Columbia 2024 (34). When a filter picks out one collector, the page offers "A volunteer report is available" and links to theirs. Rowan Rampton made them: the 2023 Oregon ones were built in February 2025, and the others were added in March 2026. The Oregon one read for this note is an "Oregon Bee Atlas Collection and Identification Report" of 29 pages. It shows the volunteer's own catch by species, genus and family, and a map. Then it shows the whole atlas: counts per county and ecoregion, flowering times east and west of the Cascades, plant genera per county, tables of what has been found in each county to suggest where to collect next, and how accurate volunteers' determinations were.

This is almost certainly the "student report" Andony wants a volunteer dashboard to replace, and the "very long PDF answering far too many questions" that [surrounding-systems.md](../surrounding-systems.md) describes. Rowan is also building automated reports for the redesign, in two phases: May 2026 and May 2027.

## What users said

Andony surveyed users in August 2026 and summarised 38 responses on 18 September, most of them from Oregon. Half were Master Melittologist volunteers and 18% land managers.

- **It is too complex.** 63% visit only a few times a year or never. 45% found the panels cluttered, and 39% the layout confusing.
- **They want more ways to filter.** 89% wanted a filter by month or time of year, 76% by elevation, and 66% by land ownership.
- **They want more ways out.** 87% wanted a profile card for each bee, 79% a tool that recommends plants, 63% CSV or GIS export, and 55% a search by sample number or iNaturalist observation.

Antranig replied that several of these, such as seasonal and environmental filters, exist already. A focus group reviewed wireframes on 25 September 2026.

## The 2026 redesign

Antranig is redesigning the interface over the winter, Andony coordinates, and 24 survey respondents volunteered to test prototypes. From the meetings on 18 and 25 September, as summarised:

- The map is paired with the network diagram, with lists of bees and plants beside them. There are separate views for Master Melittologists, land managers and the public.
- Reports for landowners and Master Melittologists come first: the most abundant bees and plants, species richness, and maps.
- A tool for evaluating a seed mix is deferred. When it comes, it should help people explore rather than recommend, so that it never suggests an invasive plant.
- Taxonomists asked for care with sensitive locations and for proper citation, while land managers asked for precise locations of rare species.

Washington's own instance was due at its March 2026 conference (Caleb Lankford, 6 March 2026), and on 9 November 2026 Andony sent Idaho's expert determinations to Antranig "to populate the Idaho melittoflora", as well as to Beeline.

## What it means for Beeline

- **Melittoflora reads old Beeline's occurrences file today**, and Beeline writes that file nightly (beeline-6q8), so nothing broke at cutover. How data should pass from Beeline to Melittoflora after the redesign was an open item on Andony's agenda for 31 July 2026 ("how Beeline feeds data to Rowan's reporting engine and Antranig's web UI"). Nothing in the email settles it.
- **Its regions overlap Beeline's.** Beeline already records which county (BC's regional districts included), level III ecoregion and wilderness each sample lies in ([`schema/038_areas.sql`](../../schema/038_areas.sql)), with refuges and parks to follow. Melittoflora's 19 layers are a list of what land managers ask about, and so a list of what Beeline's areas may need to cover.
- **The volunteer report is Beeline's to replace**, as a dashboard rather than a PDF ([surrounding-systems.md](../surrounding-systems.md)). The map, the filters and the plant tools stay with Melittoflora. Andony assigned Beeline one request from the survey: looking up a specimen's determinations by its field number.
- **It publishes exact coordinates and collectors' names with no policy behind them**, which [program-governance-for-exports.md](program-governance-for-exports.md) covers for the program's other outputs.
