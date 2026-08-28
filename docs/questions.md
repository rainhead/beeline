# Outstanding questions for staff

Questions we can't answer from code or data, queued for Peter's next meetings with Andony/Arthur/atlas staff. Move answers into [CONTEXT.md](../CONTEXT.md) or the relevant doc, then delete the question.

## Trap sampling (mostly unknown territory — no reference implementation, spreadsheets unseen)

Production facts to anchor the conversation: ~52k trap-collected records (14% of all), sample series `OBAS-00016`–`OBAS-00669`+ (Oregon vane traps, 33k records) and `WBAS-…` (487), single samples up to 2,252 specimens, 53k records carry end-dates (date ranges). The `within_sample_disagreement` findings (973 samples) add evidence for question 2: the largest clusters are trap groups whose rows carry *incrementing* localities along a route ("… Forest Service Road 2780 | 2781 | 2782 …") with coordinates differing to match — one (person, date, sample-number) group that looks like a trap line of distinct collecting spots, not one place.

1. **Who assigns the `OBAS-`/`WBAS-` sample numbers, and is there a registry?** (A spreadsheet mapping sample → site, dates, trap details?) Can we see it?
2. **What is a trap site?** Are traps at fixed, named locations with a deployment history, or placed ad hoc? Do multiple traps at one site make one sample or several? And for the trap-line pattern above: is a route one sample with many stations, or many samples sharing a number — and which does the label/record need?
3. **Protocol vocabulary**: production free text includes vane trap(s), blue vane trap, pan trap(s), trap nest, vacuum — and effort smuggled into strings like "6 Vane Traps" / "25 Pan Traps". What controlled vocabulary do staff actually think in? Is trap *count* per sample recorded anywhere reliable?
4. **Dates**: is the range's start date the previous servicing? Where is servicing recorded today?
5. **Batch processing**: when a large catch is processed over weeks, what does the processor record per batch, and when do those specimens become printable?
6. **For Darwin Core publication** we would want per sample: `samplingProtocol` (controlled term), `samplingEffort` (e.g. trap-count × trap-days), `eventDate` as a range, and possibly habitat and preservative/kill method. Which of these can staff actually supply, and which should the trap interface capture going forward?
7. **What are the `LRB`/`SM`/`MMS` sample-number prefixes** in Oregon net data? (`G`/`R` are answered: 379 `G…` samples file under Gretchen Pederson and 351 `R…` under Robert, both 2019–2020, so the `pandg` household numbered a series each. See People and accounts below.)

## Taxon geoprivacy (⚠ blocker: must be answered before go-live)

Raised by Nora (2026-08-19). iNaturalist obscures coordinates for sensitive taxa regardless of the collector's wishes, and each atlas sits in its own regulatory environment — this is not a decision Beeline can make on every atlas's behalf. Beeline retains **both** the public (possibly obscured) and true coordinate pairs, so either answer is implementable; what's open is *revelation*, per atlas:

1. **May true coordinates of taxon-obscured records be revealed** — on printed labels, and in exports that leave the program (Ecdysis/GBIF)? Answer needed per atlas.
   - **Decided in-app, 2026-08-23 (Peter):** there is no reason to withhold true coordinates *from the collector or from their own atlas's staff*. They are the coordinates the collector recorded on their own observation, they are printed on that collector's own labels, and CONTEXT.md's stance is that anyone trusted with the main store is trusted with these. The listings and their CSV exports carry coordinates, with each record's provenance and geoprivacy beside them ([beeline-2c3.26](../.beads/)). This is an *internal* read by a participant, not revelation.
   - **Still open:** may one atlas's staff see another atlas's true coordinates? Beeline has no per-atlas staff role today (staff is a global allowlist, beeline-2c3.21), so the all-atlases scope currently shows them. Question pending to Andony; implementation proceeds meanwhile.
2. **What binds each atlas here** — sensitive-species regulations, state natural-heritage data-sharing agreements, iNaturalist's obscured-coordinate terms?
3. Until an atlas answers: do its taxon-obscured records stay unprintable (current behavior), or print with obscured coordinates?

## People and accounts

Raised 2026-08-24 by looking at `/people` (beeline-eyk, beeline-oyl). One iNaturalist login can belong to a household, and `inat_account.inat_user_id` is unique, so only one of the pair can hold it — the other has samples and no way to sign in and see them. 17 people, 2,329 samples, are in that position today; about seven of those stop existing once the duplicate-collector worksheet becomes alias lines, and the rest are real.

1. **Who is Pete?** Robert Pederson's records file under `pandg`, which iNaturalist titles "Pete & Gretchen Pederson" — but every `recordedBy` string the household typed says "Robert Pederson", and his own field series is `R…` beside Gretchen's `G…`. Labels therefore print "R. Pederson", which is probably right. Is Robert also Pete (nickname, middle name), or is the account title stale? Only worth changing anything if he is Pete to everyone.
2. **And who is Jane Pope?** 31 samples, 2019–2020, filing under `pandg` alongside the Pedersons. A third member of that household, a visitor they entered records for, or something else? This one now has a consequence attached: Gretchen has been granted reach over Jane's records (`ingest/person-overlay.csv`, 2026-08-28) on the assumption that filing under `pandg` makes her household. If she is not, that grant is the one to withdraw — a blank `acts_for` value removes it.
3. **Would these people rather have their own accounts?** Gretchen holds `pandg`; Robert (1,087 samples) cannot sign in. Same shape for Steve Sheehy under Sarah Malaby's `smalaby` (420) and Julie Biddle under Tom Robertson's `tom_julie` (363). No longer blocking anything: delegation (beeline-oyl) is built and the three grants are recorded, so each household's account holder can now reach the partner's records. The question is now about preference rather than access — an own account is still the better answer for anyone who wants one, since delegation grants reach and never credit, and Master Melittology progress accrues to the person either way.
4. **Emma or Emily Hoskins?** Her records spell it both ways, 25 and 21, interleaved through the 2024 season, so nothing in the data breaks the tie. Both spellings now merge into one person under `Emma` — chosen **arbitrarily** (Peter, 2026-08-24), unlike the other ten merges, which came from reading iNaturalist profiles. It will print on her labels and reach Ecdysis and GBIF looking exactly as settled as the rest. One line in `ingest/collector-aliases.csv` reverses it.
5. **Does Emily Carlson have an iNaturalist account?** Her 254 samples carry `amelathopoulos` because Andony typed the records in, not because it is hers. She needs her own resolved, not a share of his.

## Printing and mailing (for the walkthrough with Arthur/Andony)

1. Observe the "printing moment" end to end: what does Arthur actually inspect when proofing, and what causes him to pull a record out of a run?
2. Label stock: what sheets/stock are used, and are the 250-per-page geometry and 3–5pt fonts constraints of the stock, the printer, or convention?
3. How do other atlases plan to print and mail — equipment, label stock, postage/bulk-mail access?
4. What does the `E` prefix on 2020–2022 Oregon field numbers (`E2000000`–`E2332481`, 1,400 records) denote? And the 2018 name-based identifiers (`First_Last:18.sss.nnn`) — are those printed verbatim on physical labels?
5. Where did the historical cross-project duplicate field numbers live — this database, Ecdysis, or between them — and were they renumbered or do the physical labels still collide?
6. **Label lifecycle**: when bad data is found on a printed label, is the remedy always a reprint under the *same* field number, with the old label removed and destroyed by whoever holds the pin? Is that swap ever confirmed, or taken on faith?
7. **Attribution for records belonging to no member atlas.** ~2,660 specimens were collected where none of the six atlases reaches, by people who are either atlas members travelling or Master Melittologists with no atlas at all (see Membership in [CONTEXT.md](../CONTEXT.md), beeline-lcl). Whose name goes on their labels, and on their Ecdysis/GBIF records — the program, or the atlas that happens to process them? Today the store can say "no atlas" honestly; it has no answer for what to *print*. Related: does processing a sample through an atlas (the Arizona-through-Washington arrangement) make that atlas the attribution, or only the handler?
8. **Field-number lifecycle**: has a number ever been permanently scrapped/voided — specimen destroyed, label printed but never pinned, duplicate collision? If a number were retired after publication, how would Ecdysis/GBIF learn of it?

## Taxonomy across the atlases

Raised 2026-08-27 by Peter: the atlases disagree about taxonomy to some degree. Whether Beeline ever models that divergence is [beeline-0zb](../.beads/), and the stance there is to defer until a second opinion is actually being read — but the shape of the disagreement decides whether that is a curation conversation or a schema.

1. **Which taxonomies do the atlases actually follow, and where do they concretely disagree?** A handful of contested genera is a curation problem; different backbones is not.
2. **Does the disagreement change what goes on a label, or only how records are grouped for analysis?** A label prints one name — those are different problems with different answers.
3. **When two atlases disagree, whose name reaches Ecdysis and GBIF?** Related to the attribution question for records belonging to no member atlas (Printing and mailing 7).
4. **Do determiners use identification qualifiers beyond `cf.`, `aff.` and `nr.`?** Those three are what `determination.qualifier` now takes ([beeline-tgu](../.beads/)) — the ones that modify a species assertion and cannot be said by dropping to genus. The legacy corpus attests only `nr.`, three records. If determiners also want `sp. nov.` or `s. str.` recorded rather than derived from rank, that is a wider vocabulary and a change to the CHECK. Not a printing question: a label carries no taxon at all ([reference-implementation.md](reference-implementation.md)), so this is about what reaches Ecdysis and GBIF.
