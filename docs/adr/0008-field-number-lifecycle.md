# ADR 0008: A field number is minted once and never moves

**Status:** **proposed** (2026-09-09) · awaits Arthur and Andony confirming it
together on [gh-17](https://github.com/rainhead/beeline/issues/17) · the
evidence is [field-number-history.md](../field-number-history.md) · phase 5
(beeline-1kb) is gated on it

## Context

A field number is the per-specimen number Beeline prints on a label
(*Field number* in [CONTEXT.md](../../CONTEXT.md)). It is the only identifier
the system issues that it cannot recall: it goes onto a pin in a museum
drawer, becomes the stem of the museum's catalog number in Ecdysis
(`WSDA_2303966`) and of Oregon's OSAC occurrence URI, and travels to GBIF. It
is **not** the catalog number — that name belongs to the museum's identifier,
and the confusion between the two is what beeline-nfo ended.

Phase 5 has to decide how a number behaves after it is printed, and two
questions turn out to be one:

1. When a printed label disagrees with the record behind it, is the
   replacement printed under the **same** number or a **new** one?
2. Is a number ever permanently retired?

Staff have answered in opposite directions. Andony, the program lead
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

What hangs on the answer is not a schema detail. On the first account a field
number is the **specimen's** identity, and a catalog number already published
downstream stays true for the life of the specimen. On the second it is the
**label's** identity: a specimen wears several over its life, and every
catalog number in Ecdysis is one correction away from being stale — which
makes telling the museum and GBIF about retirements a standing obligation
nobody has designed.

The data cannot break the tie
([field-number-history.md](../field-number-history.md)): 545 specimen
identities carry more than one number at the same coordinates, but 1,778 more
with differing coordinates are same-day duplicate sample numbers producing an
identical signature, so 545 is an upper bound and not a count of
renumberings. Exactly one number is provably duplicated, `25051768`,
and it was made by the reference generator reissuing a held number, not by
anyone's policy.

## Decision

**A field number is minted once, belongs to its specimen, and never moves.**
Beeline proceeds on Andony's account (Peter, 2026-09-09): it is the program's
stated policy, and independently the rule the project had already reasoned its
way to (beeline-1kb.5). Arthur's is recorded rather than discarded, because he
is the one who prints and because the two may be describing different cases.

1. **Minting is once per specimen, at print-run freeze.** Specimens are
   individuated by printing (*Specimen*, CONTEXT.md): the run creates the
   specimen records and mints their numbers. A specimen that has a number
   keeps it for life.
2. **Every reprint reuses the number.** Lost, destroyed, never attached, or
   data found wrong after printing — the replacement carries the *same* field
   number. There is no correction reprint that renumbers. A reprint is a new
   print event, not a new identity.
3. **Nothing is voided.** A number whose specimen turns out not to exist stays
   issued and stays attached to its record. Beeline has no void, scrap or
   retire operation and no `voided` state; *Voided field number* in
   CONTEXT.md names a state the model does not need.
4. **A duplicate is repaired by minting forward, never by reassigning.** Where
   two specimens carry one number, the one whose label matches its record
   keeps it, and the one whose label does **not** match is minted a new
   number. This is the only circumstance in which the number a specimen
   carries changes, and it is a repair to a defect rather than a lifecycle
   step. It is recorded as an authored event
   ([ADR 0007](0007-authored-changes-are-events.md)) naming both numbers,
   because it is the one case where a catalog number already published for
   that specimen goes stale and downstream has to be told.
5. **Uniqueness is enforced by the database for every number Beeline mints**,
   and the mechanism is the one the project has already chosen: numbers are
   minted by inserting into `minted_field_number`, whose `field_number`
   PRIMARY KEY *is* the guarantee, keyed 1:1 to the specimen
   ([schema-sketch.md](../schema-sketch.md), phase 5). This is requirement 2,
   field-number uniqueness, in
   [reference-implementation.md](../reference-implementation.md); it was
   worded as *catalog-number* uniqueness until 2026-09-09, a leftover from
   before the vocabulary was settled, and was always about `fieldNumber`.

   The two-table shape is not decoration. A `UNIQUE` on
   `specimen.field_number` cannot exist — `25051768` is on two imported rows —
   and the obvious repair, a partial unique index over minted rows only, is
   forbidden by [ADR 0001](0001-duckdb-first-with-portable-sql.md): PostgreSQL
   has them and DuckDB does not, and that ADR names `minted_field_number` as
   the dialect-neutral answer. So legacy numbers are **attributes** carried on
   the specimen and governed by nothing, while minted numbers are **rows in a
   registry** and governed absolutely. A number's provenance is then a fact
   about which table it appears in, rather than a flag anyone has to set.

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

   **The registry is authored data and must outlive a rebuild.** This is not a
   new rule; it is the one *Data handling* in [CONTEXT.md](../../CONTEXT.md)
   already states, with field numbers as its own first example: what Beeline
   mints exists nowhere else, and a rebuild must not recompute it. A registry
   living only inside the store would break the burn guarantee above in a way
   nothing would notice — a number minted for a print run that was then
   cancelled sits in the registry and on no specimen, so it is in neither the
   registry nor the corpus after a `db:reseed`, and the next mint issues it
   again. The specimen it was burned for may by then be on somebody's bench.
   So `minted_field_number` survives the blow-away, by the route the store
   already has for facts promotion cannot recompute (`CARRIED_TABLES` in
   `src/reseed-store.ts`, where `inat_place` sits for the same reason) or by
   the route corrections and the change logs take, outside the store
   altogether ([ADR 0004](0004-correction-overlay.md),
   [ADR 0007](0007-authored-changes-are-events.md)). Which of the two is an
   implementation question for phase 5; that it is one of them is not.

6. **A field number is opaque.** No code parses a season, a year, an atlas or
   a project out of one. The two-digit prefix is the year the printer ran and
   disagrees with the collecting season on 38,842 records; the `E` prefix is
   part of the identity and is never stripped, since 411 of those numbers
   collide with plain ones without it. Whether new numbers continue the
   eight-digit shape is a printing question and not decided here; whatever
   the shape, nothing reads it.
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

## Consequences

**A specimen's identity is stable, which is the point.** The catalog number in
Ecdysis and the OSAC occurrence URI are derived from the field number and stay
true for the life of the specimen. There is no retirement notification to
design; question 5 in [questions.md](../questions.md) — how Ecdysis and GBIF
learn of a retired number — dissolves, except in the duplicate repair of (4),
where it is a real and narrow obligation carried by the authored event.

**Which label is right is a question for the print history, not the number.**
The latest print event for a specimen carries the intended label. That is a
requirement on the print-run model rather than a side effect, which is why (7)
is in the decision and not in the roadmap.

**A stale label on a pin is benign.** Nothing says a superseded label comes
off, and whether the swap is ever confirmed is question 2 in
[questions.md](../questions.md), which this ADR does not close. Under this
rule a stale label and its replacement say the same number, so the specimen
stays identifiable either way — where renumbering on correction would leave a
pin bearing two numbers and no way to say which is the specimen's.

**Proofing has to answer with every specimen a number matches.** Historical
numbers are not unique and one pair was printed twice, so the field-number
lookup the operator proofs against must return all of them beside the print
run each label came from (requirement 6). A single-row answer proofs an
arbitrary one, which is how `25051768` passed twice.

**The corpus is inherited as it is.** Five identifier eras, roughly 86,000
skipped numbers, 411 `E` numbers that collide when the letter is stripped, one
live duplicate, and one ghost record. None of it is repaired by this decision
and none of it is a worklist; historical records keep what they have, gaps in
the sequence are not missing labels, and code reading historical numbers
assumes nothing about their shape.

**If Arthur's account is the practice, this ADR is wrong and the cost is
real.** Should gh-17 come back saying that a correction reprint does renumber
— as ordinary practice, not only as duplicate repair — then voiding needs
first-class events, notifying Ecdysis and GBIF of retired numbers needs
designing, and beeline-1kb.5 reopens. That is why the status is proposed, why
the confirmation has to be sought from both of them in the same conversation
(question 4 in [questions.md](../questions.md)), and why nothing in phase 5
that depends on (2)–(4) should be built until it lands.

## Alternatives considered

**Renumber on correction.** Rejected as the default on the grounds above:
every catalog number already published becomes perishable, downstream
notification becomes routine rather than exceptional, and a pin carrying two
labels becomes an ambiguity instead of a redundancy. Kept for the one case
where there is no alternative, duplicate repair.

**Compound identity `(atlas, field number)` forever.** Considered because
history is not globally unique. Rejected for new numbers: there is one
production deployment and one sequence, so a constraint is enough, and a
compound key would propagate into every downstream identifier to solve a
problem only the archive has. Historical data is handled as historical data.

**Split on case — reuse for ordinary corrections, renumber where Arthur's
account applies.** Tempting, since his wording may be about duplicates all
along, and (4) already carves that case out. Rejected as a reconciliation
made *for* staff rather than *with* them: it would encode an agreement
nobody has confirmed, and the failure mode is Beeline quietly doing something
neither of them described.
