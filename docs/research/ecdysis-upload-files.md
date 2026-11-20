# The two files uploaded to Ecdysis for the Washington Bee Atlas: a column-by-column specification

Written 2026-11-20 for bead beeline-8dx9 (Beeline writes the two files itself, and a person keeps uploading them: Peter, 2026-11-20).

**Sources.** Joel Gardner's WaBA 2025 files, as sent on 2026-11-18 and stored in the received-files Drive folder:

- the input file, `WaBAData2025.xlsx` (old Beeline's export, which Joel starts from);
- the specimen upload, `WABA2025_template.ods`;
- the associations upload, `WABA2025_associations_template.ods`.

Beeline's side is read from the worktree `~/dev/beeline-archive-columns` (`src/app/dwc-archive.ts`, and `SpecimenRow` and `specimenCsvRow` in `src/app/listings.ts`) and from `schema/038_areas.sql`. Symbiota's side is read from the plan and the importer test in this folder, `symbiota-import-test-2026-11-20.md`, and, where the test is silent, from the Symbiota source (commit 4491b791c, `~/dev/Symbiota`).

**How figures are marked.** Every count below was measured by reading the three files with a script on 2026-11-20, unless a line says READ (from source code, not run) or MEASURED IN THE TEST (from the importer test). "N" is 29,954, the number of data rows in the specimen upload. Nothing in this file names a volunteer, gives a coordinate or an address, and no file left this machine.

## 0. The three files at a glance

| File | Format | Sheets | Size |
|---|---|---|---|
| `WaBAData2025.xlsx` (input) | Excel workbook | one, `WaBAData2025`, 60 columns | 29,954 rows plus a header |
| `WABA2025_template.ods` (specimen upload) | OpenDocument spreadsheet (a zip of UTF-8 XML) | `WABA2025_clean`, 33 columns; `metadata`, 32 rows of two cells (column, how it is made) | 29,954 rows plus a header |
| `WABA2025_associations_template.ods` (associations upload) | OpenDocument spreadsheet | `WABA2025_associations`, 7 columns; `metadata`, 7 rows | 25,845 rows plus a header |

- No cell in either upload file holds a formula; every value is stored as a value (checked in the first 200 rows of each).
- The text columns of the specimen upload (`locality`, `municipality`, `recordedBy`, `verbatimCoordinates`) hold only ASCII and have no leading or trailing spaces.
- The files are called "template", and an ODS is not what Symbiota's importer takes. Whether the file that reaches Ecdysis is a CSV saved from this sheet, and in what encoding, is not in the files (question 1 in section 5). The importer test used CSV.
- The input file's `fieldNumber` is the label number (for example 25000001). Joel's `catalogNumber` and the join between the files both come from it.

The two upload files line up with the input like this: the specimen upload has the same 29,954 rows in the same order, and `catalogNumber` equals `WSDA_` plus the input's `fieldNumber` on every row. The associations upload has the 25,845 specimens that have an iNaturalist observation, in the same order.

## 1. The specimen upload, column by column

The header row is the file's own order, which is not the order in the `metadata` sheet. The `metadata` sheet describes 32 columns; the data has 33, and `habitat` is the one with no description.

"Kind" is one of: fixed value, straight copy, reformat, or hand edit (Joel changes the value by hand). "Symbiota field" says where the column loads. Joel's sheet never states a Symbiota field. Where I give one, it is READ: the header equals a column of Symbiota's `omoccurrences` table in schema 3.0, which the upload mapping matches by name. The importer test confirmed that name matching only for `eventDate2`.

| # | Header | What Joel's sheet says (quoted) | What the data holds (measured) | Symbiota field | Where Beeline gets it | Kind |
|---|---|---|---|---|---|---|
| 1 | `catalogNumber` | "fieldNumber prefixed with “WSDA_”" | Filled on 100%. Always `WSDA_` followed by the input's label number (0 rows differ). All 29,954 distinct. | `catalogNumber`; the key a live-managed collection matches on (importer test, B1) | `SpecimenRow.catalog_number` where Ecdysis reported one; otherwise the program's catalog prefix plus `field_number`, as `archiveRow` already does (bead 5pza) | Reformat (prefix plus copy) |
| 2 | `recordedBy` | "no change" | Filled on 100%, 93 distinct. Differs from the input on 1,921 rows (6.4%), for three collectors: a middle initial added for two of them (1,833 rows), and a one-letter first-name spelling fix for the third (88 rows). | `recordedBy` | The collectors' display names joined with " \| ", as `recordedBy(page, sample_id)` writes them | Straight copy, with 3 hand edits (see section 2) |
| 3 | `fieldNumber` | "concatenation of sampleId and specimenId, separated by “.”" | Filled on 100%, 3,758 distinct. The cells are numbers (29,953 decimal, 1 whole number), not text. Numerically it equals sample number dot specimen number on every row (0 differ). As text it loses a zero on 1,318 rows: specimen 10 of sample 1 reads 1.1, the same as specimen 1, and specimen 0 reads as a whole number. Within one collector, one date and one sample, 1,105 pairs of different specimens (2,257 rows) therefore share a value. | `fieldNumber` (varchar 45) | `${sample_number}.${specimen_number}` as text, which `archiveRow` already writes as `recordNumber` | Reformat |
| 4 | `day` | "no change" | Whole numbers 1 to 31; 100% filled; equals the input on every row. For a trap sample it is the start day (checked on all 2,037 ranges). | `day` | `date_start` | Straight copy |
| 5 | `month` | "no change" | Whole numbers; 100%; equals the input. Counts: June 7,125; May 6,717; July 6,322; August 3,582; April 3,389; September 2,174; March 481; October 114; November 27; February 21; January 1; December 1. | `month` | `date_start` | Straight copy |
| 6 | `year` | "no change" | Constant 2025. | `year` | `date_start` | Straight copy |
| 7 | `verbatimEventDate` | "no change" | Filled on 100%. In the input, 27,917 rows are date cells and 2,037 are text ranges. In the upload, the 27,917 are text in the form `M/D/YYYY` with no zero padding, so the description is wrong for them: the format changed (0 rows differ in meaning from the input's date). The 2,037 ranges are copied as text in the form `YYYY-M-D/YYYY-M-D`, also unpadded. | `verbatimEventDate` | `date_start` and `date_end`, formatted | Reformat |
| 8 | `eventDate2` | "concatenation of day2, month2, and year2 (if present), formatted as YYYY-MM-DD" | Filled on 2,037 rows (6.8%), every one a blue vane trap sample. Equals the input's end date on every row. The cells are date values displayed as `YYYY-MM-DD`. | `eventDate2` (Symbiota's own term; the importer test, C1, showed a header with this name keeps the end date, while a range inside `eventDate` loses it) | `date_end`, written only where it differs from `date_start` (as `eventDate(...)` decides) | Reformat |
| 9 | `country` | "expand USA to United States, etc." | Constant `United States` (the input holds `USA` on all rows). | `country` | `SpecimenRow.country` (three-letter code) turned into the name through a table Beeline does not have yet (it has the two-letter table `ALPHA2` for the other direction) | Fixed value (reformat) |
| 10 | `stateProvince` | "expand WA to Washington, etc." | Constant `Washington` (the input holds `WA`). | `stateProvince` | `SpecimenRow.state_province` (abbreviation) turned into the name through a table | Fixed value (reformat) |
| 11 | `county` | "no change" | 38 distinct, 100% filled, 0 rows differ from the input. | `county` | `SpecimenRow.county` | Straight copy |
| 12 | `locality` | "several refining steps: expand all abbreviations, replace “nearest city” localities with names of parks, etc., or if not within a clear named landscape feature nor within a city, keep nearest city but prefix with “near” to indicate specimen was not collected in city limits (in practice most localities are “near [city]” because extracting more accurate place names is too laborious except for parks and refuges with clear borders)" | Filled on 28,355 rows (94.7%), 343 distinct; blank on 1,599 rows, where the town moved to `municipality`. Differs from the input on 26,309 rows (87.8%). The sheet says most are "near <city>"; measured, 11,144 rows (37.2%) are "near" and 13,566 (45.3%) are a different place name. Details in section 2. | `locality` | `SpecimenRow.locality` is the label's locality, not this refined one (see section 2) | Hand edit |
| 13 | `municipality` | "locality, if within city/populated place" | Filled on 3,174 rows (10.6%), 45 distinct towns. On 1,587 of them the town is the input's locality and `locality` is left blank; on 986 a park or other place replaces the locality; on 589 the locality is kept; on 12 something else. | `municipality` | Beeline does not hold this: it has no city boundaries (see section 2) | Hand edit |
| 14 | `habitat` | Not described | Filled on 52 rows (0.2%), always `herb garden`; all 52 are the input's locality "UW Herb Garden". The input has no habitat column, so Joel typed it. | `habitat` | Beeline does not hold this | Hand edit |
| 15 | `verbatimCoordinates` | "original locality from Beeline and printed on specimen label (Ecdysis does not have a verbatimLocality field so we use verbatimCoordinates to preserve both verbatim locality and coordinate data)" | 100% filled, 413 distinct. Equals the input's `locality` on every row (0 differ). It holds the label's locality only; no coordinates are in it, which the description suggests it might carry. | `verbatimCoordinates` (varchar 255) | `SpecimenRow.locality`, as long as that is the locality that was printed | Straight copy of the input's locality |
| 16 | `verbatimElevation` | "no change" | Whole numbers, 0 to 2,293; filled on 28,081 rows (93.7%). Blank on 1,873 rows: 1,806 vane traps, 65 pan traps, 2 aerial net. Zero on 141 rows. 0 differ from the input. | `verbatimElevation` | `SpecimenRow.elevation_m` | Straight copy |
| 17 | `minimumElevationInMeters` | "same as verbatimElevation" | Identical to column 16 on every row. | `minimumElevationInMeters` | `SpecimenRow.elevation_m` | Straight copy |
| 18 | `decimalLatitude` | "no change" | Filled on 100%; at most 4 decimal places; 0 differ from the input. | `decimalLatitude` | `SpecimenRow.latitude`, the true point (see bead 8dx9.7, where 43 rows were obscured) | Straight copy |
| 19 | `decimalLongitude` | "no change" | As column 18. | `decimalLongitude` | `SpecimenRow.longitude` | Straight copy |
| 20 | `coordinateUncertaintyInMeters` | "no change" | Whole numbers, 1 to 243; filled on 25,543 rows (85.3%). Blank on 4,411: 2,173 aerial net, 2,037 blue vane trap, 201 net. 0 differ. | `coordinateUncertaintyInMeters` | `SpecimenRow.coordinate_uncertainty_m` | Straight copy |
| 21 | `geodeticDatum` | "always WGS84" | Constant `WGS84`. | `geodeticDatum` | The `datum()` function in `listings.ts` already writes `WGS84` | Fixed value |
| 22 | `georeferenceSource` | "always “label” to indicate georeference comes from original specimen label" | Constant `label`. | No column of this exact name in `omoccurrences`; the schema has `georeferenceSources`, and Symbiota's name map translates only `georeferencingsource` to it (READ). How Joel's header loads is not stated. | Fixed value. `SpecimenRow.location_source` is a different thing (where the point came from) and must not be written here | Fixed value |
| 23 | `samplingProtocol` | "no change" | Five values: aerial net 25,845; blue vane trap 2,037; vane trap 1,806; net 201; pan trap 65. 0 differ. | `samplingProtocol` | `SpecimenRow.protocol` | Straight copy |
| 24 | `relationshipOfResource` | "always “hasHost” (this is Ecdysis controlled vocabulary)" | `hasHost` on 25,843 rows (86.3%); blank on the 4,109 rows with no observation and on 2 rows that do have one. The sheet says "always"; the data is not. The input holds `visits flowers of` on the same 25,843 rows. | None: no `omoccurrences` column. It belongs to the associations upload; Joel picks the relationship on the import page's form (importer test, C2). | Fixed value `hasHost`, per Joel's choice | Fixed value (helper column) |
| 25 | `associationType` | "always “Occurrence - External Link”" | Constant on all 29,954 rows, including the 4,109 that get no association. | None; the page's type choice. `Occurrence - External Link` is Symbiota's label for the `externalOccurrence` type (READ, `content/lang/collections/associations.en.php`). | Fixed value | Fixed value (helper column) |
| 26 | `relatedResourceID` | "no change" | Filled on 25,845 rows (86.3%), 5,353 distinct. Every value is a UUID (the iNaturalist observation's). 0 differ from the input. | None; feeds `objectID` in the associations upload | Beeline does not hold the observation's UUID. It holds the observation's numeric id (`SampleRow.inat_observation_id`), and the sync asks iNaturalist for the `uuid` field (`src/sync-inat.ts`) but no schema column keeps it. | Straight copy |
| 27 | `relationshipRemarks` | "no change" | Empty on all rows (0 filled). | None; feeds `notes` in the associations upload | Beeline does not hold this | Straight copy of an empty column |
| 28 | `associatedTaxa` | "concatenation of original relationshipOfResource (usually “visits flowers of”) and speciesPlant (or genusPlant if no species), in the format “relationship”:”plant” (this is in keeping with examples in Darwin Core documentation https://dwc.tdwg.org/list/#dwc_associatedTaxa), BUT quotes must be replaced with the word QUOTE during upload or they will be dropped; I immediately do a batch edit to replace QUOTE with “ after upload" | Filled on 17,654 rows (58.9%), 667 distinct plants. All 17,654 read `QUOTEhostQUOTE:QUOTE<species>QUOTE`. So the sheet and the data disagree twice: the relationship word is `host` on all 17,654, not "visits flowers of"; and a host named only to genus gets nothing (5,942 rows, see section 3). 23 names contain a hybrid sign. | `associatedTaxa` (stored as plain text; importer test, C2) | `associatedTaxa(host_name, protocol)` in `listings.ts` writes `"visits flowers of":"<plant>"` (or `"near"` for a trap); it takes the host from `SpecimenRow.host_name`, which can be a genus or higher | Reformat, with a hand edit afterwards (QUOTE back to a quote) |
| 29 | `url` | "no change" | The iNaturalist observation page, `https://www.inaturalist.org/observations/<id>`, on 25,845 rows (86.3%), 5,353 distinct. Blank on the 4,109 trap and net-without-observation rows. 0 differ. | None; feeds `resourceUrl` in the associations upload | `https://www.inaturalist.org/observations/` plus `SampleRow.inat_observation_id`. `SpecimenRow` has no such field today; it would need adding. | Straight copy (a reformat of the id) |
| 30 | `lifeStage` | "always “adult” (unless someone collects a larva or pupa someday)" | Constant `adult`. | `lifeStage` | Beeline does not hold a life stage; fixed value | Fixed value |
| 31 | `preparations` | "always “pinned”" | Constant `pinned`. | `preparations` | Fixed value | Fixed value |
| 32 | `labelproject` | "always “Washington Bee Atlas”" | Constant `Washington Bee Atlas`. | `labelProject` (varchar 250) | The program's name, a fixed value per atlas | Fixed value |
| 33 | `individualCount` | "always 1" | Constant 1. | `individualCount` | Fixed value | Fixed value |

**What the specimen upload leaves out.** There is no `eventDate`, no scientific name, no `identifiedBy`, no `sex`, no `caste`, no `occurrenceID`, no `disposition` and no `occurrenceRemarks` column. Symbiota builds `eventDate` from year, month and day when it is missing (READ, `SpecUploadBase.php`, about line 689); for a range, `eventDate2` then carries the end.

**Where the description and the data disagree, in one list (all measured):**

1. `associatedTaxa` uses `host` on 17,654 of 17,654 rows, not the original relationship word.
2. `associatedTaxa` and the plant name drop a genus-only host on 5,942 rows, although the sheet says "or genusPlant if no species".
3. `relationshipOfResource` is "always hasHost" in the sheet and is filled on 25,843 of 29,954 rows.
4. `verbatimEventDate` is "no change" in the sheet; 27,917 date cells became `M/D/YYYY` text.
5. `recordedBy` is "no change" in the sheet; 1,921 rows differ.
6. `locality` is mostly "near <city>" in the sheet; the larger share is a different place name (13,566 rows against 11,144).
7. `verbatimCoordinates` holds the locality only, no coordinates.
8. `habitat` is in the data and not in the sheet (52 rows).

## 2. What Joel changes by hand

I joined the specimen upload to the input on the label number (`catalogNumber` without `WSDA_` against the input's `fieldNumber`). All 29,954 rows pair up, with no row on either side alone. Counts of rows that differ, per column:

| Column | Rows that differ from the input | Share |
|---|---|---|
| `recordedBy` | 1,921 | 6.4% |
| `locality` | 26,309 | 87.8% |
| `municipality` (new column; filled) | 3,174 | 10.6% |
| `habitat` (new column; filled) | 52 | 0.2% |
| every other column Joel copies (`day`, `month`, `year`, `county`, `samplingProtocol`, `verbatimElevation`, `decimalLatitude`, `decimalLongitude`, `coordinateUncertaintyInMeters`, `relatedResourceID`, `url`, `relationshipRemarks`) | 0 | 0% |

The input file carries no scientific name, sex, caste or identifier, so nothing there was changed or lost either.

### Collector names

Three distinct names change. For two collectors a middle initial is added (1,833 rows). For one a first name is respelled by one letter (88 rows). Beeline holds collectors as people with display names, so the fix belongs in Beeline's record of the person.

### Localities

Each input row has one locality. In the upload, its fate is one of these (rows, measured; "combos" are distinct pairs of input and output):

| What Joel did to the locality | Rows | Share of N |
|---|---|---|
| Kept the locality unchanged, no municipality | 3,056 | 10.2% |
| Kept the locality unchanged, filled the municipality with a town (for example a park name kept, town added) | 589 | 2.0% |
| Left the locality blank and moved the input's value into `municipality` | 1,587 | 5.3% |
| Left the locality blank, municipality a different town from the input (for example a county name used as a locality) | 12 | 0.04% |
| Wrote "near " followed by the input's own locality | 9,244 | 30.9% |
| Wrote "near " followed by a different town (for example the input "Dungeness" became "near Sequim", the input "Vancouver" became "near Brush Prairie") | 1,900 | 6.3% |
| Replaced the locality with another name, no municipality | 12,580 | 42.0% |
| Replaced the locality with another name and filled the municipality | 986 | 3.3% |

The 13,566 replacements (the last two lines of that table) split by how the new name relates to the label's. I sorted them by comparing the two strings; the rows add up to 13,566:

| Kind of replacement | Rows | Examples (places only) |
|---|---|---|
| An abbreviation in the label is expanded (usually together with a fuller or changed name) | 6,892 | "Olympic NP" became "Olympic National Park"; "Ridgefield NWR" and "RNWR" became "Ridgefield National Wildlife Refuge"; "Potholes SP" became "Potholes State Park"; "W Orcutt" became "West Orcutt Road"; "Snow Mtn Ranch" became "Snow Mountain Ranch"; "UBNA" became "Union Bay Natural Area"; "Highway 262 SE" became "Washington State Route 262" |
| The label's name is completed by a type word or a longer name | 1,380 (1,209 and 171) | "Umtanum" became "Umtanum Creek"; "Vashon" became "Vashon Island"; "Little Naches" became "Little Naches River"; "Juanita Bay" became "Juanita Bay Park"; "Arboretum" became "Evergreen Arboretum and Gardens" |
| Near-identical spelling, a spelling fix | 45 (10 distinct names) | "Orca Island" became "Orcas Island"; "Blewet Pass" became "Blewett Pass"; "Beever Creek" became "Beaver Creek"; "Fishtrap Lk" became "Fishtrap Lake" |
| A town or other label is replaced by a different named place | 5,249 | "Ellensburg" became "Umtanum Creek" (622 rows) or "Wild Horse Wind and Solar Facility" (88); "Yakima" became "Cowiche Canyon" (460), "Snow Mountain Ranch" (58) or "Chinook Pass" (53); "Electric City" became "Steamboat Rock State Park" (214); "Anacortes" became "Washington Park" (110); "Lyle" became "Catherine Creek" (113); "Twisp" became "Beaver Creek" (107) |

One label ("Pend Oreille NWR", 311 rows) became "Little Pend Oreille National Wildlife Refuge", and "Whitman NP" (460 rows) became "Whitman Mission National Historic Site": those are renames of the place and not only expansions. Several of the 413 distinct input localities map to more than one output: 81 do, so the replacement depends on where the point is and not on the label text alone (for example "Ellensburg", "Yakima", "Vancouver").

A second view of the same 13,566 replacements, by what kind of place the new name is (sorted by words in the name; an upper bound on what Beeline's Areas could name, not a measurement against the store, which I did not open):

| Kind of name | Rows | Beeline Area kind that could name it, if the gazetteer holds it |
|---|---|---|
| National wildlife refuge, national monument, national historic site, national park | 4,606 | `refuge`, `nps_unit` |
| State park, state wildlife recreation area, wildlife area unit, recreation area | 1,713 | `state_park`, `wildlife_area` |
| Island | 184 | `island` |
| A named park, preserve, natural area, campus, garden, trail, facility, ranch or institute | 2,695 | `city_park` or `park` for some; campuses, gardens and facilities are probably not in the gazetteer |
| A road, state route, creek, river, pass, lake, canyon or boat launch | 3,589 | none |
| Other (a state or national forest, a coulee, a cemetery, a spring, a summit) | 779 | none, or `park` for some |

### What the areas tables hold

`schema/038_areas.sql` defines `area` (a named place with an outline) and `sample_area` (which areas a sample's point lies inside). The kinds are `wilderness`, `county`, `ecoregion`, `refuge`, `wildlife_area`, `nps_unit`, `state_park`, `city_park`, `park` and `island`, from the sources wilderness.net, the Census Bureau's counties, the EPA's ecoregions, the Fish and Wildlife Service, the state wildlife agency, the Park Service, the state parks agency, and OpenStreetMap. There is no kind for a city, town or populated place, and no table of such places anywhere else in `schema/`. A comment in the file also says that nothing records that one area lies inside another. So:

- Beeline can say which refuge, park, wildlife area or island a sample's point is inside.
- Beeline cannot say that a point is inside a city, so it cannot fill `municipality`, and it cannot say that a point is outside every city, so it cannot choose between a town name and "near <town>".
- Beeline cannot name the nearest town either: that needs a list of towns with positions.
- Roads, creeks, passes and the like are not areas at all.

### Sorting the changes

Peter's view is that spelling and name corrections belong in the records upstream, and only format belongs in the export.

**Format the export can do** (no information is added or judged):

- the `WSDA_` prefix on the catalog number;
- the fixed values: country and state spelled out, datum, georeference source, life stage, preparations, individual count, project name, association type and relationship;
- the date forms: `day`, `month`, `year`, the `M/D/YYYY` verbatim date and the unpadded range text, and `eventDate2`;
- `fieldNumber` as sample dot specimen, written as text so that 1.10 stays 1.10;
- `verbatimCoordinates` set to the label's locality, and the two elevation columns set to one number;
- the observation URL from the observation's id;
- the QUOTE placeholder in `associatedTaxa`, if the file still needs one.

**Correction to make in Beeline's record** (the export would then only copy it):

- the three collector names (1,921 rows);
- the 45 rows of spelling fixes;
- the abbreviations written out in a locality, such as NP, NWR, SP, Mtn, directions on road names and agency initials (6,892 rows), and names completed by their type word (1,380 rows);
- renames and wrong names of a known place (the two refuge and national historic site examples above).

This depends on a decision the files cannot make: Joel keeps the label's own text in `verbatimCoordinates`, and the cleaned locality in `locality`. If the correction is made in Beeline's locality, the label text that was printed would also have to be kept (Beeline holds one locality per sample). Whether an abbreviation on a printed label counts as an error to correct, or is a verbatim value to keep beside a cleaned one, is Peter's call (bead 8dx9.2).

**Rewriting that needs data Beeline lacks:**

- every "near <town>" (11,144 rows), because it needs city boundaries and the position of towns;
- every `municipality` (3,174 rows), for the same reason;
- replacing a town by a road, creek, pass or lake (3,589 rows by the name test above), which no Area holds;
- replacing a town by a park, refuge, state park or similar (9,198 of the 13,566 replacements by the name test) is something Beeline's Areas can do where the gazetteer holds the place. I did not test how many of these rows Beeline's own areas would name, because that needs a store copy; the upper bound is above.
- `habitat` (52 rows), which Beeline does not hold at all.

## 3. The associations upload

### What each row is

One row per specimen that has an iNaturalist observation: 25,845 rows, with 25,845 distinct catalog numbers, in the same order as the specimen upload. The observation is shared: 5,353 distinct observations, up to 80 specimens on one observation, and every observation has exactly one plant name. So a row is one bee linked to its observation and its host plant; it is not one row per observation.

| # | Header | What Joel's sheet says (quoted) | What the data holds (measured) | Symbiota field | Where Beeline gets it | Kind |
|---|---|---|---|---|---|---|
| 1 | `subject identifier: catalogNumber` | "catalogNumber from specimen data sheet" | 100% filled, all distinct, `WSDA_` plus the label number. Equals the specimen upload's `catalogNumber` for the same row on all rows. | The page's `subject identifier: catalogNumber` target (READ, `OccurrenceImport.php`, line 440); it matches the existing record | As column 1 of the specimen upload | Straight copy |
| 2 | `subject identifier: occurrenceID` | "occurrenceID of bee specimen (only generated after upload to Ecdysis; must upload specimen data first, then download and fill in occurrenceIDs)" | 100% filled, all distinct UUIDs. The input's `occurrenceID` is empty on every row, so these came from Ecdysis. | The `subject identifier: occurrenceID` target (READ) | Beeline mints none yet (bead 8dx9.4 proposes minting one at print time, and ADR 0008 is to be amended) | Hand edit: downloaded from Ecdysis, then pasted in |
| 3 | `subject identifier: otherCatalogNumbers` | "not used" | Empty on every row. | The `subject identifier: otherCatalogNumbers` target | Not needed | Empty |
| 4 | `objectID` | "relatedResourceID" | 100% filled, 5,353 distinct UUIDs. Equals the specimen upload's `relatedResourceID` on every row. | The `objectID` target (READ) | Beeline does not hold the observation's UUID; it holds the numeric id | Straight copy |
| 5 | `notes` | "relationshipRemarks" | Empty on every row. | The `notes` target | Not needed | Empty |
| 6 | `verbatimSciname` | "speciesPlant (or genusPlant if no species)" | Filled on 17,654 rows (68.3%), 667 distinct, always a species name (23 with a hybrid sign). Blank on 8,191 rows. Equals the plant inside the specimen upload's `associatedTaxa` on every row. | The `verbatimSciname` target, offered for the `externalOccurrence` and `observational` types (READ) | `SpecimenRow.host_name` and `host_rank`; the species when the host is a species, a genus otherwise | Straight copy of the species only; the genus fallback is not done |
| 7 | `resourceUrl` | "url" | 100% filled, 5,353 distinct. Equals the specimen upload's `url` on every row. | The `resourceUrl` target, required for the `externalOccurrence` type (READ) | Observation id, as for `url` above | Straight copy |

### The relationship term

It is not a column in this file. The page takes the association type and the relationship from its form (importer test, C2), and Joel's sheet says he uses the type "Occurrence - External Link" and the relationship `hasHost`, which his specimen upload repeats on every row. The input's own word, `visits flowers of`, is what Beeline would send in a Darwin Core archive (bead 8dx9.3 records that GloBI maps it to `RO_0002622`, while `hasHost` maps to a parasite relationship). So the one choice in this upload that is a judgement, and not a copy, is the relationship; it is made once, on the form.

### A specimen with no observation

It gets no row. All 4,109 such specimens are trap or net samples without an observation: 2,037 blue vane trap, 1,806 vane trap, 201 net and 65 pan trap. Every one of the 25,845 aerial net specimens has an observation. In the specimen upload these specimens keep a `relationshipOfResource` of blank and an `associationType` of `Occurrence - External Link`, which have no effect once the association upload is a separate file. No specimen has a plant name without an observation (0 rows).

### A specimen whose host is not a species

Its row exists, with the observation's `objectID` and `resourceUrl`, and `verbatimSciname` blank. There are 8,191 of these (31.7% of the rows):

- 5,942 have a host named only to genus (the host's rank is genus on 5,701, and complex, section, subgenus or subsection on the rest). This is the case bead 8dx9.5 told Joel about. The sheet says the genus should be used; it is not.
- 2,249 have no genus at all: the host is named only to tribe, subtribe, family, subfamily, order, class or kingdom, or has no rank (1,434 with no rank recorded in the input).

In the DwC-A archive Beeline sends the host as it holds it, which can be a genus or a higher name, as `"visits flowers of":"<genus or higher name>"` in `associatedTaxa`, so doing what Joel's sheet says costs nothing there.

### Which identifier links it to the specimen

Both are in the file: `catalogNumber` and `occurrenceID`. The importer test (C2) matched association rows "by catalogNumber/occurrenceID/otherCatalogNumbers". Reading the code (READ, `OccurrenceImport.php`, `getOccurrencePK`, lines 364 to 383), a row matches a record in the collection if any one of the supplied identifiers matches (the conditions are joined with OR), and a row that matches nothing is skipped with a message. So `catalogNumber` alone is enough, the download-and-paste of `occurrenceID` is not needed, and supplying both only adds a second way to match. For Beeline's file the catalog number is the identifier to write; the occurrenceID column can be dropped, which removes the "upload, download, then fill in" step (bead 8dx9.4).

### Does the file match the page's expected columns

As far as the test's results describe them, yes, and the source confirms it. The page's mapping form offers these targets (READ, `OccurrenceImport.php`, `setTargetFieldArr`): `subject identifier: catalogNumber`, `subject identifier: otherCatalogNumbers`, `subject identifier: occurrenceID`, `subject identifier: occid`, then `relationshipID`, `objectID`, `basisOfRecord`, `establishedDate`, `notes`, `accordingTo`, and for the External Link type also `verbatimSciname` and `resourceUrl`. Joel's seven headers are exactly seven of these labels, character for character, so they auto-map. The test ran the page with a `resourceUrl` row and, separately, a `verbatimSciname` row (as an observational association). It did not run one file with both `resourceUrl` and `verbatimSciname` on the External Link type, which is what Joel uploads, and it did not use `objectID` or `notes`. The source offers `verbatimSciname` on that type, so I expect it to work, but that is READ, not measured.

Two behaviours of the page matter for a file Beeline writes (MEASURED IN THE TEST, C2): running the same file again without the "replace matching" box ticked rejects each row as a duplicate and adds nothing; with it ticked, a row is updated in place, matched by `objectID` or `resourceUrl`. Joel's file therefore can be re-run safely.

## 4. Which rows are in the upload

- **The specimen upload holds every row of the input.** 29,954 of 29,954, matched by label number, in the same order, with nothing added and nothing removed. It includes the 4,109 trap and net specimens that have no observation. Nothing filters on printed or settled state in the file itself.
- **The associations upload holds only the 25,845 with an observation.** The rest have no row.
- **No identification is in either file.** The input has columns for the volunteer's determination (`scientificName`, `family`, `genus`, `taxonRank`, `identifiedBy`, `sex`, `caste` and the `...VolDet` set) and all are empty on all 29,954 rows. The specimen upload has no column for any of them. This agrees with bead 8dx9.6: the input is old Beeline's export saved on 2025-12-19, before any 2025 determination existed.
- **No sex or caste is in either file.** Both are empty in the input and have no column in the upload.
- **What this means for the upload.** The importer test's second run (section D of [symbiota-import-test-2026-11-20.md](symbiota-import-test-2026-11-20.md)) settled this. A spreadsheet upload that matches an existing record empties every column the file lacks and every blank cell, and rewrites the record's current determination in place: a file with no name columns, which is what Joel's is, turned an expert's current determination into "undetermined" by "unknown" (test D2a). A file that holds only catalog numbers new to Ecdysis changed nothing else (test D3). So Joel's file is safe only for specimens that are new to Ecdysis (question 4 asks whether he ever uploads it again), and the file Beeline writes must hold new records only.

## 5. Open questions only Joel can answer

1. Is the file you upload the sheet as it is, or a CSV you save from it, and with what text encoding?
2. When you upload the specimen sheet, which of its columns do you leave unmapped (the relationship, association type, `relatedResourceID`, `relationshipRemarks`, `url` and `georeferenceSource` columns have no Symbiota column of the same name)?
3. Does a field number such as 1.10 stay 1.10 when you upload, or does Ecdysis show 1.1, so that specimen 1 and specimen 10 of a sample look alike?
4. Do you ever upload the specimen sheet again for specimens that are already in Ecdysis, or only for new catalog numbers?
5. On the "Import extended data" page, which association type and relationship do you pick, and do you run the file once or once per type?
6. Why do you write "host" and not "visits flowers of" in `associatedTaxa`, and what drops the quotation marks if you do not replace them with QUOTE?
7. How do you decide that a point is inside a city, outside every city, or in a named park, and where do you look up the nearest town?
8. Do you change any record in Ecdysis after the upload, other than replacing QUOTE with a quotation mark?
9. Does Ecdysis expand "USA" and "WA" by itself (Symbiota has a geographic thesaurus that converts such codes during an upload), or do you spell them out because it does not?
10. Where does the habitat "herb garden" on the 52 rows come from, and do you add other habitats to other files?
11. Do you use the observation's UUID in `objectID` for anything, or would the observation's numeric id, which Beeline holds, serve?
