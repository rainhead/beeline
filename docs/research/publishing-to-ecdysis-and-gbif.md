# Publishing to Ecdysis and GBIF: a plan

Written 2026-11-20 (Peter, with Claude), before the taxonomist meeting of that day. This
is a plan, not a record of what is built. Each part says whether it is **decided**,
**proposed** (waiting for Peter or the meeting), or **waiting on a test**. The work is
tracked under the epic beeline-8dx9.

## The two routes

A specimen record leaves Beeline for GBIF by one of two routes, and the two need
different files.

| Route | Programs | Who reads Beeline's file | Where identifications are entered |
|---|---|---|---|
| Ecdysis | Washington (WSDA_, dataset 44), British Columbia (BCBA_, collection 196) | Symbiota's archive import, run on a schedule by whoever runs Ecdysis | Ecdysis and Beeline, both |
| OSAC's IPT | Oregon | GBIF's Integrated Publishing Toolkit, which OSAC runs | Beeline, and taxonomists' own sheets |

Which route New Mexico, Idaho and the other programs take is not known.

Today both routes are worked by hand. Joel Gardner rewrites the old Beeline's export in
a spreadsheet and uploads it to Ecdysis; Lincoln Best chooses which Oregon rows to
upload. Each hand also filters: for the embargo, for which volunteer identifications go
out, and for records that should not go at all. A file that flows on a schedule has no
such hand, so each filter has to become a rule in Beeline before the schedule starts.

## The files

There are three outputs, and the plan keeps them apart.

1. **The staff download** (the specimens CSV and Excel file on `/specimens`). For people.
   It carries the columns that let an edited copy be loaded back. Unchanged by this
   plan, except where a column function it shares with the archives changes (the datum).
2. **The program archive** (`src/app/dwc-archive.ts`, written nightly per program and
   year, and one of every year together). It becomes the file a program publishes
   through an IPT. Oregon is its first reader.
3. **The harvest archive**, new: one per Ecdysis collection, served at a URL that
   Ecdysis fetches. It carries only what Ecdysis should take from Beeline.

The two archives are built from the same row and the same column functions, each with
its own list of columns. Today `SPECIMEN_DWC_COLUMNS` in `src/app/listings.ts` serves
the download and the archive at once; the archives get their own lists so that a change
for Ecdysis does not move a column in a file people load back.

## Part 1: sex and caste belong to an identification (decided)

Peter, 2026-11-20. So:

- `identification.txt` declares its sex and caste columns (`dwc:sex`, `dwc:caste`)
  instead of writing them undeclared.
- The occurrence row of both archives writes `dwc:caste` from the determination of
  record, beside `sex`. The comment in `dwc-archive.ts` saying caste has no term is out
  of date: Darwin Core has had `caste` since 2023.
- Whether Symbiota reads either from an identification is in the test (question A8).
  If it reads them only from the occurrence, the harvest writes the determination of
  record's there, and they are fields Beeline sends with the identification, not
  separately owned ones.

## Part 2: the numbers follow Darwin Core (decided 2026-11-18, archives only)

| Term | Today | Planned |
|---|---|---|
| `fieldNumber` | the label number | the sample's number |
| `recordNumber` | absent | the specimen within the sample, as Joel writes it (`sample.specimen`) |
| `catalogNumber` | what Ecdysis reported, else empty | what Ecdysis reported; else the collection's prefix and the label number, for a program with a prefix |

This applies to the two archives. The staff download keeps `fieldNumber` as the label
number for now, because the loader of edited downloads and the API read that column;
changing those is a separate decision.

Not settled: the prefixes for Washington and New Mexico are unconfirmed as something
Beeline assigns (beeline-gu0l). The harvest needs `WSDA_` whatever that decision is,
because Ecdysis's existing records are matched on it. Twelve old catalog numbers are
longer than Symbiota's 32 characters (beeline-hicv) and one repeats (beeline-1kb.14);
the harvest leaves those specimens out and lists them, until they are repaired.

## Part 3: every published specimen has one permanent occurrenceID (decided)

Peter approved this on 2026-11-20. It is the plan in beeline-8dx9.4. It reverses ADR
0008's second amendment, so it needs a third, written and reviewed before any code.

1. **Keep the identifier a specimen was already published under.** Read it from
   Ecdysis (Washington: the record's UUID, 46,090 of 46,090 measured) and from OSAC for
   Oregon (beeline-1kb.22), and store it. This is beeline-9ut.8, in progress. British
   Columbia's published identifiers are only catalog numbers; what to do with those is
   Peter's question to BC.
2. **Mint one for every other printed specimen**, once, as a UUID, when its field
   number is frozen at the print run. A specimen already printed with none gets one in
   a single repair. These rows cannot be undone, so the repair gets an independent
   review and a check against a copy of production first.
3. **The archive's row id becomes the occurrenceID.** Symbiota matches a re-upload on
   the row id by default, so this makes its match an occurrenceID match. Records Joel
   already uploaded have some other row id, so the first harvest matches them on
   catalog number (test B1).

What every taxonomist and collection manager needs to hear: the occurrenceID is the
record's name everywhere, for good. Nobody replaces one, drops one, or lets a re-upload
mint another. In Ecdysis this depends on one collection setting (the GUID source),
which decides whether the identifier Beeline sends is kept and published.

## Part 4: the harvest archive (waiting on the test, and on the meeting)

### What it carries

Fields Beeline owns, which a harvest may overwrite in Ecdysis:

- the identifiers of Part 2 and Part 3;
- the collecting data: date, collectors, locality, coordinates, elevation, method;
- the host plant, as `associatedTaxa` and as an association to the iNaturalist
  observation (beeline-8dx9.3). The relationship is "visits flowers of", which GloBI
  reads as a flower visit; "host", which Joel writes, GloBI reads as a parasite's host;
- the disposition and the occurrence remarks;
- the fixed values Joel writes (beeline-8dx9.1): the country and state spelled out,
  life stage adult, preparations pinned, individual count 1;
- the end of a date range in the column Symbiota reads it from (test C1).

Fields it does not carry: anything Ecdysis's users maintain that Beeline does not hold,
such as storage location and loans.

### Identifications

Peter, 2026-11-20: identifications are entered in both systems. Parataxonomists will
enter theirs in Beeline, and for an atlas such as Idaho it is too great a burden for
those to pass through a taxonomist's spreadsheet first.

- **Every determination goes to Ecdysis as history**, volunteers' included (proposed).
- **Which one is current follows Beeline's rule**: the newest expert determination,
  else the newest volunteer one. A parataxonomist's determination is an expert's.
- **Open, for the meeting:** whether a volunteer's determination is ever the current
  one in Ecdysis, or the record stays undetermined there until an expert names it.
- **Each harvest follows a fresh read of Ecdysis.** A taxonomist's new identification
  in Ecdysis has to reach Beeline before Beeline next says which is current, or the
  harvest could put an older name back. The nightly job runs the read first and writes
  the harvest archive only if the read succeeded.
- A taxonomist sees a parataxonomist's determination in both places (Peter).

Two things in Beeline's own rule matter more once it decides the current name in
Ecdysis, and should be said at the meeting:

- "Newest" changes meaning (Peter, 2026-11-20): by the date the determiner gave, and
  then by when Beeline recorded the determination. Today `determination_of_record`
  (`schema/110`) orders by the recorded time alone, so an old determination loaded
  late outranks a newer one loaded earlier, and Symbiota, which shows
  `dateIdentified`, would disagree with Beeline. To settle in the design: where a
  determination with no date stands against one with a date. Proposed: an undated one
  counts as made on the day it arrived. This changes the name of record for some
  specimens, so it is measured on a copy of production, split by season, before it
  is built (beeline-8dx9.9).
- Repeated identifications with the same name, determiner and no date collapsed in
  Symbiota's import in October, and left 1,077 specimens with no current name
  (beeline-1o27). The harvest must send each identification so that it stays distinct
  (test A6).

### Rules that replace the hand filters

Each of these must exist before a collection's harvest URL does.

| Filter today | Rule needed | State |
|---|---|---|
| Coordinates of a record whose taxon is obscured | A setting per program: send true coordinates, send obscured ones, or leave the record out | Unanswered by the atlases (beeline-1kb.7.1). Until a program answers, its harvest leaves these records out. |
| The publication embargo | A grant over records with an end date; an embargoed record is left out | Not modelled (beeline-bqvp) |
| A label that never met a bee | Send with its disposition, or leave out | For the meeting. Proposed: send, with the disposition, because the record must exist in Ecdysis for an expert to identify it. |

### How Ecdysis fetches it

Symbiota fetches an archive from a URL with no headers, so the URL carries a long
random secret per collection. It is fetched from cron on the portal, so whoever runs
Ecdysis has to schedule it. Washington's records are part of WSU's collection, which
other specimens share, so the collection must be live-managed with matching on catalog
number: a snapshot harvest would replace the whole collection. A harvest does not add
new records to dataset 44, which is how Beeline finds Washington's records today, so
Beeline should read the collection by catalog prefix instead.

## Part 5: the program archive, for an IPT (proposed)

From the checks against GBIF's own reader in October (beeline-ob9q, beeline-t54r):

- `geodeticDatum` is `WGS84` for every point, in place of `unknown` for imported ones.
  GBIF rejects `unknown` and assumes WGS84; the points came from iNaturalist or a phone.
- The higher classification (kingdom to family, and genus) is written from Beeline's
  own tree, so GBIF can place a genus or a rank it does not use.
- Repeated undated identifications are merged, as in Part 4.
- A specimen nobody has identified has no name. To decide: leave it out of a published
  archive, or publish it under a higher name. Decided (Peter, 2026-11-20): leave it
  out. The harvest to Ecdysis is different: there the record must exist before an
  expert can name it.
- No `eml.xml`: the IPT writes its own.
- One dataset per program that grows, which is the archive of every year together.

Three things only Lincoln Best can say: how a file reaches OSAC's IPT today, whether
the IPT can fetch one from a URL, and whether Oregon's earlier yearly datasets on GBIF
will be retired (their 35,725 records are also in the cumulative one).

## Part 6: a collector marks their own specimen as lost (proposed, beeline-n9yl)

The collector is the first to know. `specimen_disposition` already holds `missing` and
a remark, written today only from a staff inventory. To design: the reasons offered
(lost, destroyed, never existed because the count was wrong), whether the collector can
undo it, and how it appears to staff. It follows the rule that every change is an
event that can be seen.

## Part 7: parataxonomists (proposed, beeline-2g1c)

A badge on the person. No rule separates a parataxonomist's determination from a
taxonomist's: both are expert. To find out before designing: how a determination
entered in Beeline by an expert is marked as an expert's today, since CONTEXT.md still
lists as open whether experts determine in Beeline at all.

## Order of work

| Step | What | Waits on |
|---|---|---|
| 1 | Part 1 (sex and caste), Part 5's datum and classification, the archives' own column lists | nothing |
| 2 | Part 2 (numbers) | nothing for the archives |
| 3 | Part 3 (occurrenceID): store the published ones, then mint | the ADR 0008 amendment and its review |
| 3a | The determination of record goes by the determiner's date, then the date of arrival | a measurement on a copy of production |
| 4 | Part 6 and Part 7 | a short design each |
| 5 | Part 4 (the harvest archive), without a URL | the Symbiota test; step 3 |
| 6 | The rules that replace the hand filters, then a URL for one collection | the meeting; Joel and Ecdysis's operators |

## What the Symbiota test found (2026-11-20)

Run against a local Symbiota (commit 4491b791c, MariaDB) with invented records, through
its real upload pages. The full tables, with the source lines, are in
[symbiota-import-test-2026-11-20.md](symbiota-import-test-2026-11-20.md). Five results
contradict Part 3 and Part 4 as written above, which have not been revised yet: the
revision is a design choice for Peter (see "Choices the test forces").

1. **An archive import overwrites the whole record.** For a record it matches, Symbiota
   writes every column, and a column the archive lacks, or leaves blank, becomes empty.
   An archive holding only an id and a catalog number emptied about thirty fields. So
   "send only the fields Beeline owns" does not exist as an option: whatever the
   archive leaves out is erased, including anything Ecdysis's users entered.
2. **The record's name always comes from the archive's occurrence row.** Symbiota
   compares no dates. If the row carries a name, that name replaces the record's; if it
   carries none, the record's name is emptied. An archive written before Beeline has
   read a taxonomist's new identification puts the older name back (measured).
3. **The import never clears the old current flag.** After an incoming current
   identification, both the old and the new are marked current. Only Symbiota's own
   editor clears the old one.
4. **A live-managed collection matches on catalog number only.** The archive's row id
   is not stored on a matched record and is never used to match in such a collection,
   so making the row id the occurrenceID gains nothing there. Without catalog-number
   matching switched on, the import made a second record.
5. **The archive import builds no associations.** The host plant and the iNaturalist
   observation go in through a separate admin page ("Import extended data"), matched by
   catalog number, which is what Joel does by hand. Symbiota's own export then writes
   them in a `resourceRelationships` file, with the relationship as it was loaded.

Results that fit the plan:

- With the collection's GUID source set to occurrenceID, an incoming occurrenceID is
  stored and published, and an existing one is kept when the archive sends none. An
  incoming one that differs replaces it, so Beeline must send the published one.
- Identifications stay distinct if they differ in date or determiner. Two with the
  same name and determiner and no date collapse to the first in the file, whatever
  their flags. A source identifier on each identification makes a re-import update it
  in place.
- A volunteer's identification sent as not current, to a record with no other, leaves
  the record with no name and only a determination history.
- An unchanged re-import changes nothing and bumps no modified date.
- An end date survives in a column named `eventDate2`.
- Sex is read from the occurrence row only. Symbiota has no caste column.
- A scheduled fetch from a URL works unattended. Its switches (match on catalog
  number, load identifications) are arguments to the cron command, not part of the
  saved profile, and the defaults make duplicate records. It exits 0 when the fetch
  fails.

## Choices the test forces

Because an import overwrites the whole record, an automated harvest and people editing
the same records in Ecdysis cannot both be safe. The ways out:

- **A. Beeline is the only place these records are edited.** The harvest carries the
  whole record. Identifications made in Ecdysis stop, or are tolerated only between
  Beeline's read and the next harvest. This is the simplest and the least like today.
- **B. The harvest echoes back what Beeline last read from Ecdysis** for every field it
  does not own, and for the current name. An edit made in Ecdysis after Beeline's read
  and before the harvest is lost; the window is the time between the two nightly
  steps.
- **C. The harvest only creates records**, and changes to existing ones go by another
  route (a person, or Symbiota's API, which was not tested). Whether Symbiota can be
  told to skip records it matches was not tested either.
- **D. Stay with a person uploading**, and have Beeline write the exact files Joel
  uploads, so his work becomes two uploads with no spreadsheet editing.

D is available now and removes most of Joel's labour. B is the smallest step to a
schedule but its loss window needs Ecdysis's users to accept it.

### Decided, 2026-11-20

Peter: build D now, and take A against B to the taxonomist meeting.

## What the test of the spreadsheet upload found (2026-11-20)

D means the spreadsheet upload, so it was tested the same way (section D of the
results file).

1. **A spreadsheet upload over an existing record is as destructive as an archive.**
   Columns the file lacks, and blank cells, are emptied. There is no setting that
   skips or protects matched records.
2. **It also rewrites the record's current identification in place.** A file with no
   name columns turned an expert's current identification into "undetermined" by
   "unknown"; a file with a different name overwrote it, leaving no history of the
   earlier one. The "undetermined" identifications by "unknown" on 4,935 of
   Washington's 2025 records in Ecdysis look like this path's work on new records.
3. **A file holding only new catalog numbers changes nothing else.** Every existing
   record and identification was identical before and after (measured with a hash).
   With matching switched off, an existing number makes a second record.
4. **The "skeletal" upload type only fills empty fields.** It never overwrites, so it
   cannot correct a value, but it can add one where there was none.
5. **The associations page offers a fixed list of relationships**, of which only
   `hasHost` and `ecologicallyOccursWith` fit. "visits flowers of" is not offered. The
   server stores a term it is sent by hand, and exports it as given, but a person
   using the page cannot choose it unless Ecdysis's operators add it to the list.
   The page can match a specimen by occurrenceID as well as by catalog number.
6. The occurrenceID, the end date in `eventDate2`, and `associatedTaxa` behave as in
   the archive import.

So the files Beeline writes for a person to upload are:

- **A specimen file of new records only**: specimens whose catalog number Ecdysis has
  not reported. Beeline knows which those are from its nightly read of Ecdysis, and
  must refuse to write the file when that read is stale.
- **An associations file** for the same specimens.
- **Corrections to records already in Ecdysis are not sent by upload.** They are made
  in Ecdysis by a person, from a list Beeline writes (the 43 specimens with obscured
  coordinates, beeline-8dx9.7, are the first such list). A correction to a field that
  is empty in Ecdysis could go by a skeletal upload.

For the meeting or for Joel: whether Ecdysis's operators will add "visits flowers of"
to the relationship list, since `hasHost` reads as a parasite's host in GloBI.

## The upload files Beeline will write (proposed build, 2026-11-20)

Joel's two files are specified column by column in
[ecdysis-upload-files.md](ecdysis-upload-files.md). Beeline's versions differ from his
where his are wrong or where a test showed a better form:

| Matter | Joel's file | Beeline's file |
|---|---|---|
| Rows | every row of old Beeline's export | only specimens Ecdysis has not reported, and only when last night's read of Ecdysis succeeded |
| `fieldNumber` | sample dot specimen, as a number, so 1.10 reads 1.1 (2,257 rows share a value with another specimen) | the sample's number; `recordNumber` holds sample dot specimen as text |
| `associatedTaxa` | `host`, species only; 5,942 genus-only hosts dropped | `visits flowers of`, with the host at whatever rank Beeline holds |
| Association's `objectID` | the observation's UUID, which Beeline does not store | left out: the export then gives the observation's URL as the related resource, which GloBI recognises |
| Association's subject | catalog number and an occurrenceID pasted in from a download | catalog number alone, so one round of uploads, with no download between |
| Relationship | `hasHost`, chosen on the page | the same, until Ecdysis offers "visits flowers of" |
| Format | an OpenDocument sheet | CSV in UTF-8 |

Still done by a person, until the work in beeline-8dx9.2: rewriting a locality as the
park or refuge the point is in, "near" a town, and the municipality. Beeline's Areas
can name the refuge or park; it holds no town boundaries. The first version writes the
label's locality in both `locality` and `verbatimCoordinates`.

What this changes in Part 3: Washington's records sit in WSU's collection, whose
identifiers Symbiota generates, and an uploaded occurrenceID is ignored there. Changing
that setting would affect every WSU record. So for Washington the occurrenceID stays
the one Ecdysis gives, which Beeline reads back; minting applies where Beeline is the
publisher (Oregon through the IPT) and where a collection is the atlas's own (British
Columbia, if it agrees).
