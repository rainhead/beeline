# What has happened to field numbers, and what it costs

A field number is the one thing Beeline mints that becomes permanent: it goes on a pinned label, into Ecdysis, and out to GBIF, and it cannot be recalled from a drawer. Phase 5 has to decide how numbers behave going forward ([ADR 0008](adr/0008-field-number-lifecycle.md)), and that decision is only as good as our account of what the numbers have *already* done.

This is that account. Every figure is measured against the production dump (383,032 records, 2017–2026, surveyed 2026-09-09) rather than recalled, because most of what was believed about these numbers turned out to be a story about the code rather than about the data. Where the finding contradicts something the project has said elsewhere, it says so.

Companion documents: [reference-implementation.md](reference-implementation.md) for what the current system does, [CONTEXT.md](../CONTEXT.md) for the vocabulary, [questions.md](questions.md) for what staff have not yet settled.

## The headline: the year in a field number is the year it was *printed*

Field numbers look like `25000001` — a two-digit year and a sequence — and everybody reads the `25` as the collecting season. It is not. It is the year the **label was printed**, and the two differ on **38,842 records**, about a tenth of the corpus.

One case makes the shape clear. `26xxxxxx` numbers were issued during 2026, and among them are **4,227 bees collected in 2019** and **8,616 collected in 2020** — a backlog of trap catches processed and printed six years after they were caught. Nothing is wrong with those records. They are simply numbered by when somebody ran the printer.

The evidence has to come from the years where a real print date exists at all (see the next section — before 2025 the print date is a restatement of the collection year and can settle nothing). In those years it is decisive:

| number prefix | records | agrees with **print** year | agrees with **collection** year |
|---|---|---|---|
| `25` | 76,759 | 99.5% | 93.8% |
| `26` | 72,086 | **100.0%** | **75.5%** |

The `26` block is the clean experiment: every one of its 72,086 numbers was printed in 2026, and a quarter of them are bees caught in some earlier year.

The mechanism is duller than the pattern suggests, and worth stating because it kills the year reading entirely: there is **one global counter**, and it only ever increments. The year is consulted solely when the collection is empty (`ObservationsSubtaskHandler.js`). So the leading digits are just wherever the counter has got to — it happened to cross 26,000,000 during 2026, and it happened to cross 19,000,000 during 2019, because the program prints roughly a million-numbered-season's worth of labels a year. The correlation is a coincidence of pace, not a rule; the residual disagreement in any given block is the counter drifting across a New Year mid-run and carrying its old leading digits with it.

**Consequence.** Nothing may parse a season, a year, or an atlas out of a field number. It is an opaque integer with a suggestive prefix, and code that reads meaning into the prefix is wrong on tens of thousands of records. This is the reverse of what [reference-implementation.md](reference-implementation.md) called a "vestigial" year prefix: vestigial implies it once meant the collection year and stopped. It never meant it.

## We do not know when anything was printed before April 2025

`dateLabelPrint` is the only print provenance the corpus has. For **234,183 records — 61% of everything — it is 31 December.**

| print year | records | distinct print dates |
|---|---|---|
| 2017 | 364 | **1** (31 Dec) |
| 2018 | 18,956 | **1** (31 Dec) |
| 2019 | 32,734 | **1** (31 Dec) |
| 2020 | 34,512 | **1** (31 Dec) |
| 2021 | 34,686 | **1** (31 Dec) |
| 2022 | 23,561 | **1** (31 Dec) |
| 2023 | 37,544 | **1** (31 Dec) |
| 2024 | 51,826 | **1** (31 Dec) |
| 2025 | 76,409 | 36 |
| 2026 | 72,438 | 21 |

A year of print runs cannot fall on one day, and that day cannot be New Year's Eve. It is a per-year sentinel — and it is worse than a placeholder, because it was backfilled **from the collection year**: for all 234,183 pre-2025 records, the "print year" equals the collection year exactly 100% of the time. In the years where dates are real, they agree only 84.7% of the time. So the pre-2025 value carries no independent information whatever; it is `year` wearing a date's clothes.

Real dates start **7 April 2025**, and they behave exactly as Arthur describes the job: of the 57 print days since, **25 are Mondays**, carrying 66,149 of 149,000 labels. That is the independent confirmation that the 2025-onward dates are records rather than more sentinels.

**Consequence.** "Which physical labels does this correction invalidate?" is unanswerable for 61% of the corpus beyond the granularity of a year, and no future system can recover it. It is the strongest possible argument for print runs being first-class events going forward, which is [reference-implementation.md](reference-implementation.md)'s requirement 5 — but it also means the answer for historical labels is *we cannot know*, and any screen that implies otherwise is lying.

## Five identifier eras, not four

[CONTEXT.md](../CONTEXT.md) records four. There is a fifth, small and previously unnamed.

| era | records | range |
|---|---|---|
| 7-digit | 214,260 | `1800001`–`2463721` |
| 8-digit | 148,845 | `25000001`–`26072091` |
| 2018 name-based | 18,512 | `Andony_Melathopoulos:18.001.001` … |
| `E`-prefixed | 1,400 | `E2000000`–`E2332481` |
| **2019 name-based** | **14** | `Lincoln_Best_19-1.26`, `Lincoln_Best_19S-1.03` … |
| malformed | 1 | `Bonnie_Shoffner18.001.034` (the colon is missing) |

The fourteen `Lincoln_Best_19…` identifiers are the previously unrecorded era: the 2018 name-based scheme surviving a year past its supposed end, with an `S` marking what looks like a survey series. Fourteen records is not a design problem, but it is a counter-example to "2018 name-based ids" as a closed set, and anything that parses identifiers by era has to tolerate it.

The `E` prefix is answered: it denotes **Emily Carlson's PhD work** (Andony, [gh-17](https://github.com/rainhead/beeline/issues/17)). It is a project marker, not a check character or a status flag.

## The `E` numbers were drawn from occupied numeric space

`E2000000`–`E2332481` overlaps the plain `20xxxxx` block that was issued at the same time. **411 of the 1,400 collide with a plain number that actually exists** if the letter is ever stripped.

That is not hypothetical: stripping a prefix is an established habit in this codebase — `catalogNumber` is read from Ecdysis by removing `WSDA_`. A join that normalises `E2000123` to `2000123` silently merges two different bees 411 times.

The gap census shows the same thing from the other side. Within each print year's block of numbers, most are dense — the `26` block is 100.0% used, `22` is 99.9% — but the `20` block is only **32.9% dense, with 60,393 numbers unissued inside it**. That hole is largely where the `E` series lives.

**Consequence.** The `E` is load-bearing and must never be stripped, normalised away, or cast to an integer. `(prefix, number)` is the identity, not the digits.

## Numbers are skipped, in quantity

Across the 7- and 8-digit eras, **about 86,000 numbers inside issued blocks were never used**. Some of that is the `E` hole above; the rest is ordinary — a run prepared and not printed, a counter advanced by a crash, the two disagreeing generator implementations described in [reference-implementation.md](reference-implementation.md), one of which takes the maximum within the current working set and can reissue held numbers.

**Consequence.** A gap in the sequence means nothing. Do not build a "missing labels" report on it, and do not backfill into gaps — a number in a gap may be sitting on a pin.

## One duplicate is live, and the corpus cannot tell us how many more

`25051768` was issued twice to the same collector, samples 1 and 2, printed **17 August and 16 September 2025**. Two physical specimens bear it. This is the scratch-scoped max-scan reissue predicted from the code, observed in the wild — and it slipped through proofing on both sheets, which is what the sample-based check (two labels per sheet) is expected to do with a defect this rare.

It is the only duplicate the corpus can prove, and the corpus cannot rule out more. The obvious test — one specimen identity carrying two numbers — does not separate a renumbering from a collector who used the same sample number twice in a day: 545 identities agree on collector, sample, specimen, date **and** coordinates to three decimal places, while a further 1,778 differ in coordinates and are duplicate sample numbers wearing an identical signature. 545 is an upper bound, not a measurement.

Andony reports duplicate resolution underway, 2025 first and then back through 2024 ([gh-17](https://github.com/rainhead/beeline/issues/17)). Where those duplicates lived — this database, Ecdysis, or between them — and whether the physical labels still collide, is [open](questions.md).

## Ghost records exist, and are almost nothing

Arthur's term for a number whose data was emptied and moved elsewhere. Exactly **one** record in 383,032 has that shape — `Stephanie_Hazen:18.053.058`, empty in every field but the number — with seventeen more missing only the sample number, and four missing the collector. Nothing has been traced from a ghost to a successor.

**Consequence.** Whatever policy is chosen, the ghost population is not a design driver. It is a rounding error that needs a defined reading (ignore it) rather than a mechanism.

## What this does not settle

The two people who run printing have given **opposite** accounts of whether a wrong label is reprinted under the same number or a new one ([gh-17](https://github.com/rainhead/beeline/issues/17), and questions 4–5 in [questions.md](questions.md)). Beeline proceeds on Andony's — a number is minted once and stays with its specimen — per [ADR 0008](adr/0008-field-number-lifecycle.md), pending his confirmation. Nothing in this document decides it; the measurements above are compatible with either account, which is precisely why it has to be asked rather than inferred.
