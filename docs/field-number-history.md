# What field numbers have done, and what the next ones inherit

A field number is the one thing Beeline mints that cannot be taken back: it goes on a pinned label, into Ecdysis as the stem of the museum's catalog number, and out to GBIF. [ADR 0008](adr/0008-field-number-lifecycle.md) says how numbers behave from here on. This document is the evidence under it — what the 383,032 numbers in the production dump (2017–2026, surveyed 2026-09-09) have actually done, with the consequence of each finding first and the count after.

Two things to hold onto while reading. First, **everything here is printed and finished**: nothing from before 2026 is pending printing, so none of this is a worklist, and none of it is repaired by the ADR — it is bounded by it. Second, most of what the project believed about these numbers was a story about the code rather than the data, which is why each finding is measured rather than recalled. Companion documents: [reference-implementation.md](reference-implementation.md) for what the current system does, [CONTEXT.md](../CONTEXT.md) for the vocabulary, [questions.md](questions.md) for what staff have not settled.

## Nothing may read a year out of a field number

Field numbers look like `25000001`, and everybody reads the `25` as the collecting season. It is the year the **label was printed**, and the two disagree on **38,842 records** — about a tenth of the corpus.

One block shows the shape. Every number beginning `26` was printed in 2026, and among them are **4,227 bees collected in 2019** and **8,616 collected in 2020**: a backlog of trap catches processed and printed six years after they were caught. Nothing is wrong with those records; they are numbered by when somebody ran the printer.

| number prefix | records | agrees with print year | agrees with collection year |
|---|---:|---:|---:|
| `25` | 76,759 | 99.5% | 93.8% |
| `26` | 72,086 | 100.0% | 75.5% |

Only the years with a real print date can be tested this way (before 2025 the recorded print date is a restatement of the collection year — see the note at the end), and in those years the reading is decisive: the `26` block is the clean experiment, printed entirely in 2026 with a quarter of its bees caught earlier.

The mechanism is in [how the numbers were made](#how-the-numbers-were-made), below, and it is duller than a rule: the year is written into a number only when the generator finds nothing to increment from, and every number after that inherits the prefix unchanged. The two digits are the clock at the moment a block of numbers was opened, and blocks are opened at the printer.

**Consequence.** A field number is opaque. Nothing in Beeline parses a season, a year, an atlas or a project out of one, and code that reads the prefix as a season is wrong on tens of thousands of records. This also retires the word *vestigial*, which [reference-implementation.md](reference-implementation.md) once used for the prefix: vestigial implies it once meant the collecting season and stopped. It never did.

## How the numbers were made

The reference implementation numbers a record by scanning for the highest field number already issued and incrementing it; there is no sequence and no unique index, so uniqueness is a convention (`fieldNumber` in [reference-implementation.md](reference-implementation.md)). Two things about that generator explain most of what follows.

**There are two of them, and they disagree about what to scan.** Both live in the worker, share one increment rule, and are run in the same place in their respective pipelines — but `ObservationsSubtaskHandler.js` asks the whole collection for its highest number, while `OccurrencesSubtaskHandler.js` asks only the current working set (`scratch: true`). A number that was issued outside the working set is invisible to the second one, which can therefore issue it again. That is not a hypothetical: it is how the one duplicate in the corpus was made ([below](#one-duplicate-is-live-and-the-corpus-cannot-count-the-rest)). Any claim of the form "one global counter, only ever increments" describes the first path and omits a production path.

**The year is a default, not a component.** The increment splits a number after its second character, increments the rest, and reattaches the same two characters unchanged. The current year is consulted only when the scan finds nothing to increment from, and the number is then `YY` + `000001`. So a prefix is the year in which some run found nothing to increment from, and every number issued after it inherits that prefix until the next such run — which is why the prefix tracks the printer's calendar and nothing else.

Each block in the corpus does begin at the bottom of its prefix rather than continuing the previous one's count, but only one of them is that default's output. These are the observed minima:

| prefix | block starts at | what today's default would give |
|---|---|---|
| `18` | `1800001` | `18000001` |
| `19` | `1900001` | `19000001` |
| `20` | `2000000` | `20000001` |
| `21` | `2100000` | `21000001` |
| `22` | `2200000` | `22000001` |
| `23` | `2300000` | `23000001` |
| `24` | `2400001` | `24000001` |
| `25` | `25000001` | `25000001` |
| `26` | `26000000` | `26000001` |

Only `25000001` matches. The 7-digit blocks are a digit shorter than the default can produce, and four of them plus `26000000` start on `…0000`, which an increment from `…000001` never reaches. So the seeds were not written by this code: the current default accounts for the 2025 block and nothing else, which places the code we can read at the 7→8 digit transition and leaves everything before it seeded by hand or by a version nobody has. The mechanism above still explains the *prefixes*; it does not explain the *seeds*, and no reading of the generator should claim it does.

## Five identifier eras, not four

[CONTEXT.md](../CONTEXT.md) now records five; until this survey the fifth was unnamed.

| era | records | range |
|---|---:|---|
| 7-digit | 214,260 | `1800001`–`2463721` |
| 8-digit | 148,845 | `25000001`–`26072091` |
| 2018 name-based | 18,512 | `Andony_Melathopoulos:18.001.001` … |
| `E`-prefixed | 1,400 | `E2000000`–`E2332481` |
| 2019 name-based | 14 | `Lincoln_Best_19-1.26`, `Lincoln_Best_19S-1.03` … |
| malformed | 1 | a 2018 id written `First_Last18.sss.nnn` — the colon is missing |

The fourteen `Lincoln_Best_19…` identifiers are the 2018 name-based scheme surviving a year past its supposed end, with an `S` that looks like a survey series. Fourteen records is not a design problem; it is a counter-example to "the 2018 ids" being a closed set, and anything that recognises identifiers by shape has to tolerate it. Whether any name-based identifier was ever printed verbatim on a pin is question 6 in [questions.md](questions.md).

The `E` prefix is answered: it marks **Emily Carlson's PhD work** (Andony, [gh-17](https://github.com/rainhead/beeline/issues/17)). It is a project marker, not a check character or a status flag.

## The `E` must never be stripped

`E2000000`–`E2332481` was drawn from inside the plain `20xxxxx` block being issued at the same time, and **411 of the 1,400 collide with a plain number that actually exists** if the letter is removed. Removing prefixes is an established habit in this codebase — Ecdysis's `catalogNumber` is read by stripping `WSDA_` — so a join that normalises `E2000123` to `2000123` merges two different bees, 411 times, silently.

The gap census shows the same hole from the other side. Most blocks are dense — `26` is 100.0% used, `22` is 99.9% — but `20` is only **32.9%** used, with 60,393 numbers unissued inside its span, and that hole is largely where the `E` series sits.

**Consequence.** The identity is the whole string. Nothing casts a field number to an integer, and nothing normalises one.

## A gap in the sequence means nothing

Across the 7- and 8-digit eras, **about 86,000 numbers inside issued blocks were never used**. Some of that is the `E` hole; the rest is ordinary for a scan-and-increment generator — a run prepared and not printed, a counter advanced by a crash, a working-set scan starting from wherever its subset happened to end.

**Consequence.** Do not build a "missing labels" report on gaps, and do not backfill into them — a number in a gap may be sitting on a pin under an `E`.

## One duplicate is live, and the corpus cannot count the rest

`25051768` was issued twice to the same collector — samples 1 and 2 — and printed on **17 August and 16 September 2025**. Two physical specimens bear it. It is the working-set generator reissuing a held number, predicted from the code and observed in the wild, and it slipped through proofing on both sheets, which is what a two-labels-per-sheet check is expected to do with a defect this rare.

It is the only duplicate the corpus can prove (exactly one field number occurs on two rows), and the corpus cannot rule out more. The obvious test — one specimen identity carrying two numbers — cannot separate a renumbered specimen from a collector who used the same sample number twice in a day: **545** identities agree on collector, sample number, specimen number, date *and* coordinates to three decimal places while carrying two numbers, but a further 1,778 differ only in coordinates and are same-day duplicate sample numbers wearing an identical signature. So 545 is an upper bound, not a measurement, and no report should print it as a count of renumberings.

Andony reports duplicate resolution underway, 2025 first and then back through 2024 ([gh-17](https://github.com/rainhead/beeline/issues/17)). Where those duplicates lived — this database, Ecdysis, or between them — and whether the physical labels still collide, is question 7 in [questions.md](questions.md).

## Ghost records are a rounding error

A *ghost record* is Arthur's term for what a scrapped number leaves behind: a row still carrying the number with every other field emptied, the data having moved to a successor. Exactly **one** row in 383,032 has that shape (a 2018 name-based id; it is the only row where `recordedBy`, `sampleId` and `verbatimEventDate` are all empty) — with seventeen more missing only the sample number and four missing the collector. Nothing has been traced from a ghost to a successor.

**Consequence.** Whatever the lifecycle policy, ghosts are not a design driver. They need a defined reading (a row with no data behind it is ignored) rather than a mechanism.

## A note on print dates, which drive nothing

`dateLabelPrint` is the only print provenance the corpus carries, and before 2025 it is not a date. For **234,183 records** it is 31 December of the collection year — a per-year placeholder backfilled from `year`, agreeing with the collection year 100% of the time where the real dates that follow disagree with it about one time in seven. Real dates begin on **7 April 2025**, and they look like the job as Arthur describes it: 25 of the print days since — nearly half — are Mondays.

This is mildly interesting and has no forward consequence. Everything from before 2026 is printed and done, nothing from it is pending, and when a historical label was printed is not a question anybody needs answered (Peter, 2026-09-09). Print history matters for labels Beeline prints from now on, for reasons that are the ADR's to make, not for these.

## What this does not settle

The two people who run printing have given opposite accounts of whether a wrong label is reprinted under the same number or a new one ([gh-17](https://github.com/rainhead/beeline/issues/17); questions 4–5 in [questions.md](questions.md)). Nothing above decides it: the measurements are compatible with either account, which is why it has to be asked rather than inferred. Beeline proceeds on Andony's — a number is minted once and stays with its specimen — per [ADR 0008](adr/0008-field-number-lifecycle.md), proposed until he and Arthur have confirmed it together.
