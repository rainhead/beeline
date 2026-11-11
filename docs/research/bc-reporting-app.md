# The BC Bee Atlas reporting app: what it does, read from its output

Read 2026-11-11 (Peter, with Claude). Bonnie Zand, who leads the BC Bee Atlas, built a reporting app in R Shiny with help from an AI assistant and shared it with the atlas leads on 9 November 2026. Andony passed it on as a source of ideas for a volunteer dashboard to replace the student report. Bonnie sees some of its measures going into a data tab on the redesigned Melittoflora ([melittoflora.md](melittoflora.md)). Neither of us could get its charts to appear in the browser. This note is read from three things: the app's page, the bundle of reports it produced for Bonnie (`Master_Dashboard_Bundle_2026-11-11.zip`, emailed by her and not kept in the repo), and the national ranks spreadsheet it uses. Her code and sample dataset did not reach us. She describes the app as an internal tool for program staff, so its address is not given here.

## What goes in

- **An occurrence export from Ecdysis**, uploaded by the user. The bundle's was the BC Bee Atlas collection (`BCBA`): 1,100 bee specimens from 2021 to 2025.
- **The plant each bee was collected from**, taken from what Bonnie calls the Master Occurrence file, which Andony gave her. It is old Beeline's occurrences file: the app adds that file's `orderPlant`, `familyPlant`, `genusPlant`, `speciesPlant` and `taxonRankPlant` columns and its iNaturalist `url` to each Ecdysis record. It matches them on the field number, which is the Ecdysis catalog number without its `BCBA_` prefix (all 1,100 match that way). 53 specimens got no plant, spread over every year but 2021, so the file she has is missing some records.
- **Conservation ranks** from *Wild Species 2020: The General Status of Species in Canada* ([report and data](https://www.canada.ca/en/environment-climate-change/services/species-risk-public-registry/general-status/wild-species-2020.html)). The federal, provincial and territorial governments publish it together as one spreadsheet. It gives each species a national rank (N1 to N5) and a rank in each province and territory (S1 to S5, SU for unrankable, SNA for not applicable), on NatureServe's scale. It covers 903 bee species, 501 of them in British Columbia, but only 171 of those have a real BC rank: 319 are unrankable because too little is known. The rarest in BC are *Bombus bohemicus* (S1), *Dufourea dilatipes* (S2) and *Bombus suckleyi* (probably S2). It covers Canada only.

## What comes out

Filters on the left narrow the data, and every table and chart can be downloaded, singly or as one ZIP with the filtered data included.

- **Summary.** Headline counts: records, the share identified to species, genera, taxa, imperiled species, collectors, collecting dates, samples, regional districts, municipalities, and plant orders, families, genera and species. Then a table by month of dates, samples, collectors, records and species. Then records and species by bee family and by genus, and each bee species with the plant genera it was collected from.
- **Species registry.** Each species with its author, common name and Wild Species rank in BC, spelled out ("S2S3: Imperiled"), whether males and females were caught, and which years it was found.
- **Host plants.** Plant orders and families ranked by bee records and by the number of bee taxa, species and genera found on them.
- **Regions.** The same counts by regional district and by municipality, with the months sampled.
- **Charts.** Records by bee family, genus and species; the 20 plant genera visited by the most bee taxa, stacked by bee family; a diagram linking bee genera or species to plant orders, families or genera; and a map of the collecting sites, which Bonnie says needs work.

## What it means for Beeline

- **Most of it is the same counting the Stewardship Report and a volunteer dashboard need:** what was found, when and where, on which plants, and by whom. It also shows what one atlas's staff report to their partners. The Stewardship Report's port is [#282](https://github.com/rainhead/beeline/issues/282), and a measure of how rare a species is is [#284](https://github.com/rainhead/beeline/issues/284).
- **Beeline can supply the joined data directly.** [`src/legacy-export.ts`](../../src/legacy-export.ts) writes old Beeline's occurrences file, plant columns included, from current data. One file from it would replace the app's join against a year-old copy and fill the 53 gaps, for any atlas whose records Beeline holds.
- **Two parts are specific to BC.** The ranks come from a Canadian source, and the regions are BC's regional districts and municipalities. Oregon, Washington and Idaho would need counties, and state ranks from NatureServe, which leave most bees unranked too.

## Where it stands

Peter replied on 11 November asking Bonnie what she thinks volunteers most want to know, and suggesting the why and what might come across better in prose than in the prototype. He also told her about the Stewardship Report work.
