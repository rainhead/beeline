# Program governance for exports: licences, privacy policies and datasets

Research for the nightly Darwin Core archive (one per program per season, refused unless the program has a licence and a privacy policy in force for that season), and for embargoes on particular records. Gathered 2026-10-10 from GBIF's API and documentation, TDWG, Creative Commons, iNaturalist, the Symbiota documentation, Ecdysis, and each atlas's own pages.

Each claim is marked as one of two kinds:

- **Found** means a primary source says it, and the source is linked.
- **Inferred** means it is my reading of found facts. Treat it as a proposal, not a finding.

Some www.gbif.org pages (`/terms`, `/terms/licences`, the privacy policy, news items) refuse automated fetches. Where a claim rests on one of them, it rests on search-engine extracts of the page, and it says so.

## What this means for the design, in brief

1. **No program has a privacy policy to record yet.** No atlas and no Master Melittology page publishes a data-use, privacy or sensitive-species policy. What exists is a licence on a GBIF dataset, and one Oregon dataset (2019) that rounded its coordinates. So the gate will refuse every archive until each program writes a policy from scratch. Section 1 has the details.
2. **A policy has to answer about eight concrete questions**, and Beeline can apply each answer mechanically. They are listed at the top of section 2. The most important design point is that the established tool in this ecosystem (Symbiota, and therefore Ecdysis) withholds **the host plant (`associatedTaxa`), the date and the collector's number** along with the coordinates when it protects a record. A policy that rounds only the coordinates leaks the location through those fields.
3. **A season is a fine grain for Beeline to produce. It is the wrong grain to publish.** Oregon published per-year datasets and then a cumulative one that republishes them. Today all 35,725 of the 2018 and 2019 records appear on GBIF twice. The 2019 duplicates are invisible to GBIF's duplicate detection, and one specimen carries two licences. A program should publish one dataset that grows, under a stable `occurrenceID`. Section 3 has the details.
4. **On GBIF, a licence belongs to a dataset, not to a record.** GBIF shows the dataset's licence on every record, and the record-level `license` values in Oregon's archives are not what GBIF shows. A Creative Commons licence cannot be revoked once granted. So "licence from season X on" works as an internal rule only if a cumulative dataset declares the most restrictive licence among the seasons it holds, or if records under different licences go into separate datasets. Section 4 has the details.
5. **Collectors' names are personal data, and every atlas publishes them.** GBIF says it processes them as personal data. The one aggregator found that addresses the question (the UK's NBN Atlas) puts the decision about publishing names on the publisher. BC's privacy law covers non-profit societies. A program's policy should say whether names go out. Section 5 has the details.
6. **An embargo is Beeline's to record. Nothing downstream will hold one.** GBIF, the IPT and Darwin Core have no embargo term. A publisher withholds the record until the date. Symbiota can hide a whole record from exports and from GBIF, but its hide has no expiry and no field for who granted it. Arctos's "encumbrance" is the worked model: one grant links to many records and records who made it, when, when it expires (at most five years ahead, renewable), what it hides, and why. It lapses by itself on the expiry date. An embargo must be set before a record is first published, because publishing cannot be undone. Embargoed records released later need a dataset that grows, which is one more reason to publish cumulatively. Section 6 has the details.

---

## 1. What each atlas has already published

**For the design:** there is nothing to transcribe. Every bee dataset these programs have on GBIF or Ecdysis is CC BY-NC 4.0, except Oregon's 2018 dataset, which is CC BY 4.0. No program has a published privacy policy, sensitive-species policy or publication embargo. Oregon's embargo exists only as practice, as CONTEXT.md records. The licence half of the gate can be pre-filled from the GBIF datasets below. The privacy half needs each program to decide.

| Program | Where its records are published | Licence (found) | Published data-use, privacy or sensitive-data text (found) |
|---|---|---|---|
| Oregon Bee Atlas (OSU / OSAC) | GBIF "Oregon Bee Atlas" `1fa69ff3-…`, via OSAC's IPT; also the older yearly datasets `b2974853-…` (2018) and `3301620d-…` (2019) | Cumulative: CC BY-NC 4.0. 2018: CC BY 4.0. 2019: CC BY-NC 4.0 | Only the 2019 dataset's coordinate rounding (quoted below). No policy page. |
| Washington Bee Atlas (WSDA) | GBIF via WSU's collection in Ecdysis, "Washington State University Collection" `d4359efd-…` | CC BY-NC 4.0 | Only WSDA's agency-wide privacy notice and Ecdysis's general usage policy |
| BC Bee Atlas (Native Bee Society of BC) | Ecdysis collection NBSBC-BCBA, then GBIF `651fc93e-…` | CC BY-NC 4.0 | None. No privacy policy page exists on its site. |
| Idaho Bee Atlas | No GBIF dataset or Ecdysis collection found | none | None found |
| New Mexico Bee Atlas | No GBIF dataset or Ecdysis collection found | none | None found |
| Oklahoma Bee Atlas | No GBIF dataset found; based at the Oklahoma Natural Heritage Inventory (ONHI) | none | ONHI's general request page (quoted below), which does not mention bees |
| Master Melittology (OSU Extension) | Records go out through the atlases | none | None. It requires "a new volunteer service form annually", but the form is not published. |

### Oregon

- **Found.** The cumulative dataset's description says it "aggregates previously published data from 2018, and 2019, and will be the sole source of occurrence records for the program with updates and additions provided annually." Its licence is CC BY-NC 4.0. Its EML `intellectualRights` reads "This work is licensed under a Creative Commons Attribution Non Commercial (CC-BY-NC 4.0) License." Version 1.6 is dated 2026-07-28. Sources: [GBIF API](https://api.gbif.org/v1/dataset/1fa69ff3-3e40-465f-927f-12b1484d3731), [EML](https://osac.oregonstate.edu/ipt/eml.do?r=osac-oba).
- **Found.** The cumulative dataset covers more than Oregon: 64,711 records from Oregon, 153 from Idaho, 29 from Washington and 20 from California ([GBIF facet](https://api.gbif.org/v1/occurrence/search?datasetKey=1fa69ff3-3e40-465f-927f-12b1484d3731&limit=0&facet=stateProvince)). A program's archive therefore already holds records collected outside its atlas's region.
- **Found.** The 2019 dataset says: "Georeference data for these data has been rounded to the nearest integer, providing gross level visualization. More accurate geolocation data for these records is available (+/- 0.001 decimal degrees) by contacting the lead author … Additional associated plant record information is also available on request." Every record carries the `dataGeneralizations` value "Coordinates rounded to integer; more accurate locality information available via request from lead author" and the `informationWithheld` value "details and photovoucher for plant association; available on request to lead author". Sources: [GBIF API](https://api.gbif.org/v1/dataset/3301620d-6750-434e-97ad-abfac165bb9c), [IPT archive](https://osac.oregonstate.edu/ipt/archive.do?r=oregonbeeatlas_data_2019).
- **Found.** The cumulative dataset now publishes those same 2019 records with coordinates mostly at 3 decimal places (about 100 m), with no `dataGeneralizations` or `informationWithheld` (from the [IPT archive](https://osac.oregonstate.edu/ipt/archive.do?r=osac-oba)). Whatever the 2019 rounding protected is now public.
- **Found.** The Melittoflora page says the data "becomes available as it is curated … (GBIF) where the Oregon Bee Atlas data is published on a semi-annual basis" ([agsci.oregonstate.edu/bee-atlas/melittoflora](https://agsci.oregonstate.edu/bee-atlas/melittoflora)). The dataset itself says "annually". The two disagree.
- **Found.** None of the following has a data-use, privacy or request policy: [agsci.oregonstate.edu/bee-atlas](https://agsci.oregonstate.edu/bee-atlas) and its subpages, [extension.oregonstate.edu/bee-atlas](https://extension.oregonstate.edu/bee-atlas), and OSAC.

### Washington

- **Found.** The atlas page says: "The WSDA pollinator taxonomist then identifies the bee specimens and provides the data to the public, including researchers, agricultural stakeholders, and conservation groups." ([agr.wa.gov/beeatlas](https://agr.wa.gov/beeatlas)).
- **Found.** WSDA's agency privacy policy says: "Information you send us may become a public record, and it may be subject to public inspection and copying" ([agr.wa.gov/contact-us/privacy-policy](https://agr.wa.gov/contact-us/privacy-policy)). *Inferred:* Washington's records are held by a state agency, so the state's public-records law may reach data a policy would otherwise withhold. Washington's staff should confirm this.
- **Found.** The WSU collection's GBIF dataset is CC BY-NC 4.0 and has an empty description ([GBIF API](https://api.gbif.org/v1/dataset/d4359efd-992b-414d-9b0a-3b83cb71b5c8), [EML](https://api.gbif.org/v1/dataset/d4359efd-992b-414d-9b0a-3b83cb71b5c8/document)). The Ecdysis profile shows no usage or sensitive-data statement ([collid 164](https://ecdysis.org/collections/misc/collprofiles.php?collid=164)).
- **Found.** Ecdysis's own usage policy says: "Ecdysis asks that users not redistribute data obtained from this site without permission for data owners." It also says that, unless stated otherwise, images are licensed CC BY-SA. It has no rule for sensitive localities ([ecdysis.org/includes/usagepolicy.php](https://ecdysis.org/includes/usagepolicy.php)).

### BC

- **Found.** The dataset description says: "Specimens are collected by volunteers trained through the Oregon State University Extension Service Master Melittologist Program, and donated to the Native Bee Society of BC … labels and data collection workflows are provided by the Oregon Bee Atlas." Its licence is CC BY-NC 4.0. Its records name the rights holder as "Native Bee Society of BC, Oregon Bee Atlas" ([GBIF API](https://api.gbif.org/v1/dataset/651fc93e-58d7-43e4-93d9-828e3a8b5547), [a record](https://api.gbif.org/v1/occurrence/search?datasetKey=651fc93e-58d7-43e4-93d9-828e3a8b5547&limit=1)). *Inferred:* BC names two rights holders, so "the program governs its records" may need a second party's agreement for BC.
- **Found.** The society says: "BC Bee Atlas data is live managed on Ecdysis and shared annually with the Global Biodiversity Information Facility (GBIF)" ([bcnativebees.org/bee-atlas](https://www.bcnativebees.org/bee-atlas)). `/privacy` and `/privacy-policy` on its site return 404.

### Idaho, New Mexico, Oklahoma and Master Melittology

- **Found.** None of these has a GBIF dataset, and none has a policy page about data use or privacy. Their iNaturalist projects say nothing about data use: Idaho's is project 289861, New Mexico's is [new-mexico-bee-atlas](https://www.inaturalist.org/projects/new-mexico-bee-atlas), and Master Melittology's is [master-melittologist-outside-of-oregon](https://www.inaturalist.org/projects/master-melittologist-outside-of-oregon).
- **Found.** The Master Melittologist apprentice page says: "We will also require you to complete a new volunteer service form annually," and "Specimens collected through the Apprentice level can be submitted to the Atlases in Oregon, Washington, New Mexico, Idaho or British Columbia" ([extension.oregonstate.edu](https://extension.oregonstate.edu/master-melittologist/master-melittologist-apprentice-program)). The form is not published. *Inferred:* if any consent from volunteers exists, it is in that form, so it is worth reading before the policies are written.
- **Found.** The Oklahoma Natural Heritage Inventory says: "Due to the sensitive nature of some of the data, precise locations and details are not publicly available," and "ONHI typically only provides information to the section level (1 mi2) or coarser" ([ou.edu/oknaturalheritage/request-data](https://ou.edu/oknaturalheritage/request-data)). That is the inventory's general practice. It does not mention bees.
- **Found.** Of the atlases' iNaturalist projects, only `oklahoma-bee-atlas` asks observers to trust it with hidden coordinates (`prefers_user_trust: true`). The Oregon, Washington, New Mexico and Master Melittology projects do not ([iNaturalist API](https://api.inaturalist.org/v1/projects/18521,166376,99706,115932,26258)).

---

## 2. What a privacy policy for occurrence data has to say

**For the design:** these are the minimum questions a program's policy must answer for Beeline to apply it without a person interpreting it each night. Each one comes from a source below.

1. **Which records are sensitive?** This can be a list of bee taxa, a list of host plants (the *sensitive host list*), or both. Each entry needs a scope (everywhere, or one state or province), a reason, who decided, and a date for review. Chapman asks for exactly these fields on a "trigger list".
2. **How far are sensitive records generalised?** The answer is a grid size from a small fixed set: withhold entirely, 1°, 0.1°, 0.01° or 0.001° (Chapman's categories 1 to 4). It can also be a named area, such as a county, which is Symbiota's choice. Chapman recommends rounding to a grid and strongly advises against random displacement.
3. **Which other fields are withheld with the coordinates?** Symbiota withholds the locality text, coordinates, elevation, habitat, date, collector's number and **associated taxa**. For bees the associated taxon is the host plant, and naming a rare host names its location. The policy has to say whether the host, the date and the sample or field number go out on a protected record.
4. **Are records near a sensitive one also generalised?** Chapman says that withholding only the sensitive record "is unlikely to be effective" when other records from the same event are published. For Beeline, this is the other specimens in the same sample.
5. **Is there a time embargo, and when does it end?** Oregon's embargo is real practice but unwritten. Chapman allows withholding unpublished or in-study data "for a short period" with a documented release date.
6. **Who may see the true values, and how?** Within the program the answer is already decided (CONTEXT.md). The policy needs to say who outside the program may, and on what terms. Chapman's answer is a written agreement between the provider and the user. Symbiota's is a "Rare Species Reader" permission for each collection.
7. **Are collectors' and identifiers' names published?** If they are, on what basis? This is section 5.
8. **How is it written into the record?** Fill `dataGeneralizations` and `informationWithheld` on every record that was changed, with replacement wording rather than a blank field (Chapman's Principle 7). The policy itself is published in the dataset's metadata (Chapman: a derived policy should be publicly available).

**Inferred.** Questions 1, 2, 3, 5 and 7 are what Beeline needs to transform an archive mechanically. Questions 4 and 6 tell Beeline what to refuse or flag, and how to word the records. A record of a "privacy policy established" that holds none of these answers gives Beeline nothing to apply. The gate should probably require at least an explicit answer to 1, 2, 3 and 7, even when the answer is "none" or "publish everything".

### The evidence

- **Found, from GBIF (Chapman 2020).** *Current Best Practices for Generalizing Sensitive Species Occurrence Data*, GBIF Secretariat, [doi:10.15468/doc-5jp4-5g10](https://doi.org/10.15468/doc-5jp4-5g10), read at [docs.gbif.org/sensitive-species-best-practices](https://docs.gbif.org/sensitive-species-best-practices/master/en/).
  - Section 4.2, Table 7, sets out the categories. Category 1 (extreme): withhold, or release only at the scale of a watershed, bioregion or county, or round to 1°. Category 2 (high): round to 0.1° (about 10 km). Category 3 (medium): round to 0.01° (about 1 km). Category 4 (low): round to 0.001° (about 100 m).
  - Section 4.1 strongly advises against randomising coordinates, which creates "false" data, and prefers grids, which keep "true" data.
  - Section 3 lists what may need withholding: names of living persons, locality, date, collector's number, habitat and landholder. Dates, collector names and numbers "may need restriction to prevent correlational deduction of locations".
  - Principle 4: every sensitivity decision carries a documented reason and a review date.
  - Principle 5: restrictions apply to the copies distributed, and the stored record is never altered. This matches Beeline's stance of keeping both coordinate pairs.
  - Section 6: decisions about access rest with the data provider, not with GBIF.
  - Scope: the guide explicitly does **not** cover the privacy of living people or of land, which vary by jurisdiction.
- **Found, from the Darwin Core standard ([TDWG](https://dwc.tdwg.org/terms/)).** [`dataGeneralizations`](https://dwc.tdwg.org/terms/#dwc:dataGeneralizations) is defined as "Actions taken to make the shared data less specific or complete than in its original form. Suggests that alternative data of higher quality may be available on request." Its example is "Coordinates generalized from original GPS coordinates to the nearest half degree grid cell". [`informationWithheld`](https://dwc.tdwg.org/terms/#dwc:informationWithheld) is defined as "Additional information that exists about a resource, but that is not shared publicly." Its examples are "location information not given for endangered species" and "collector identities withheld | ask about tissue samples". [`coordinateUncertaintyInMeters`](https://dwc.tdwg.org/terms/#dwc:coordinateUncertaintyInMeters) is the companion field, and Chapman asks that it be raised to cover the grid cell.
- **Found, from iNaturalist.** An obscured observation's public point is a random point within a 0.2° × 0.2° cell. Geoprivacy chosen by the observer and geoprivacy set for a taxon (through its conservation status) are separate. Taxon geoprivacy applies "automatically … to all observations of that taxon globally" or within a place ([iNaturalist help](https://help.inaturalist.org/en/support/solutions/articles/151000169938-what-is-geoprivacy-what-does-it-mean-for-an-observation-to-be-obscured-)).
  - In iNaturalist's API code, a curator of a collection project sees true coordinates only when the observer has opted in, either for any reason or only for observations obscured because of their taxon (`prefers_curator_coordinate_access_for: "any" | "taxon"`) ([iNaturalistAPI source](https://github.com/inaturalist/iNaturalistAPI/blob/97c7dac7cddab6d5ac84f336bf75d8e2fb866f4d/lib/models/observation.js#L81-L148)).
  - In iNaturalist's GBIF dataset, obscured records carry `informationWithheld` such as "Coordinate uncertainty increased to 27380m at the request of the observer" ([GBIF records](https://api.gbif.org/v1/occurrence/search?datasetKey=50c9509d-22c7-4a22-a47d-8c48425ef4a7&taxonKey=1340278&stateProvince=Oregon&limit=300)).
  - *Inferred:* iNaturalist's practice is a single 0.2° cell for every sensitive taxon, with the uncertainty field enlarged to match. That is about Chapman's category 2 (0.1°), applied to the whole observation. It does not distinguish a sensitive host from a sensitive bee.
- **Found, from Symbiota, which Ecdysis runs on.** Locality protection can be set on one record, on a taxon across the whole portal, or on a taxon within a state through a "Rare, threatened, protected species list". When it is on, the public sees "no locality details … below county". The withheld fields are listed under "Information Withheld" on the record's page. People with the "Rare Species Reader" permission can see and download the true values. The archive published to GBIF omits them when "Redact Sensitive Localities" is checked. The full list of withheld fields is: `recordnumber, eventdate, verbatimeventdate, locality, locationid, decimallatitude, decimallongitude, verbatimcoordinates, locationremarks, georeferenceremarks, geodeticdatum, minimumelevationinmeters, maximumelevationinmeters, verbatimelevation, habitat, associatedtaxa` ([Symbiota docs 3.4](https://docs.symbiota.org/Collection_Manager_Guide/Data_Publishing/redacting_obscuring_data/)).
  - Ecdysis's protected-species page lists only "Global Protections" for the whole portal, at the moment arachnids, beetles, millipedes and others, and no bees. It covers 22,818 protected occurrences ([ecdysis.org protected species](https://ecdysis.org/collections/misc/protectedspecies.php)).
  - *Inferred:* the taxon list in Ecdysis belongs to the portal, not to an atlas. A program that publishes through Ecdysis can rely on its list only by setting protection on each record (`RecordSecurity = 1` on upload). Beeline would have to send that flag, or send records that are already generalised.
- **Found: examples of short, published policies.**
  - Oklahoma's heritage inventory provides locations "to the section level (1 mi2) or coarser" (quoted in section 1).
  - The Consortium of Pacific Northwest Herbaria says only that "users should respect restrictions of access to sensitive data including localities for plants of conservation concern" ([pnwherbaria.org](https://www.pnwherbaria.org/data/datausagepolicy.php)).
  - Rare Care's volunteer monitors must "Keep all information on the exact location of rare plant populations confidential" ([UW Botanic Gardens](https://botanicgardens.uw.edu/science-conservation/rarecare/volunteer/monitor/)).
  - The Washington Natural Heritage Program's data use guidelines restrict its data to "non-commercial conservation, educational, and research use" and say it "should not be repackaged or redistributed" ([PDF](https://www.dnr.wa.gov/sites/default/files/2025-03/amp_nh_data_use_policy.pdf)). They set no precision rule.
  - **Correction for CONTEXT.md (found):** Rare Care is a program of the University of Washington Botanic Gardens and works with the Washington Natural Heritage Program. It is not a program of the Washington Native Plant Society. No published Rare Care rule about obscuring coordinates was found. Its stated practice is confidentiality.

---

## 3. One dataset per year, or one dataset

**For the design:** producing archives per program and season is a sound way for Beeline to divide the work and to check licences and policies. Publishing a season as its own GBIF dataset is not sound, because a later cumulative dataset republishes it. A program should publish one dataset that grows, and the season archives should feed it. Once a record has been published, its `occurrenceID` should never change, which ADR 0008 already guarantees. If a program ever moves records between datasets, it has to ask GBIF to migrate the identifiers, or the records appear twice.

**Found.** GBIF publishes no rule against one dataset per year. Its documentation instead gives reasons to split along other lines:

- Split when different licences apply: if "different licenses apply to separate components of a dataset, the recommended best practice is to publish each component separately" ([IPT manual, applying a licence](https://ipt.gbif.org/manual/en/ipt/latest/applying-license)).
- Split when someone wants to track downloads and citations separately. A GBIF staff reply on GBIF's forum suggests one dataset per station in that case ([discourse.gbif.org](https://discourse.gbif.org/t/preferences-or-recommended-best-practices-for-granularity-of-data/3146)).
- The dataset versioning policy issues a new major version and a new DOI after a scientifically significant change, and a minor version for every other republication ([IPT manual, versioning](https://ipt.gbif.org/manual/en/ipt/latest/versioning)). A dataset that grows each season fits this model directly.

**Found.** GBIF ties its record identifier (`gbifID`) to the publisher's `occurrenceID` within a dataset:

- "GBIF identifiers (i.e. gbifIDs) are automatically created by our system, using occurrenceIDs provided by publishers."
- GBIF pauses ingestion when more than half of a new version's `occurrenceID`s differ from the last version's.
- A publisher can give GBIF a list pairing old identifiers with new ones, and "migration can be done between datasets", which keeps the `gbifID`s.
- Without a migration, a record whose `occurrenceID` changed "will be considered deleted from the dataset, so the URL of the record will be deprecated."

Source: [GBIF data blog, 2023-11-06](https://data-blog.gbif.org/post/improve-identifier-stability/).

**Found.** GBIF's duplicate detection ("clustering") "only compares occurrences across datasets, not within datasets". It flags related records and does not remove them from searches or downloads. It does not group records whose dates or countries differ. It advises publishers to reuse the same identifiers and to declare relationships with `associatedOccurrences` ([GBIF technical docs](https://techdocs.gbif.org/en/data-processing/clustering-occurrences)).

### Oregon's datasets, checked against their archives

**Found.** I downloaded the three IPT archives and compared their identifiers:

| Dataset | Records | Also in the cumulative dataset with the same `occurrenceID` | Records GBIF has flagged as duplicates ("in cluster") |
|---|---|---|---|
| 2018 (CC BY 4.0) | 11,046 | 11,046 | 10,810 |
| 2019 (CC BY-NC 4.0) | 24,679 | 24,679 | 11 |
| Cumulative (CC BY-NC 4.0) | 64,913 | not applicable | 6,877 |

Neither yearly dataset is marked as superseded: `duplicateOfDatasetKey` is empty on both ([2018](https://api.gbif.org/v1/dataset/b2974853-6c41-4c63-a11b-7989e58a3ad4), [2019](https://api.gbif.org/v1/dataset/3301620d-6750-434e-97ad-abfac165bb9c)).

**Two worked examples.** Each is one specimen that is two records on GBIF.

- `https://osac.oregonstate.edu/OBS/OBA_1900466` is [gbifID 3499811429](https://api.gbif.org/v1/occurrence/3499811429) in the 2019 dataset, at 45.0, −123.0. It is also [gbifID 6158910319](https://api.gbif.org/v1/occurrence/6158910319) in the cumulative dataset, at 44.596, −123.314. Neither record is in a cluster. Because the 2019 coordinates were rounded to whole degrees, GBIF's location comparison cannot match them, so these duplicates are invisible to GBIF.
- `http://osac.oregonstate.edu/SP/OSAC_0001224646` is [gbifID 3033371848](https://api.gbif.org/v1/occurrence/3033371848) in the 2018 dataset, **CC BY 4.0**, at 45.28177, −122.74948. It is also [gbifID 6158909471](https://api.gbif.org/v1/occurrence/6158909471) in the cumulative dataset, **CC BY-NC 4.0**, at 45.282, −122.749. GBIF clusters these two. The older copy is more open and more precise than the newer one.

**Inferred.**

- The yearly Oregon datasets are now duplicates on GBIF. The cumulative dataset's own description says it replaces them, but nobody migrated the identifiers or deleted the old datasets. Whether Oregon should do that is OSAC's decision, not Beeline's. The choice includes deleting the old datasets or asking GBIF to migrate their records into the cumulative dataset.
- The lesson for Beeline is that an archive per season should never be registered with GBIF as its own dataset. The season belongs in the archive's filename and in Beeline's checks. On GBIF it is a filter on `year` or `eventDate`.
- If a program wants citable season snapshots, the dataset versions and their DOIs already provide them.

---

## 4. Changing a licence over time

**For the design:** GBIF gives a published dataset one licence, and a CC licence that has been granted cannot be withdrawn. Recording a licence "from season X on" is still a useful internal rule. It decides which licence a season's records carry. But a cumulative dataset can declare only one licence. Beeline then has two consistent choices, and none is chosen here:

- **(a)** The archive declares the most restrictive licence among the seasons it holds. This is what iNaturalist does for its GBIF dataset, and it means a tightening re-licenses older seasons going forward.
- **(b)** Records under different licences go into separate datasets, as GBIF's IPT manual recommends.

Under either choice, records already published under a more open licence stay available under it to anyone who obtained them.

**Found.**

- GBIF accepts only CC0 1.0, CC BY 4.0 and CC BY-NC 4.0, and "Datasets published with a different license to those included by GBIF cannot be published to GBIF" ([IPT manual, licence](https://ipt.gbif.org/manual/en/ipt/latest/license)). "The license chosen must apply to the dataset as a whole", and "All licenses specified at the record level should comply with the license at the dataset level" ([IPT manual, applying a licence](https://ipt.gbif.org/manual/en/ipt/latest/applying-license)).
- GBIF encourages "the least restrictive licence possible" ([IPT manual, manage resources](https://ipt.gbif.org/manual/en/ipt/latest/manage-resources)).
- *Found only through search extracts of [gbif.org/terms](https://www.gbif.org/terms), which refuses automated fetches:* GBIF says it has "neither the interest nor the resources to enforce" the non-commercial (NC) term by legal means.
- **iNaturalist chooses one licence for its whole GBIF dataset.** An iNaturalist staff reply on iNaturalist's forum says: "GBIF requires us to choose a license for the dataset as a whole, and thus we choose the most conservative license among those allowed in the dataset. It does not change the license of the individual records" ([forum.inaturalist.org](https://forum.inaturalist.org/t/inaturalist-data-on-gbif-shows-only-cc-by-nc-excluding-cc0-and-cc-by/9952)). Its dataset includes only observations licensed CC0, CC BY or CC BY-NC, and declares CC BY-NC ([GBIF API](https://api.gbif.org/v1/dataset/50c9509d-22c7-4a22-a47d-8c48425ef4a7)).
- **GBIF shows the dataset licence on each record, not the record's own `license` value.** In Oregon's archives, every record's `license` column says CC BY-NC-SA (4.0 in the cumulative and 2019 archives, 3.0 in the 2018 archive). GBIF serves those records as CC BY-NC 4.0 and CC BY 4.0 respectively, the licence of the dataset each sits in (the gbifIDs above). *Inferred:* licence values that GBIF does not support are ignored. I did not test whether GBIF honours a supported record-level licence that differs from the dataset's.
- **Creative Commons licences cannot be revoked.** "CC licenses are not revocable. Once something has been published under a CC license, licensees may continue using it according to the license terms." A licensor "may stop distributing under the CC license at any time", but "anyone who has access to a copy of the material may continue to redistribute it under the CC license terms" ([CC FAQ](https://creativecommons.org/faq/#what-if-i-change-my-mind-about-using-a-cc-license)).
- **CC licences cover only material that copyright or database rights protect.** "CC licenses do not contractually impose restrictions on uses of a work where there is no underlying copyright" ([CC FAQ](https://creativecommons.org/faq/)).

**Inferred.**

- A licence on GBIF attaches to the **dataset as published**. The record-level column does not carry it. So the date that matters downstream is when a version was published, not when the specimens were collected.
- "Licence from season X on" is best read in Beeline as "records collected from season X on may be published under no more than this licence". When a program tightens its licence, the 2018 example shows the result: the earlier, more open grant survives in every copy already taken, and in any older dataset left on GBIF.
- If a program wants a licence change to take effect, it should state the change in the dataset's description, as Oregon did not.
- Whether occurrence records are copyrightable at all varies by jurisdiction, and that is a question for each program's institution. In the US, facts are not protected by copyright, which may make the NC term largely unenforceable.

---

## 5. Collectors' names are personal data

**For the design:** every atlas that publishes today puts collector and identifier names in `recordedBy` and `identifiedBy`. Oregon's 2018 records go further: their **`occurrenceID` contains the collector's name**, so the name is now part of a permanent identifier on GBIF. ADR 0008 already prevents this for Beeline, because its UUID is "a function of nothing". The privacy policy should state whether names are published, and on what basis. BC needs particular care, because its law reaches non-profit societies and the society publishes no privacy policy.

**Found.**

- **Oregon.** All 64,913 records in Oregon's cumulative archive carry `recordedBy` and `identifiedBy`. In both the 2018 archive and the cumulative one, most 2018 records have an `occurrenceID` of the form `…/OBS/OBA_<collector's name>:<number>`, taken from the field numbers of that era. No example is quoted here, because each one contains a volunteer's name. The [IPT archive](https://osac.oregonstate.edu/ipt/archive.do?r=osac-oba) shows them. BC's and WSU's records also carry `recordedBy`.
- **GBIF.** *Found only through search extracts of GBIF's privacy policy, which refuses automated fetches ([old.gbif.org/terms/privacy-policy](https://old.gbif.org/terms/privacy-policy)):* GBIF processes personal data about a person when they are "the observer, collector or identifier of a species contained within a record in our database", and says it complies with the GDPR. Chapman 2020 lists "names of living persons" among the fields that may need withholding, and gives the wording "name suppressed for reasons of privacy". It also says privacy is outside its scope (section 2 above).
- **UK aggregator.** The NBN Atlas says: "Data providers are responsible for deciding whether the names of their recorders, determiners and verifiers can be included". It lists "public task", "legitimate interest" and asking permission from the people named as possible legal bases ([docs.nbnatlas.org](https://docs.nbnatlas.org/share-data-with-the-nbn-atlas/personal-information-in-shared-data/)). This is UK practice under the GDPR, given here as an example of how a publisher frames the decision, not as a rule that binds these programs.
- **Darwin Core.** The standard provides `recordedByID` and `identifiedByID` for identifiers such as ORCID ([TDWG](https://dwc.tdwg.org/terms/#dwc:recordedByID)), and `informationWithheld`'s own example is "collector identities withheld".
- **BC.** British Columbia's Personal Information Protection Act (PIPA) "regulates the information and privacy practices of corporations, not-for-profits, charities, trade unions, credit unions, and other private sector organizations that collect, use, or disclose personal information" ([OIPC BC](https://oipc.bc.ca/for-private-organizations/)). The Native Bee Society of BC publishes no privacy policy (section 1).
- **Volunteer agreements.** No atlas or Master Melittology page publishes a consent or volunteer agreement covering names. The Master Melittology program collects a volunteer service form every year, but the form is not public (section 1).

**Inferred.**

- How BC's law applies to the specimens donated to the society, and whether the federal private-sector law (PIPEDA) applies instead or as well, is a question for a lawyer or for the society. These sources do not settle it.
- What the sources do support is the shape of the policy question: name or withhold, and on what basis. The policy should also say whether names are replaced, for example with a stable identifier, or simply withheld.
- Washington's records are held by a state agency, and its privacy notice points to the Public Records Act (section 1). That could cut against withholding names there.

---

## 6. Embargoes on particular records

**For the design:** no standard or downstream system will carry an embargo for Beeline. GBIF, the IPT and Darwin Core have none, and Symbiota (and so Ecdysis) can hide a record but cannot let the hide expire. So Beeline has to hold the embargo and leave embargoed records out of what it exports until the date. Combining the models below, an embargo needs to record the following. Each item comes from at least one source in this section.

- **Which records.** An embargo is one grant applied to a set of records, as Arctos links one encumbrance to many catalogue records. *Inferred:* for Beeline the natural sets are a sample (every specimen collected in one event), a taxon within a program, or a list of specimens. Withholding one specimen while the rest of its sample is published can give away its date and place (Chapman's point about related records, in section 2), so an embargo set on a sample should cover all of its specimens.
- **Until when.** A fixed expiry date, after which the embargo ends without anyone acting. Arctos caps it at five years from the last edit and lets it be renewed indefinitely, with a yearly reminder to staff. BOLD's standard is 12 months. Chapman asks only that a "time for release or review be clearly documented".
- **Who granted it, and when.** Arctos records the agent who made the encumbrance and the date it took effect, and says the collection has the final say. *Inferred:* in Beeline this is the program's governor or lead, for the person it benefits, such as the graduate student.
- **Why.** A reason in words. Chapman's example is "awaiting publication", and Symbiota keeps a short reason beside its hide.
- **What it hides.** Either the whole record, or only some fields (coordinates, year, collector, field number). Arctos offers both. *Inferred:* a publication embargo usually means the whole record, but the option matters for embargoes on sensitive data.

**Inferred: how embargoes interact with archives per program and season.**

- An embargo has to be judged on the **record and the date the archive is produced**, not on the season. A specimen collected in 2026 and embargoed until 2028 is missing from every 2026 archive produced before 2028. After that it has to appear somewhere. If each season's archive is published once and frozen, the record has nowhere to go. A cumulative dataset that grows (section 3) picks it up in its next version without any special handling.
- An embargo must be in place **before a record is first published**. Removing a published record from a later version makes GBIF treat it as deleted and retire its `gbifID` (section 3), and copies already downloaded remain under their CC licence (section 4). So Beeline should refuse an embargo on a record that has already gone out, or at least warn that the embargo will not take it back.
- The program's privacy policy (section 2, question 5) can set a default embargo for a whole program, such as Oregon's current practice. An embargo on particular records is an exception granted on top of that default. Both are checked when an archive is produced.
- Today Oregon's embargo is done by hand: staff download the data and upload only what they do not want embargoed (CONTEXT.md, "Publication embargo"). Recording the embargo in Beeline replaces that judgement with a check, and it leaves a record of who granted what.

### What the sources say

**(a) GBIF, the IPT and Darwin Core: no embargo mechanism.**

- **Found.** The word "embargo" does not appear in the Darwin Core terms list ([TDWG](https://dwc.tdwg.org/terms/)), the IPT manual's resource-management pages or FAQ ([manage resources](https://ipt.gbif.org/manual/en/ipt/latest/manage-resources), [FAQ](https://ipt.gbif.org/manual/en/ipt/latest/faq)), or Chapman 2020 (I searched each page's text on 2026-10-10).
- **Found.** The IPT's only way to hold data back is to keep the whole resource "Private", which "is primarily meant to preserve the resource from public visibility until it has been completely and properly configured" ([IPT manual](https://ipt.gbif.org/manual/en/ipt/latest/manage-resources)). That works for a whole dataset, not for particular records.
- **Found.** Chapman 2020 counts "data awaiting publication, data subject to ongoing research, and incomplete or unchecked data" among the kinds respondents treat as sensitive. It says "This is data whose sensitivity has a short time frame, and it is important that a time for release or review be clearly documented", and that the reason recorded would be "awaiting publication". It adds: "All data regarded as being sensitive should include a date for review of their sensitivity status, along with documented reasons" ([docs.gbif.org](https://docs.gbif.org/sensitive-species-best-practices/master/en/)).
- **Found.** The Darwin Core terms each describe something that *is* published:
  - [`informationWithheld`](https://dwc.tdwg.org/terms/#dwc:informationWithheld): "Additional information that exists about a resource, but that is not shared publicly."
  - [`dataGeneralizations`](https://dwc.tdwg.org/terms/#dwc:dataGeneralizations): "Actions taken to make the shared data less specific or complete than in its original form."
  - [`accessRights`](https://dwc.tdwg.org/terms/#dcterms:accessRights): "Information about who can access the resource or an indication of its security status", which "may include information regarding access or restrictions based on privacy, security, or other policies".
- **Inferred.** These terms suit an embargo that masks some fields of a published record. A record withheld whole is simply absent from the archive, and no term can describe it. The IPT manual's warning "Be careful not to add contradictory usage restrictions in the Darwin Core term accessRights" ([applying a licence](https://ipt.gbif.org/manual/en/ipt/latest/applying-license)) suggests not using `accessRights` to state an embargo on records that are already published under an open licence.

**(b) Symbiota and Ecdysis: hide whole records, with no expiry.**

- **Found, in Symbiota's source ([Symbiota/Symbiota](https://github.com/Symbiota/Symbiota) at commit `bfc470e5`).** A record's `recordSecurity` field has two protected values:
  - `1` is locality security, which withholds the fields listed in section 2.
  - `5` is "Full Security" (`content/lang/collections/editor/occurrenceeditor.en.php`). The public record page answers "ERROR: record has full protection" to anyone who is not an editor (`collections/individual/index.php`, lines 84–87). The archive writer deletes these records from any public download and from "DwC-A publishing event pushed to aggregators … Even if user is authorized to download these records … to ensure these records are not accidentually pushed to public" (`classes/DwcArchiverCore.php`, around lines 1835–1846).
- **Found.** The only other field stored beside the setting is `localitySecurityReason`, `varchar(100)` (`config/schema/3.0/db_schema-3.0.sql`). Neither the schema nor the code has an expiry date or a field for who granted the protection. The only "embargo" strings in the code base are the Spanish *sin embargo* ("however").
- **Inferred.** Ecdysis could carry an embargo only as "Full Security" set on upload, and someone would have to lift it by hand when the date passes. Washington and BC publish to GBIF through Ecdysis, so if Beeline sends Ecdysis an embargoed record, the embargo depends on a person remembering. It is simpler and safer for Beeline not to send the record to Ecdysis until the embargo ends.

**(c) Arctos encumbrances: the worked model.**

- **Found** in the [Arctos handbook](https://handbook.arctosdb.org/documentation/encumbrance.html), whose source is in [ArctosDB/documentation-wiki](https://github.com/ArctosDB/documentation-wiki/blob/gh-pages/_documentation/encumbrance.markdown).
  - "An Encumbrance restricts the visibility of catalog record to only the collection managers."
  - It has these fields: `encumbering_agent_id`, `made_date`, `expiration_date`, `encumbrance` (a name), `encumbrance_action` and `remarks`. The `encumbering_agent_id` is the "Agent making, and able to remove, the encumbrance. This agent may act in an advisory role; final authority to remove encumbrances rests with the collection."
  - On expiry: "All encumbrances are temporary, and encumbrances must be periodically reviewed … Yearly email notifications are provided to collection staff, and encumbrances may be extended (in 5-year increments) indefinitely … the expiration date cannot be changed to a date more than five years in the future … encumbrances are automatically retracted when the expiration date is reached."
  - A separate table (`coll_object_encumbrance`) links one encumbrance to many catalogue records.
  - The handbook also says: "Do not use Encumbrances for truly sensitive information", and points to its "locality access" setting for withholding place and time.
- **Found, in Arctos's SQL as of 2019 (Oracle era, [ArctosDB/DDL](https://github.com/ArctosDB/DDL)).** These files show the actions and how they are applied:
  - `mask record` leaves the record out of the public table (`flat/filtered_flat.sql`, line 387: `encumbrances is null or encumbrances NOT LIKE '%mask record%'`). The IPT view draws from that table.
  - `mask collector` and `mask original field number` replace the value with "Anonymous".
  - `mask year collected` replaces the year with "8888".
  - `mask coordinates` sets the coordinates to null (`flat/IPT/ipt_view.sql`).
  - There is also `mask part attribute`.
  - The archive sent to the IPT puts the names of the encumbrances into `informationWithheld` (`ENCUMBRANCES informationWithheld`).
  - `restrict usage` appears among the action values in `info/encumbrances.cfm` ([arctos-archive](https://github.com/ArctosDB/arctos-archive)).
  - I could not read the current action list. Arctos's code-table page answered 401, and Arctos has since moved databases, so the current code may differ.

**(d) Published policies on embargo lengths and who grants them.**

- **Found.** BOLD (the Centre for Biodiversity Genomics' DNA barcode database): "The embargo period is the amount of time following data upload to BOLD that the data remains private to the primary user. This period enables the primary user to interpret and publish their results before they become fully available … The official embargo period is 12 months." Data are released "twice per year". Keeping data private for longer is a paid service, reviewed "case-by-case" ([CBG data release policy, March 2023](https://biodiversitygenomics.net/wp-content/uploads/2024/01/DataReleasePolicy_Mar2023.pdf)).
- **Found.** The Natural History Museum, London has an exception for "Research competitiveness". It covers "unpublished data generated by NHM scientists which, if released immediately, would negatively impact the Museum's research competitiveness". The policy says "any embargoes resulting from this exception apply internally as well as externally, to anyone beyond the Principal Investigator and to any named individuals", and that they "should be time limited". The permitted action is a "Time-delayed release (i.e. embargo, with an agreed time limit and process for review for extension or subsequent release)". The policy gives no number of years ([Woodburn et al. 2024, *Open Information and Exceptions Policy of the Natural History Museum, London*, doi:10.3897/rio.10.e120629](https://doi.org/10.3897/rio.10.e120629)).
- **Found.** Arctos's limit is five years at a time, renewable (above). Chapman sets no length.
- **Inferred.** The published practice ranges from a fixed 12 months (BOLD) to a renewable five years (Arctos), and always has a named grantor and a review. None of the bee atlases publishes a length. Oregon's rule ("long enough for any grad student who wants to publish findings from it to do so first", CONTEXT.md) is a reason, not a date, so each embargo Oregon grants still needs its own expiry date.
- **Inferred.** The NHM's point that an embargo applies "internally as well as externally" differs from Beeline's settled stance that a program's staff see their own program's records. If a program wants an embargo to hide records from other staff, that is a separate decision from leaving them out of exports, and these sources do not settle it.

---

## Not found, and what to ask

- No program has a published policy on sensitive species, sensitive hosts, embargo or privacy. Each program's lead would have to write one. These questions are the program's to answer, not Beeline's.
- The Master Melittology volunteer service form, which may already say something about names and data use, is not public. Ask OSU Extension for it.
- GBIF's licensing page and privacy policy could not be fetched directly. Their claims above rest on search extracts and are marked as such.
- I found no GBIF statement on how it treats a supported record-level licence that differs from the dataset's. The Oregon evidence covers only unsupported values.
- Arctos's current list of encumbrance actions could not be read (its code-table page needs a login). The list above comes from its 2019 SQL.
- Whether Oregon's yearly datasets should be deleted or migrated into the cumulative one is OSAC's decision. The evidence above is enough to raise it with them.
