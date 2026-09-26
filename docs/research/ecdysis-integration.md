# Ecdysis: what the exports hold, and how determinations come back

Read 2026-09-26 (Peter, with Claude), from the two Ecdysis exports on production, the
Darwin Core archive the beeatlas pipeline caches, and the Symbiota source. Ecdysis is
a [Symbiota](https://symbiota.org/) deployment; the collections database Washington's
museum (WSUC) keeps its bee records in, and which other atlases use too (Peter,
2026-09-26). Determinations made there reach Beeline as the `ecdysis_import` channel
([CONTEXT.md](../../CONTEXT.md), Determination). The loader is
[src/load-ecdysis.ts](../../src/load-ecdysis.ts); this note is what it was built
against.

## Two export shapes

**A flat occurrence export.** What staff have downloaded from Ecdysis's search page and
uploaded into the old system: one row per occurrence, 98 Darwin Core columns, carrying
the *current* identification only (`scientificName`, `identifiedBy`, `dateIdentified`,
`identificationQualifier`, `identificationRemarks`). The two on production were
uploaded on 2026-02-25 (51,633 rows) and 2026-03-05 (46,091), both for dataset 44,
Washington's. Between them 180 records changed name and 165 changed determiner: the
revision traffic over eight days.

**A Darwin Core archive.** Symbiota's bulk download (`collections/download/downloadhandler.php`,
authenticated, with `identifications=1`) is a ZIP of `occurrences.tab`,
`identifications.tab`, `identifiers.tab`, `meta.xml` and `eml.xml`. The identification
file is the whole history: 87,205 identifications over 46,090 occurrences in the July
2026 archive, one to five per occurrence, exactly one flagged `identificationIsCurrent`
(532 occurrences have none, being undetermined). Each carries its own `recordID` (a
UUID) and `modified`, which is Symbiota's `initialTimeStamp` for the identification:
the moment it was entered. beeatlas downloads this archive nightly with a change probe
against the v2 API ([its ADR 0023](https://github.com/rainhead/beeatlas/blob/main/docs/adr/0023-ecdysis-change-probe.md))
and caches it as `data/.ecdysis_cache/44.zip`.

The archive is the right input. The flat export is accepted because it is what exists
today, and read as one current identification per occurrence.

## What the columns hold

- **`catalogNumber`** is the join: `WSDA_2303966` is Beeline's field number `2303966`
  under the collection's prefix. The July archive matches 44,549 of 46,090 occurrences
  to a specimen on the dev store; the 1,541 that do not are numbers the store has no
  specimen for.
- **`dateIdentified`** is "s.d." (*sine dato*) on 57,008 of 87,205 identifications, a
  bare year on 30,124, a full date on 17, and the word "female" on 56 (a column slip).
  It orders nothing, and it is kept as a year with a precision beside it, never as a
  January 1st.
- **`identifiedBy`** is "unknown" or blank on the placeholder rows and a formal name
  otherwise ("Caleb A. Lankford", "Karen W. Wright", 41 distinct). They resolve through
  [ingest/determiner-aliases.csv](../../ingest/determiner-aliases.csv), the same file
  legacy promotion uses; every one in the July archive did.
- **`scientificName`** resolves against the curated taxonomy by spelling: 527 of the
  530 distinct names in the February export. The archive's history adds bycatch at
  ranks the tree does not yet carry (Chrysididae, Ichneumonoidea, Heteroptera,
  Symphyta, Lepidoptera): 92 rows for the first alone. Those are curation tasks
  (beeline-45v.1), reported by the loader and never minted by it.
- **`identificationQualifier`** is free text: `cf. cooleyi`, `af. cooleyi`, `aff.
  tortifoliae`, `zonalis group`, `n. sp. aff tenax`, `?`, `subsp. segona`. The loader
  keeps a qualifier only where it is one of the three the store admits and names the
  epithet beside it; the rest goes to the notes with `identificationRemarks`.
- **`modified`** on an identification is when it was entered, to the second in the
  archive and to the minute in a flat export.

## Ordering, and why `dateIdentified` is not it

The determination of record is the newest expert event by `recorded_at`. So an import
has to get *arrival order* right, and `dateIdentified` cannot help. Two moments do:

- The identification Ecdysis calls **current** is recorded when it crosses into Beeline,
  like any event. It supersedes what stood before, including the legacy import's
  undated copy of the same assertion, which is how a Washington record gains its year.
- A **superseded** identification is recorded at the moment Ecdysis entered it. It is
  history, and it lands in the past where it belongs, whichever export brings it.

Loading is idempotent twice over: by Symbiota's `recordID`, and by restatement, since a
flat export and an archive key the same identification differently. An older export
loaded after a newer one would make since-revised identifications current again; the
loader refuses that unless forced.

Measured on a migrated copy of the dev store, loading in date order:

| Export | Occurrences | Matched | Already recorded | Loaded |
|---|---|---|---|---|
| Flat, 2026-02-25 | 51,633 | 50,091 | 0 | 25,715 |
| Flat, 2026-03-05 | 46,091 | 44,549 | 23,858 | 175 |
| Archive, 2026-07-10 | 46,090 | 44,549 | 24,263 | 8,094 |

After which 30,465 of Washington's 30,995 expert determinations of record are the
Ecdysis event, 30,772 of the 33,984 imported events carry a year, and 221 records
name a different taxon than the August legacy dump did. Each load takes under ten
seconds.

## Open

- **Dataset ids for the other atlases.** Washington is dataset 44 within WSUC's
  collection 164. Which collections and datasets BC and the others keep, and what
  prefix their catalog numbers carry, is a question for their staff.
- **Credentials.** The archive download is authenticated; beeatlas holds a login for it.
  A Beeline job would need one of its own, kept in the private store's secrets.
- **The direction out.** Beeline exports nothing to Ecdysis automatically today
  ([roadmap](../roadmap.md), phase 7); the occurrenceID questions on
  [gh-98](https://github.com/rainhead/beeline/issues/98) come first.
