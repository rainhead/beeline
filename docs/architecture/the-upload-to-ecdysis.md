# The upload to Ecdysis

Part of Beeline's architecture notes; the index is [README.md](README.md).

`src/app/ecdysis-upload.ts` (beeline-8dx9.12) writes the two files a person uploads to Ecdysis by hand, one Ecdysis collection at a time (`ECDYSIS_COLLECTIONS`: Washington's dataset 44 for the program WaBA, and British Columbia's collection 196 for BC). The page is the last section of `/exports` (`src/app/views/exports.tsx`) and the files are served from `/exports/ecdysis/<program>-<year>-upload.zip` and `…-associations.csv`; staff administrators only, as the page is. The plan behind them is [publishing-to-ecdysis-and-gbif.md](../research/publishing-to-ecdysis-and-gbif.md), what Symbiota does with them is measured in [symbiota-import-test-2026-11-20.md](../research/symbiota-import-test-2026-11-20.md), and the two files Joel Gardner made by hand before are specified in [ecdysis-upload-files.md](../research/ecdysis-upload-files.md).

These are not the program archives (`src/app/dwc-archive.ts`, written nightly, never uploaded anywhere). They share that file's stream and its cell functions (`csvCellsOf` reads the staff download's cells by name; `specimenArchiveStream` takes an `ArchiveLayout`, which is the program archives' by default), and they have a column list of their own.

## Which specimens, and when

A file for a collection and a collection year (the calendar year of a sample's first day, as the program archives count) holds the specimens that

1. belong to the collection's program, by the scope `programArchives` gives it;
2. have a label on paper (`specimen_on_paper`, through the listing's own `labels=printed`) and a label number;
3. are not marked missing (`specimen_disposition`);
4. have no row in `specimen_catalog_number` (the listing's `ecdysis=not`), **and** whose would-be catalog number, the collection's prefix and the label number, is not in the archive Beeline last downloaded from Ecdysis;
5. have no obscured taxon (`nullif(sample.taxon_geoprivacy, 'open') IS NOT NULL`), because their program has not said whether true coordinates may leave Beeline (beeline-1kb.7.1). These are counted on the page and left out. Everything else is written as a staff reader sees it, with true coordinates, as the program archives are.

The fourth rule has two parts because the store keeps only the Ecdysis records the loader matched to a specimen: `specimen_catalog_number` holds those, and the loader counts the rest and keeps five as a sample (`unmatchedSample`). A record Ecdysis holds that Beeline could not match, say because its label number is on two specimens (beeline-1kb.14), would look new, and uploading its catalog number again would make Symbiota replace that record whole. So `catalogNumbersInArchive` reads every catalog number out of the cached archive file the nightly read keeps (`cachedArchivePath`, `data/ecdysis/44.zip`), with DuckDB as the loader reads it, comparing without regard to case because Symbiota's column does (`utf8_general_ci`). It unpacks the occurrences file into a folder of its own under `BEELINE_ECDYSIS`, which the app's store is allowed to read (`storeFiles`; `test/store-file-limit.test.ts` runs it under that limit), and removes it. The answer is kept in memory while the zip's size and time stay the same.

What is not known from either source: a record that is in Ecdysis but outside the dataset (Washington's dataset 44 is a subset of WSU's collection 164). Symbiota matches on catalog number across the whole collection, so such a record would be replaced as well. Nothing in Beeline reads that part of the collection.

Two more specimens are left out and counted as "unusable label number": one whose label number is on another specimen (two records would then share a catalog number, and Symbiota's own importer would make both), and one whose catalog number is longer than Symbiota's 32-character column (beeline-hicv). A specimen with no label number is left out without a count.

The selection takes the Specimens listing's own filters from the query string (`parseListingQuery`, as the Excel download does) and applies them with the listing's `filteredSpecimens`. The listing's scope, labels and Ecdysis filters are replaced, since they are the rules and not choices. The page counts the whole year; a person narrows a file by adding filters to its address.

## When a file may be built

No file is written, and the page and the route say so in plain words, unless the last read of Ecdysis for the collection is under 36 hours old and the archive it loaded is still on disk (`ecdysisRead`). The source is the `ecdysis-fetch` job's history (`job_run`), by the run's start time, because:

- the cached archive's file time and the probe baseline are rewritten only when an archive is downloaded, so on a quiet week they are a week old while every night's read succeeded;
- `specimen_catalog_number.loaded_at` is rewritten for every matched specimen at each load, so it would do on a normal night, but it is also written by a person loading an old export by hand with `pnpm ecdysis:load`, which proves a load and not a fresh read, and a collection none of whose records matched has no row to read it from.

A run counts for a collection when its detail names that collection as downloaded or reloaded (`detailSaysRead`, which parses what `describeFetch` writes, and is tested against it), so a night on which British Columbia failed still counts for Washington. A run that failed before it read the collection, or found no login, counts for nothing. Thirty-six hours is one missed night and a little over: the job runs at 3am Pacific, and Symbiota replaces a record it matches whole, so a file made from a read two nights old could overwrite a record someone added since.

## The archive's columns

`occurrence.txt` and `meta.xml` declare each column under the term Symbiota maps. Every term was checked three ways: Symbiota's source (`SpecUploadDwca.php` 273-276 takes the last part of a term's address as the header; `SpecUploadBase.php` `echoFieldMapTable`, 344-440, lower-cases it, drops `_ . ( )` and spaces, applies a small translation map, and maps it where `uploadspectemp` has a column of that name), the importer's own mapping page (auto-mapped with no change by hand), and a live import (the stored value in the named column equals the archive's cell, for every cell of 31 records). Constants are real columns because whether Symbiota honours a `default` in `meta.xml` is untested. There is no `occurrenceID`: Washington's collection ignores an uploaded one (test B2). The `id` of each row is the specimen's `entity_id`; Symbiota keeps it in `dbpk` only for a record it inserts.

| Column | Term | Lands in `omoccurrences` | How it is known |
|---|---|---|---|
| `catalogNumber` | `dwc:catalogNumber` | `catalogNumber` (varchar 32) | Auto-mapped. Prefix and label number. The key a live-managed collection matches on (SUB 612-625) |
| `basisOfRecord` | `dwc:basisOfRecord` | `basisOfRecord` | Auto-mapped. `PreservedSpecimen` |
| `fieldNumber` | `dwc:fieldNumber` | `fieldNumber` | Auto-mapped. The sample's number |
| `recordNumber` | `dwc:recordNumber` | `recordNumber` | Auto-mapped. `<sample>.<specimen>` as text, so 1.10 stays 1.10 |
| `eventDate` | `dwc:eventDate` | `eventDate`, `year`, `month`, `day`, `startDayOfYear` | Auto-mapped. The first day only: Symbiota keeps only the start of a range (test C1) |
| `eventDate2` | `https://symbiota.org/terms/eventDate2` | `eventDate2`, `endDayOfYear` | Auto-mapped. The last day, only for a range; the day is then not set (test C1, and the live import) |
| `samplingProtocol` | `dwc:samplingProtocol` | `samplingProtocol` | Auto-mapped |
| `recordedBy` | `dwc:recordedBy` | `recordedBy` | Auto-mapped. Collectors joined by ` \| `, as the program archive writes them |
| `country`, `stateProvince` | `dwc:country`, `dwc:stateProvince` | `country`, `stateProvince` | Auto-mapped. Spelled out from `COUNTRY_NAMES` and `STATE_NAMES` (USA, CAN; WA, BC); any other value is written as the store has it and listed on the page. Symbiota then fills `countryCode` and `continent` itself |
| `county`, `locality` | `dwc:county`, `dwc:locality` | `county`, `locality` | Auto-mapped. The label's text |
| `verbatimCoordinates` | `dwc:verbatimCoordinates` | `verbatimCoordinates` (varchar 255) | Auto-mapped. The label's locality again: Ecdysis has no verbatimLocality, so Washington keeps it here |
| `decimalLatitude`, `decimalLongitude`, `geodeticDatum`, `coordinateUncertaintyInMeters`, `minimumElevationInMeters` | the `dwc:` terms | the same names | Auto-mapped. `geodeticDatum` is `WGS84` where there is a point |
| `lifeStage`, `preparations`, `individualCount` | the `dwc:` terms | the same names | Auto-mapped. `adult`, `pinned`, `1` |
| `associatedTaxa` | `dwc:associatedTaxa` | `associatedTaxa` | Auto-mapped. As the program archive writes it: the relationship word from `plantRelationship`, the host at whatever rank Beeline holds |
| `disposition`, `occurrenceRemarks` | the `dwc:` terms | the same names | Auto-mapped. Symbiota straightens curly quotes, collapses runs of spaces, deletes emoji and cuts `disposition` at 250 characters (test C3) |
| `scientificName` | `dwc:scientificName` | `sciname` | Mapped through the translation map `scientificname` to `sciname` ("excluding author") |
| `scientificNameAuthorship`, `identificationQualifier`, `identifiedBy`, `dateIdentified` | the `dwc:` terms | the same names | Auto-mapped |
| `sex` | `dwc:sex` | `sex` | Auto-mapped. Symbiota reads sex from the occurrence row only |
| `reproductiveCondition` | `dwc:reproductiveCondition` | `reproductiveCondition` | Auto-mapped. Holds the caste: Symbiota has no caste column anywhere, and British Columbia already keeps it here |

The last seven rows' cells (name, authorship, qualifier, determiner, date, sex, caste) are filled only where the determination of record is an expert's. Where it is a volunteer's, or there is none, they are empty and the record is created with no name, so that Ecdysis's own experts name it (Peter, 2026-11-20). The determination of record is the newest expert's, else the newest volunteer's (`determination_of_record`).

## The identifications

`identification.txt` holds every determination of every specimen in the file, as history, with `https://symbiota.org/terms/identificationIsCurrent` 1 only on the determination of record when it is an expert's and 0 on every other, so a specimen with only volunteers' determinations has history and no current name (test A5). Its columns map as follows: `scientificName` to `sciname`; `scientificNameAuthorship`, `identificationQualifier`, `identifiedBy`, `dateIdentified` by name; `identificationIsCurrent` to `iscurrent` (translation map, SUB 389); and `sourceIdentifier`.

Symbiota's unique key on a determination is (record, `dateIdentified`, `identifiedBy`, `sciname`), and it keeps only the first of two rows that agree on all four, whatever their flags (test A6). `uploadIdentificationRows` therefore writes determinations of one specimen that have the same name, determiner and date (or lack of one) as one row, current if any of them is, with the current one's other cells; the comparison ignores case, as the column does. Two determinations that agree in everything but the qualifier or the sex are therefore written as one, and the later detail is lost in Ecdysis.

`sourceIdentifier` is the determination's own `entity_id`. Symbiota's importer maps the header `sourceIdentifier` to the column of that name (SUB 1405-1418): a determination already on the record with the same one is updated in place instead of added again, so loading the same file twice duplicates nothing. Darwin Core's own `identificationID` would be the right term, but the importer has no mapping for it. Patch 3.1 of Symbiota's schema marks the column "deprecated" and copies it to `instanceID`; this importer still reads and writes it, and a later Symbiota that dropped it would leave the header unmapped, which is harmless.

## The associations file

`associationsCsv` writes one row for each specimen in the file whose sample has an iNaturalist observation that still exists (`observationGone` is left out: no page to send anyone to), with exactly `subject identifier: catalogNumber`, `resourceUrl` (`https://www.inaturalist.org/observations/<id>`) and `verbatimSciname` (the host as the observation named it, at the rank Beeline holds, empty where there is none): the headers Symbiota's "Import extended data" maps for an external link (`OccurrenceImport.php` 440-485). It has no `objectID`, so Symbiota's export shows the observation's address as the related resource, which GloBI recognises, and no `occurrenceID`, so the subject is found by catalog number alone, in one round of uploads. UTF-8, quoted by RFC 4180, with no byte order mark and no formula guard: the program's CSV downloads have both for spreadsheets, but this file is read by Symbiota, which loaded it the same with and without a mark, and a guard would write an apostrophe into a name that begins with `-`, `=`, `+` or `@`. A person loads it with the association type "Occurrence - External Link" and the relationship "hasHost", the only fitting choice the page offers today ("visits flowers of", which GloBI reads as a flower visit, is not on its list).

## What a person is told, and why

The page (`m.exports.ecdysis`) says: upload the archive once, on the day it is downloaded, and delete it after, because uploading it again later would replace identifications made in Ecdysis since (Symbiota overwrites a matched record whole and never compares dates; tests A7, B3); switch on "Match on Catalog Number" and "Import Identification History" (the defaults make a second record for every catalog number); then load the associations file. The nightly read is also what keeps the next file honest: once Ecdysis holds a specimen, the next file leaves it out.

The file names carry the collection, the year and the Pacific date and time written (`uploadFileName`), so an old one is recognised and thrown away.

## Verified against a real Symbiota (2026-11-20)

A synthetic store of invented people and places (32 specimens in the file: an expert's determination of record, volunteers' only, none, two identical undated determinations, a trap sample with a range of dates, a host at genus and at family rank, no observation, a disposition and remark, quotes, semicolons, an accent) was imported through Symbiota's own upload pages into a live-managed collection that already held four other records. Every cell of every record landed in the column above. The four earlier records were byte-for-byte unchanged afterwards (hashed). Names and current flags were as specified, and the end date was in `eventDate2` with `endDayOfYear`. A second import of the same archive duplicated nothing and changed no value, but it moved every record's `dateLastModified`: Symbiota's update first blanks `countryCode` and `continent`, then fills them again (the general query log shows both statements), and the blanking is a change to the row. The 29 associations loaded through "Import extended data". Symbiota's own Darwin Core export then showed the record, its identifications and the association. The scripts are not kept in the repository.
