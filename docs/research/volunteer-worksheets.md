# Volunteer determination worksheets: what the Drive folder holds

Read 2026-10-01 (Peter, with Claude), from an export of the shared Drive folder the
program kept volunteers' determination sheets in, joined to the legacy corpus fetched
2026-09-28. The loader is [src/load-worksheets.ts](../../src/load-worksheets.ts); this
note is what it was built against. Counts are of rows unless they say otherwise, and no
volunteer is named here: the folder is a list of people, and its export lives in the
gitignored `data/worksheets/`.

## The workflow it records

For the 2025 season the official way to determine your own specimens was a copy of a
Google Sheet: a tab called *USE THIS SHEET* with five headings — OBA Number, Sex/Caste,
Family, Genus, Species — and four tabs behind it that feed the last four as dropdowns
(sex/caste is one of male, female, worker, queen, drone; six bee families; about sixty
genera; each genus's species). The number column has no validation. Staff were to
transcribe the finished sheets into the old database's `*VolDet` columns.

## Mostly, the transcription never happened

The folder holds 237 files: 233 Google Sheets, three uploaded `.xlsx` (one of them an
OpenDocument file with the wrong extension), and a zip of two more. 118 are untouched
copies of the template. The rest hold 22,013 rows with a label number and a name, on
19,884 distinct specimens.

| Where the specimen stands in the corpus | Rows |
| --- | ---: |
| No determination of any kind | 18,855 |
| An expert determination only | 1,330 |
| A volunteer determination already (almost all 2026 collections) | 1,682 |
| No specimen with that number | 146 |

Split by season, the first line is 18,704 rows from settled seasons and 151 from the open
one: the sheets are the only record of a season's volunteer determinations. Of the
1,682 already transcribed, 1,523 agree with the sheet on genus and species and 159 do not.

## The names are clean; the numbers are not

The dropdowns did their job. 15,600 rows stop at the genus, 6,369 give an epithet, and
fewer than fifty are anything else: an either-or (`flavifrons/centralis`), a capitalised
epithet, a stray number. The template's genus list carries two subgenera in its genus
cells, `Epimelissodes (Svastra)` and `Xenoglossa (Peponapis)`, which the curated tree
holds as subgenus nodes.

The numbers were typed. 204 rows land on a specimen whose collector is not the file's
main collector. Some are plain slips — `25027229` in a run of `2507272x` — and some are a
person determining a run of somebody else's specimens, which is legitimate. Another 146
name no specimen at all, 58 of them one block in one file.

## A file does not say who determined it

A file's title usually names a person, and usually 98–100% of its specimens belong to
one collector. But households share a sheet, helpers determine for others, and the
*Vol Set N* files are copies made by staff for whoever asked. Drive's last-modifying
user is the staff member who made the copy in 90 of the files. The determiner is
therefore a decision per file, made by a person.

## Files are versions of each other

Volunteers copied a sheet under a new name and kept working, so one specimen can stand in
several files. Three files share 385 specimens; others are titled as test copies or as
broken. Where two versions disagree it reads as revision — 61 rows go from a genus to a
species (*Bombus* to *B. centralis*), 113 change genus (specimen `25035362` is
*Lasioglossum* in one copy and *Halictus confusus* in another), 64 drop a species, 57
change only the sex or caste — but nothing in the files says which copy is the revision
(see below). Within one file, 70 numbers appear twice with different content.

## What the loader does with it

Decided with Peter on 2026-10-01:

- **Who** is decided per file in a manifest (`data/worksheet-files.csv`), with the
  collector of most of the file's specimens proposed. Nothing loads from an undecided file.
- **Which version**: copies that agree are one entry; copies that disagree are held,
  naming each other, until somebody marks the stale one `skip`. The first version took
  the most recently modified file and got the example above backwards: the copy
  modified last (in January) was created first (in July) and still says
  *Lasioglossum*. Creation time orders that pair correctly and contradicts modification
  time on three of the twelve pairs that disagree, so neither is a rule.
- **Stray numbers** are held and listed, with the numbers either side of them in the
  sheet, unless the file is marked as somebody determining for others.

## Measured on a reseeded copy of the dev store

With every proposed determiner accepted, as a stand-in for curation: 22,027 determined
rows in the files that load, of which 17,670 would be recorded (17,408 from settled
seasons, 262 from the open one) and 1,545 are already in the store. 1,163 are held — 459
because two copies disagree (eight pairs of files), 277 on a specimen the determiner did
not collect, 272 on no specimen, 147 because rows in one file disagree, and 8 names the
tree does not hold. The whole folder reads in about 26 seconds.

Two things about the files only showed up by comparing two readers. DuckDB's
`read_xlsx` stops at the first empty row and starts at the first column with a value in
row 1 unless given a range: without one it read one row of a 92-row sheet and 232 of a
576-row one. And one sheet has `250` typed over its Genus heading, so its genera are read
from the template's column D.

About 8,700 rows carry a number and nothing else: numbers filled in ahead and never
determined. The sheets record no date of determination; Drive's modification time is
the only clock, and an upper bound.
