# ADR 0008: Specimen identity — occurrenceID is permanent, the field number is a label

**Status:** **proposed** (2026-09-09) · awaits Arthur and Andony confirming it
together on [gh-17](https://github.com/rainhead/beeline/issues/17) · the
evidence is [field-number-history.md](../field-number-history.md) · phase 5
(beeline-1kb) is gated on it · reframed the same day it was drafted: the first
version was titled *A field number is minted once and never moves*, and was
answering the right question with the wrong identifier (beeline-1kb.14,
beeline-1kb.15)

## Context

Darwin Core gives a specimen record two identifiers, and they are meant to
behave differently:

- **`dwc:catalogNumber`** is the collection's number for the specimen. It is
  *expected* to change now and then — a recatalogue, a merged collection, a
  repaired duplicate — and the vocabulary has a field for what it used to be:
  `dwc:otherCatalogNumbers`, "a list (concatenated and separated) of previous
  or alternate fully qualified catalog numbers or other human-used
  identifiers for the same Occurrence"
  ([dwc.tdwg.org](https://dwc.tdwg.org/list/#dwc_otherCatalogNumbers)).
  Symbiota, which is what Ecdysis is, enforces one `catalogNumber` per
  collection and offers tagged additional identifiers — a suggested tag is
  literally *Previous Catalog Number*
  ([docs.symbiota.org](https://docs.symbiota.org/Editor_Guide/Editing_Searching_Records/catalog_numbers/)).
  SPNHC's guidance on numbering is cool on leaning on `otherCatalogNumbers` —
  it prefers a relational system with a persistent identifier beside the
  number — and notes that recataloguing a large collection is often
  unfeasible and that a superseded number may already be in print; but it
  treats recataloguing as regrettable and normal, not forbidden
  ([spnhc.org](https://spnhc.org/numbering-natural-history-collections/)).
- **`dwc:occurrenceID`** is the record's persistent, globally unique
  identity, and it is the one that must never change. GBIF treats a changed
  `occurrenceID` as a **new record**: a fresh `gbifID`, a fresh URL, the old
  one deprecated and every link to it broken. Since 2022 GBIF polices it —
  ingestion **pauses** when more than half the identifiers in a new version
  differ from the last, an issue is opened and the publisher emailed — and an
  intentional change is migrated only by the publisher supplying an old→new
  list, against which GBIF carries the `gbifID`s and URLs across
  ([data-blog.gbif.org](https://data-blog.gbif.org/post/improve-identifier-stability/)).
  Symbiota mints its own UUID for it and advises that the value be kept with
  the canonical record wherever that record is managed outside Symbiota.

Beeline had conflated the two. A field number is the per-specimen number
printed on a label (*Field number* in [CONTEXT.md](../../CONTEXT.md)): it goes
onto a pin in a museum drawer, becomes the stem of the museum's catalog number
in Ecdysis (`WSDA_2303966`), and travels to GBIF. It is **not** the catalog
number — that name belongs to the museum's identifier, and the confusion
between the two is what beeline-nfo ended. The first version of this ADR
nonetheless treated it as the specimen's *identity*, the thing every
downstream citation hangs from, and argued about whether it may ever move as
if the answer decided whether published records stay true. That is the
`occurrenceID`'s job, and Beeline has no `occurrenceID` of its own — **today,
and this ADR is the decision that changes it**. Everything in this Context
section describes the shape before that decision; what Beeline will do is the
Decision below.

### The reference implementation derives the permanent one from the mutable one

Oregon's `occurrenceID` is built *from* the field number —
`https://osac.oregonstate.edu/OBS/OBA_${fieldNumber}` in
`worker/src/handlers/ObservationsSubtaskHandler.js`, at `#indexOccurrences`
— so the identifier that must never change is a function of the one that is
allowed to. It is written only where the field is empty (an
`occurrence[occurrenceId] || …` guard), so a URI that later diverges from its
field number is never corrected: it fossilises, and then it names somebody
else's specimen.

One record from the production dump: field number `25055898`, occurrence
URI `https://osac.oregonstate.edu/OBS/OBA_25048415`. The number in the URI
is a different record's field number, and the seventeen records after it
carry the same offset of 7,483. That is one block of eighteen; the largest is
214 consecutive numbers (`25056482`–`25056695`) all offset by 6,899, and every
block falls inside `25055898`–`25057412`. Measured over the 383,032 records (2026-09-09): 592
carry an OSAC URI whose embedded number is not their own field number, and in
**every one** of the 592 that number is some other record's; they come in
consecutive blocks with a constant offset, all from 2025. Separately, 216
`occurrenceID` values sit on more than one record, 598 records in all: 210
OSAC URIs on 462 records, the widest (`…/OBA_25016980`) on 29, and 6 bare
numbers of unestablished origin on 136 records across three states, the widest
of those on 51. Whether the misembedded URIs and the duplicated ones share a
cause is **not** established — they overlap on 251 records, which is
suggestive and not proof, and the bare-number population looks different in
kind from either. The cause is not established, but the shape argues for one
hypothesis and against the obvious one. Constant offsets over contiguous runs
of field numbers are the fingerprint of a **misaligned assignment pass** — two
ordered sequences zipped together from different starting points, which
`#indexOccurrences` could produce by numbering over a differently ordered or
differently sized set than the one it wrote URIs for. The reference
implementation's sha256-over-mutable-business-data primary key, the first
suspect, would insert *duplicate rows* when a hashed field is edited; it would
not shift a whole block of URIs by a constant. Oregon
publishes to GBIF by hand and only after the embargo, so this is very likely
caught *before* publication; whether any of the 598 has already gone out is
an open question below. Filed as beeline-1kb.14.

### What staff have said

Phase 5 has to decide how a number behaves after it is printed. Two
questions turn out to be one — when a printed label disagrees with the record
behind it, is the replacement printed under the same number or a new one, and
is a number ever permanently retired — and staff have answered in opposite
directions. Andony, the program lead
([gh-17](https://github.com/rainhead/beeline/issues/17), 2026-08-31): *"Field
numbers are not voided, even if no physical specimen exists for a given
number"*, and the label system should *"support reprinting of existing IDs
when label metadata is updated"*. Arthur, who runs the printer (2026-09-08):
numbers *"have been permanently scrapped"*, and a label that disagrees with
its record is reprinted *"under a different field number"*.

They may be describing different cases. Arthur's wording — *"check which
label matches the information associated with a field number"* — only parses
if two labels already carry one number, which is duplicate resolution rather
than ordinary correction, and on that case the two accounts agree. But his
account of scrapped numbers is not about duplicates, so they cannot simply be
merged.

The data cannot break the tie
([field-number-history.md](../field-number-history.md)): 545 specimen
identities carry more than one number at the same coordinates, but 1,778 more
with differing coordinates are same-day duplicate sample numbers producing an
identical signature, so 545 is an upper bound and not a count of
renumberings. Exactly one number is provably duplicated, `25051768`,
and it was made by the reference generator reissuing a held number, not by
anyone's policy.

## Decision

**A specimen's identity downstream is an `occurrenceID` Beeline mints once
and never changes. The field number is a label identifier — a
`catalogNumber` in Darwin Core's terms — minted once, reused on reprint, and
replaceable at a known cost.** Beeline proceeds on Andony's account (Peter,
2026-09-09) for the field number, and the section after this one says why
that is now the simpler of two survivable options rather than the avoidance
of a catastrophe.

**One word does two jobs, so this ADR pins the mapping.** In this project's
own vocabulary, *catalog number* means the **museum's** identifier and ours is
the field number — that is the distinction beeline-nfo settled and it does not
change. `dwc:catalogNumber` is a different thing: a Darwin Core *field*, whose
role is "the collection's number for this specimen", and the field number is
what fills it in exports Beeline publishes. Both statements are true and they
are about different objects, a name and a slot.

| the thing | what it is | who mints it | may it change |
|---|---|---|---|
| `specimen.field_number` | Beeline's label identifier | Beeline | yes, at a known cost (4) |
| Beeline's `dwc:occurrenceID` | the record's permanent identity | Beeline, once | **no** |
| `dwc:catalogNumber` in Beeline's own exports | a slot, filled by the field number | — | follows the field number |
| Ecdysis `WSDA_…` | Washington's **museum** identifier — CONTEXT.md's *catalog number*, and Ecdysis's own `dwc:catalogNumber` | WSUC | the museum's business |
| OSAC's `…/OBS/OBA_<n>` URI | Oregon's `dwc:occurrenceID` today, and derived from the field number, which is the defect above | the reference implementation | it must not, and cannot help it |

Whether Ecdysis keeps deriving `WSDA_<field number>`, and whether it will
accept an `occurrenceID` Beeline supplies rather than minting its own UUID, is
open below — it is the museum's decision and not ours to make here.

1. **An `occurrenceID` is minted once per specimen, opaque, and independent
   of the field number.** It is issued at the same moment as the field
   number — print-run freeze, when the run creates the specimen records
   (*Specimen*, CONTEXT.md) — and is a function of nothing: not the field
   number, not the atlas, not the year. It never changes, and no operation
   exists to change it. It is the value Beeline publishes as
   `dwc:occurrenceID` and the one Ecdysis and GBIF are asked to cite. Its
   shape — a UUID, or a URI under a domain the program controls — is not
   decided here; what is decided is that nothing can be read out of it and
   that the field number is not in it.
2. **The field number is minted once and every reprint reuses it.** Lost,
   destroyed, never attached, or data found wrong after printing — the
   replacement carries the *same* field number. There is no correction
   reprint that renumbers. A reprint is a new print event, not a new
   identity, and downstream sees the same `occurrenceID` with the same
   `catalogNumber`.
3. **Nothing is voided.** A number whose specimen turns out not to exist
   stays issued and stays attached to its record. Beeline has no void, scrap
   or retire operation and no `voided` state; *Voided field number* in
   CONTEXT.md names a state the model does not need.
4. **A duplicate is repaired by minting forward, never by reassigning, and
   the old number is kept as `otherCatalogNumbers`.** Where two specimens
   carry one number, the one whose label matches its record keeps it, and the
   one whose label does **not** match is minted a new number. This is the
   only circumstance in which the number a specimen carries changes, and it
   is a repair to a defect rather than a lifecycle step. It is recorded as an
   authored event ([ADR 0007](0007-authored-changes-are-events.md)) naming
   both numbers. Downstream, this is exactly the case the vocabulary
   provides for: `catalogNumber` takes the new value, the old one goes into
   `otherCatalogNumbers`, the `occurrenceID` does not move, and GBIF sees the
   same record with two fields updated — no migration, no new `gbifID`, no
   broken link.
5. **Uniqueness is enforced by the database for every number Beeline mints**,
   and the mechanism is the one the project has already chosen: numbers are
   minted by inserting into `minted_field_number`, whose `field_number`
   PRIMARY KEY *is* the guarantee
   ([schema-sketch.md](../schema-sketch.md), phase 5). This is requirement 2,
   field-number uniqueness, in
   [reference-implementation.md](../reference-implementation.md); it was
   worded as *catalog-number* uniqueness until 2026-09-09, a leftover from
   before the vocabulary was settled, and was always about `fieldNumber`.

   One correction to that sketch, forced by (4). It keys the registry 1:1 to
   the specimen (`specimen_id NOT NULL UNIQUE`), which cannot survive a
   duplicate repair: minting the replacement number for a specimen that
   already holds a row either violates the UNIQUE or overwrites the row and
   loses the number that was burned. So the registry is **one row per minted
   number**, not per specimen — `field_number` stays the PRIMARY KEY and the
   guarantee, `specimen_id` is a plain reference, and which number a specimen
   currently carries is *derived*, exactly as `determination_of_record` is
   derived from append-only determinations (`schema/040`).

   "The latest row" needs something to order by, and the field number cannot
   supply it — (6) makes it opaque, and after a repair the replacement is not
   reliably the larger number. So the registry carries what
   `determination_of_record` carries: a `minted_at` timestamp **and** a draw
   from `entity_id_seq`, ranked `ORDER BY minted_at DESC, entity_id DESC`
   ([`schema/110`](../../schema/110_view_determination_of_record.sql) does the
   same, for the same reason — two determinations can share a second). The
   sequence is the tie-breaker that makes the answer deterministic rather than
   whichever row the engine happened to return, and it is monotonic across the
   whole store by [ADR 0002](0002-entities.md). It also has to survive the
   rebuild along with the rest of the registry, since an ordering rebuilt from
   scratch would renumber the history it is meant to order. That makes the registry append-only like every other
   authored history here, and it makes `otherCatalogNumbers` fall out for
   free: a specimen's superseded numbers are its non-current rows, which is
   the value Ecdysis and GBIF want published beside the current one.

   The two-table shape is not decoration. A `UNIQUE` on
   `specimen.field_number` cannot exist — `25051768` is on two imported rows —
   and the obvious repair, a partial unique index over minted rows only, is
   forbidden by [ADR 0001](0001-duckdb-first-with-portable-sql.md):
   PostgreSQL has them and DuckDB does not, and that ADR names
   `minted_field_number` as the dialect-neutral answer. So legacy numbers
   are **attributes** carried on the specimen and governed by nothing, while
   minted numbers are **rows in a registry** and governed absolutely. A
   number's provenance is then a fact about which table it appears in, rather
   than a flag anyone has to set.

   Two consequences follow and are decisions, not details. **The insert is the
   mint**: no code assigns a field number except by inserting that row, and a
   number absent from the registry was not minted by Beeline. And a print run
   cancelled after minting leaves its numbers **burned**: gaps are harmless
   and reuse never is ([field-number-history.md](../field-number-history.md)
   counts ~86,000 already).

   **What the registry does not guarantee, and what does.** Its PRIMARY KEY
   compares registry rows to each other, so it stops two *minted* numbers
   colliding and nothing else. It cannot see `specimen.field_number`, where
   383,031 imported numbers live — so on its own it would happily mint
   `1900001` onto a second bee while the first wears that number on a pin in a
   drawer. No engine-level constraint closes that: a cross-table exclusion is
   not portable, and the partial index is forbidden above. So the rule is
   stated rather than enforced: **a mint never lands on a number the imported
   corpus already uses**, whose ceiling is `26072091`.

   This decides nothing about the *shape* of new numbers, and deliberately so
   — that is a printing question, per (6). Continuing to seed each season from
   the year is safe and stays available: `27000001` clears the imported
   ceiling by 927,910, and the busiest year on record printed 76,409 labels,
   so a year's block has an order of magnitude of headroom. What the rule
   forbids is narrower and is a live hazard in the blow-away era rather than a
   hypothetical: the reference implementation falls back to the year *when the
   scan finds nothing to increment from*, and a rebuilt or reseeded store has
   an empty registry beside a full corpus. Seeding from the year alone would
   then have picked `26000001` during 2026 — squarely inside the imported `26`
   block. So the seed is taken from the imported corpus as well as the
   registry, never from the registry alone.

   And because a stated rule is a rule somebody breaks, it is checked the way
   this project checks everything the engine cannot hold: a view of minted
   numbers that collide with an imported one, asserted empty by test, the same
   shape as `sample_elevation_stale` and `sample_primary_collector_invalid`.

   **Both identifiers are authored data and must outlive a rebuild.** This is
   not a new rule; it is the one *Data handling* in
   [CONTEXT.md](../../CONTEXT.md) already states, with field numbers as its
   own first example: what Beeline mints exists nowhere else, and a rebuild
   must not recompute it. A registry living only inside the store would break
   the burn guarantee above in a way nothing would notice — a number minted
   for a print run that was then cancelled sits in the registry and on no
   specimen, so it is in neither the registry nor the corpus after a
   `db:reseed`, and the next mint issues it again. The specimen it was burned
   for may by then be on somebody's bench. The `occurrenceID` is the same
   kind of fact and the more urgent case of it: a field number lost to a
   rebuild is on a pin and can be read back, but an `occurrenceID` lost to a
   rebuild exists in GBIF and nowhere else, and reminting it is precisely the
   changed-identifier event GBIF pauses ingestion over. So both survive the
   blow-away, by the route the store already has for facts promotion cannot
   recompute (`CARRIED_TABLES` in `src/reseed-store.ts`, where `inat_place`
   sits for the same reason) or by the route corrections and the change logs
   take, outside the store altogether ([ADR 0004](0004-correction-overlay.md),
   [ADR 0007](0007-authored-changes-are-events.md)). Which of the two is an
   implementation question for phase 5; that it is one of them is not.
6. **A field number is opaque, and so is an `occurrenceID`.** No code parses
   a season, a year, an atlas or a project out of either. The two-digit prefix
   is the year the printer ran and disagrees with the collecting season on
   38,842 records; the `E` prefix is part of the identity and is never
   stripped, since 411 of those numbers collide with plain ones without it.
   Whether new numbers continue the eight-digit shape is a printing question
   and not decided here; whatever the shape, nothing reads it. The
   reference implementation's habit of reading the field number back *out of*
   a downstream identifier — `WSDA_` stripped from Ecdysis's `catalogNumber`,
   `OBA_` embedded in the OSAC URI — is the habit this rule ends: the join
   from a downstream record to a specimen is by `occurrenceID`.
7. **Print runs are events with durable history** — what was printed, when,
   on which sheet, from which data (requirements 5 and 6 in
   [reference-implementation.md](../reference-implementation.md)). This is
   what makes (2) safe. Once a wrong label and its corrected reprint carry the
   same number, the number cannot say which physical label is current or
   which sheet the wrong one went out on; only the print history can. That
   need begins with the first label Beeline prints and has nothing to do with
   the historical corpus, all of which is printed and finished — when a
   pre-2026 label was printed is not a question anyone needs answered
   (Peter, 2026-09-09).

## What the research undercut

The first version of this ADR argued against renumbering partly on the ground
that, on Arthur's account, *"every catalog number in Ecdysis is one correction
away from being stale"* and *"every catalog number already published becomes
perishable"* — that a renumbering was a standing obligation to tell the
museum and GBIF about a retired identifier, which nobody had designed. Those
sentences are kept here because they were the argument, and the research
undercut them. They were true of the reference implementation, where the only
persistent identifier is a function of the field number and a renumbering
really does orphan the URI. With an `occurrenceID` of Beeline's own they are
much less true: a renumbering costs an `otherCatalogNumbers` entry, which is
what the field is for, and GBIF sees the same record with an updated
`catalogNumber`. There is no migration and no broken link. The staleness
argument was an artefact of the conflation this reframing removes.

What survives against renumbering is the **physical** argument, and it is
real but weaker. A specimen already pinned to a label saying `25051768`,
reprinted under `26000412`, is a pin that may wear two labels with two
numbers and nothing on it to say which is current — where under reuse the two
agree and the stale one is redundant rather than ambiguous. Whether the old
label ever comes off is question 2 in [questions.md](../questions.md), and
nobody has said it does. That is a reason to prefer reuse; it is not the
reason the previous version gave, and it does not carry the weight the
previous version put on it.

So the gh-17 question is considerably less consequential either way than
this ADR first said. If Arthur's account is the practice, the model needs a
renumbering event beyond the duplicate repair in (4), the reprint screen needs
to offer it, and `otherCatalogNumbers` becomes routine rather than
exceptional — and that is the whole cost. Beeline still proceeds on Andony's
account, because it is the program's stated policy, it is independently the
rule the project had already reasoned its way to (beeline-1kb.5), and it is
the simpler of the two: nothing to renumber, nothing to explain to a collector
holding a label whose number the store no longer shows, and the print history
in (7) already answers which label is right. But the previous version
presented it as the difference between a stable archive and a perishable one,
and that overstated the stakes.

## Consequences

**Downstream identity is stable regardless of what happens to the number.**
Ecdysis's `catalogNumber` and Oregon's occurrence URI are no longer *derived*
from the field number in the sense of being recomputable from it: the museum's
number may still be shaped `WSDA_<field number>` because that is what WSUC
expects, but the record it belongs to is found by `occurrenceID`. Question 5
in [questions.md](../questions.md) — how Ecdysis and GBIF learn of a retired
number — dissolves in the ordinary case, and in the duplicate repair of (4) it
is answered by the vocabulary itself rather than by an obligation this project
has to design.

**The Oregon URI form has to be decided with OSAC, not inherited.** Beeline
cannot keep emitting `https://osac.oregonstate.edu/OBS/OBA_<field number>` as
an `occurrenceID` and satisfy (1), because that form *is* the field number.
Either OSAC keeps that URI as a catalog-number-like alias and Beeline's own
identifier is the `occurrenceID`, or OSAC's URI takes an opaque stem, or the
program controls a domain of its own. Open question below.

**Which label is right is a question for the print history, not the number.**
The latest print event for a specimen carries the intended label. That is a
requirement on the print-run model rather than a side effect, which is why (7)
is in the decision and not in the roadmap.

**A stale label on a pin is benign.** Nothing says a superseded label comes
off, and whether the swap is ever confirmed is question 2 in
[questions.md](../questions.md), which this ADR does not close. Under this
rule a stale label and its replacement say the same number, so the specimen
stays identifiable either way.

**Proofing has to answer with every specimen a number matches.** Historical
numbers are not unique and one pair was printed twice, so the field-number
lookup the operator proofs against must return all of them beside the print
run each label came from (requirement 6). A single-row answer proofs an
arbitrary one, which is how `25051768` passed twice.

**The corpus is inherited as it is, and now that includes its
`occurrenceID`s.** Five identifier eras, roughly 86,000 skipped numbers, 411
`E` numbers that collide when the letter is stripped, one live duplicate, one
ghost record, and 598 records sharing an `occurrenceID` with another. None of
it is repaired by this decision and none of it is a worklist; historical
records keep what they have. The imported `occurrenceID`s in particular are
kept verbatim, because some may already be published and the one thing worse
than a duplicated identifier is a migrated one nobody told GBIF about. What to
do with the 598 is beeline-1kb.14, and the answer depends on the last open
question below.

**If Arthur's account is the practice, this ADR changes at (2) and (4) and
the cost is bounded.** Should gh-17 come back saying that a correction reprint
does renumber — as ordinary practice, not only as duplicate repair — then
renumbering becomes an ordinary authored event, `otherCatalogNumbers` becomes
a routine export column, and beeline-1kb.5 reopens on that narrower question.
Nothing about (1), (5), (6) or (7) moves. That is why the status is proposed,
why the confirmation has to be sought from both of them in the same
conversation (question 4 in [questions.md](../questions.md)), and why the
reprint path in phase 5 should not be built until it lands — but it is also
why the rest of phase 5 need not wait.

## Open questions

Beyond gh-17, which this ADR inherits, the reframing opens three, none of
which this project can answer alone:

1. **Does OSAC want to keep issuing the `https://osac.oregonstate.edu/OBS/OBA_`
   URI form for Oregon specimens?** Under (1) it cannot be the
   `occurrenceID`, since it embeds the field number. It can be a catalog
   number, an alias, or retired for new records. This is a question for OSAC
   through Andony, and it decides what Beeline's Oregon export carries in
   which column.
2. **What do Ecdysis and WSUC expect for Washington?** The museum's
   `catalogNumber` is `WSDA_`-prefixed and the reference implementation reads
   the field number back by stripping the prefix. Under this ADR the join is
   by `occurrenceID`, which means Ecdysis has to carry Beeline's rather than
   mint its own — Symbiota will generate a UUID where none is supplied and
   advises keeping it with the canonical record, which is the wrong way round
   for a record whose canonical home is Beeline. Whether the Washington
   import accepts a supplied `occurrenceID`, and whether anyone at WSUC minds
   the catalog number continuing to be shaped from the field number, is a
   question for whoever runs the Ecdysis side.
3. **Have any of the 598 records already been published?** Oregon publishes
   to GBIF by hand and after the embargo, so probably not — but it is a
   probability rather than a fact, and the repair for a duplicate that has
   gone out (a supplied old→new list, per GBIF's migration route) is
   different from the repair for one that has not (fix it before it does).
   Andony can answer this from the publication history.

## Alternatives considered

**Derive the `occurrenceID` from the field number**, as the reference
implementation does. Rejected: it is the conflation this ADR exists to undo.
Every cost the first version attributed to renumbering — a perishable
published identifier, a standing notification obligation — is a cost of this
derivation, not of renumbering, and the 592 fossilised URIs are what it does
in practice.

**Renumber on correction.** No longer rejected on the ground that every
published catalog number becomes perishable — see *What the research
undercut*. Not chosen because reuse is simpler and is the program's stated
policy, and because a pin wearing two labels with two numbers is an ambiguity
where two labels with one number are a redundancy. Kept for the one case
where there is no alternative, duplicate repair.

**Compound identity `(atlas, field number)` forever.** Considered because
history is not globally unique. Rejected for new numbers: there is one
production deployment and one sequence, so a constraint is enough, and a
compound key would propagate into every downstream identifier to solve a
problem only the archive has — and under (1) it would be solving it in the
wrong identifier anyway. Historical data is handled as historical data.

**Split on case — reuse for ordinary corrections, renumber where Arthur's
account applies.** Tempting, since his wording may be about duplicates all
along, and (4) already carves that case out. Rejected as a reconciliation
made *for* staff rather than *with* them: it would encode an agreement
nobody has confirmed, and the failure mode is Beeline quietly doing something
neither of them described.
