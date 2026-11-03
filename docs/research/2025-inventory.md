# The 2025 inventory: what Andony's master file says, and what Beeline does with it

Read 2026-11-03 (Peter, with Claude), from the file Andony shared that day,
`2025_BEELINE_MASTER_CONSOLIDATED_2026-11-03T11.05.48.xlsx` in the OSU shared drive
(Drive file `1Elznt6C6C2ne9rS4c3H8nERNIKC767BU`), checked against the old system's pull of
2026-11-03 04:35 UTC, the one production's first store was built from. The loader is
[src/load-dispositions.ts](../../src/load-dispositions.ts); this note is what it was built
against. GitHub [#244](https://github.com/rainhead/beeline/issues/244) carries the one
question the reading raised, and Andony's answer. The file names volunteers, so it lives
in the gitignored `data/`, and nobody is named here beyond what GitHub already says.

## What the file is

The old system's export columns, 81,372 records, nearly all from the 2025 season
(Washington 31,942, Oregon 27,156, New Mexico 7,042, BC 5,657, Idaho 2,863) and a few
older Oregon years, plus two columns of Andony's own: `original_fieldNumber`, the number
a relabelled pin used to carry, and `occurrenceRemarks`, his disposition of the record
after going through the boxes in the autumn of 2026. 66,212 rows carry no remark: the
inventory found the pin and had nothing to say. 15,161 carry one, each opening with its
kind in capitals.

| Remark | Rows | Where |
| --- | ---: | --- |
| `LOST SPECIMEN`: not in the inventory, no metadata match | 10,890 | Oregon 8,084, Washington 2,159, New Mexico 515, the rest small |
| `PRINT REQUIRED`: label never generated | 2,481 | New Mexico, Idaho, BC, Kansas, Nevada, Alberta and others; none Oregon or Washington |
| `PHANTOM RECORD`: metadata duplicates another number, retire this one | 1,082 | all Oregon; 482 are O'Loughlin trap samples |
| `METADATA RECONSTRUCTED`: from archived files, or from the pinned label | 361 | |
| `PRINTED`: confirmed in BC's Ecdysis by the BC taxonomist | 211 | BC |
| `RELABELLED`: a duplicate number; this pin reprinted under a new one | 90 | 25100000 to 25100089, printed 22 September 2026 |
| `REPLACEMENT PRINT REQUIRED`: the label names the wrong collector | 26 | a household's labels, and one naming three people |
| `RECOVERED`, `NO SPECIMEN RECORDED`, `REPRINT REQUIRED` | 20 | |

## Most of the "lost specimens" are surplus labels

4,143 of the lost rows have field numbers the old system has never held. For 3,869 of
them the file holds another row with the same collector, date, sample and specimen
number, carrying no remark, and the old system holds that specimen under the second
number. The pairs fall into three print runs, which is what makes them reprints rather
than coincidence:

| "Lost" number printed | Its twin printed | Pairs |
| --- | --- | ---: |
| 22 April 2025 | 7 or 14 April 2025 | 2,069 |
| 25 August 2017, a date that cannot be right | 4 August 2025 | 1,714 |
| never | 4 November 2025 | 132 |

By state: Washington 2,113, Oregon 1,127, New Mexico 506, Idaho 74, BC 49. Andony
confirmed on 3 November 2026 that these were double or triple prints, not lost bees.
The other 6,370 lost rows have no twin and no determination of any kind, and nothing
says they are anything but lost. That the old system printed one specimen under more
than one number was known for the earlier years (beeline-bib1); the 2025 season has it
at a larger scale, and the old system no longer holds the losing numbers, which is why
promotion never saw them.

## The relabelled pins answer an old question

Where the historical cross-state duplicate field numbers lived was the last open
question on GitHub #17, and the file answers it: in the old system. One number was
issued to collectors in two states, for example 25049094 to a Washington collector in
the old system and to an Oregon collector in the file. Andony's rule is that the
non-Oregon pin keeps the number and the Oregon pin is relabelled; within one state, a
pin scanned twice under two spellings of one collector was handled the same way. The 90
new numbers are the 177 empty two-per-number shells in the old system that had been
noted on beeline-bib1. Only 7 of the 90 specimens are known to the old system at all.

## What the loader does

A row reaches a specimen by its field number. A remark on such a row is kept as written,
with Darwin Core's `disposition` read off its kind: lost and phantom records are
`missing`, printed and recovered ones `in collection`, and a remark about the record
rather than the pin (a label to print, metadata rebuilt) gets none. A lost row whose
number is no specimen, and whose twin by the five facts above is one, becomes a sentence
on the twin: another label was printed, no pin carries it, and the number is retired.
The old system's print date is repeated only where it falls after the bee was collected;
the 2017 date is not. A row with no remark whose number is no specimen, but whose twin
is one, is the inventory finding a pin under a number Beeline does not hold, and is held
rather than guessed at. Held rows are listed beside the file with the reason: no
specimen, a number Beeline lacks, a number two specimens carry, or two rows that remark
differently on one specimen. The listing is the worklist for what the file still asks of
Beeline (beeline-fud5): the pinned specimens the old system never knew (83 of the 90
relabelled, 259 of the reconstructed, all 26 wrong-collector labels), the retirement of
the phantom numbers into the specimens they duplicate, the 2,481 labels for other atlases
that were never produced, and a way to say a specimen is lost that is more than a remark.

## Measured on a store built from the 2026-11-03 pull

The whole file loads in under a minute. 14,301 specimens get a remark: 7,829 `missing`
(7,733 of them Oregon), 3,989 `in collection`, and 2,483 with a remark and no
disposition, nearly all the labels still to print for the other atlases. 3,896 lost rows
became surplus-label sentences on 3,880 specimens; 16 of those were printed three
times, and 1,714 sentences carry no date because the old system's date was the 2017
placeholder. 806 rows are held:

| Reason | Rows | Of which |
| --- | ---: | --- |
| No specimen, and no twin | 535 | 259 reconstructed, 163 lost, 83 relabelled, 26 wrong-collector labels, 4 with no record |
| A twin, but the row is not a lost record: a number Beeline lacks | 186 | 102 reconstructed, 63 pins the inventory found under that number, 12 recovered, 7 relabelled, 2 reprints |
| A lost record whose twin is two specimens | 84 | the old system holds the bee twice, and which is the pin is not for the loader to say |
| A number two specimens carry | 1 | |

Two things about the file are assumptions rather than facts in it. A row with no remark
is read as a pin the inventory found, because every record it did not find got the lost
remark. And the phantom rule is Andony's: a phantom shares its collector and day with
the record it duplicates but not its specimen number, one target absorbs 79 phantoms,
and the columns alone cannot reconstruct the judgment, so the remark is carried as he
wrote it.
