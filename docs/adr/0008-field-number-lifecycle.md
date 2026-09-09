# ADR 0008: A field number is minted once and never moves

**Status:** **proposed** (2026-09-09) · needs Andony's confirmation on
[gh-17](https://github.com/rainhead/beeline/issues/17) before it is accepted ·
evidence in [field-number-history.md](../field-number-history.md) · phase 5
(beeline-1kb) is gated on it

## Context

Beeline mints field numbers, prints them on labels, mails them, and they end up on pins in museum drawers and in Ecdysis and GBIF. It is the only identifier the system issues that it cannot take back. Everything else about a record is correctable; this is not.

Two questions have to be answered before any of phase 5 can be built, and they are the same question twice:

1. When a printed label turns out to disagree with the record, is the replacement printed under the **same** number or a **new** one?
2. Is a number ever permanently retired?

Staff have given opposite answers. Andony, the program lead ([gh-17](https://github.com/rainhead/beeline/issues/17), 2026-08-31): *"Field numbers are not voided, even if no physical specimen exists for a given number"*, and the label system should *"support reprinting of existing IDs when label metadata is updated"*. Arthur, who runs the printer (2026-09-08): numbers *"have been permanently scrapped"*, and a label disagreeing with the record is reprinted *"under a different field number"*.

They may be describing different situations — Arthur's wording, "check *which* label matches the information associated with a field number", only parses if two labels already carry one number, which is duplicate resolution rather than ordinary correction. But his separate account of scrapped numbers is not about duplicates, so the two cannot simply be merged.

What hangs on it is not a schema detail. On Andony's answer, a field number is the **specimen's** identity and a `catalogNumber` already published to GBIF stays true forever. On Arthur's, a field number is a **label's** identity, a specimen wears several over its life, and every catalog number in Ecdysis is one correction away from being stale — which makes retirement notification to downstream a standing obligation nobody has designed.

The data cannot break the tie. 545 specimen identities carry more than one number at the same coordinates, but 1,778 more with differing coordinates are duplicate sample numbers producing an identical signature, so 545 is an upper bound and not a measurement ([field-number-history.md](../field-number-history.md)).

## Decision

**A field number is minted once, belongs to its specimen, and never moves.** This follows Andony's account (Peter, 2026-09-09) — he is the program lead with the longest view, and it is independently where the project had already reasoned itself to (beeline-1kb.5).

1. **Minting is once per specimen, at print-run freeze.** Specimens are individuated by printing; the run mints the numbers. A specimen that has a number keeps it for life.
2. **A reprint reuses the number.** Every reprint — lost label, destroyed label, never attached, or data found wrong after printing — prints the *same* field number. There is no "correction reprint" that renumbers. The reprint is a new **print event**, not a new identity.
3. **Nothing is voided.** A number issued to a specimen that no longer exists stays issued and stays attached to its record. Beeline has no void, scrap, or retire operation, and no `voided` state on a number.
4. **Duplicates are repaired by minting forward, never by reassigning.** Where two specimens already carry one number, the one whose label matches the record keeps it and the other is minted a **new** number — the only circumstance in which a specimen's number changes, and it is a repair to a defect rather than a lifecycle step. It is recorded as an authored event ([ADR 0007](0007-authored-changes-are-events.md)) naming both numbers, because it is the one case where a published catalog number does go stale and downstream has to be told.
5. **Uniqueness is enforced by the database going forward**, per [reference-implementation.md](../reference-implementation.md) requirement 2 — a sequence and a constraint, not an advisory max-scan. Historical numbers are exempt: they are not unique, across five identifier eras, and cannot be made so.
6. **A field number is opaque.** No code parses a season, a year, an atlas, or a project out of it. The two-digit prefix looks like a year and is the print year at best and a counter artifact at worst; the `E` prefix is part of the identity and is never stripped.
7. **Print runs are events with durable history** — what was printed, when, from which data — so a later correction can name the physical labels it invalidates. This is the mechanism that makes (2) safe: reusing the number is only honest if the system can say which sheet the wrong label went out on.

## Consequences

**A specimen's identity is stable, which is the whole point.** `catalogNumber` in Ecdysis and the OSAC occurrence URI are derived from the field number and stay true for the life of the specimen. There is no retirement notification to design, and question 5 in [questions.md](../questions.md) — how Ecdysis and GBIF learn of a retired number — dissolves, except in the duplicate-repair case of (4), where it is a real and narrow obligation.

**Correctness moves from the number to the print history.** If a number never changes, then "which label is currently right?" cannot be answered by looking at the number, and must be answered by the print run: the latest print event for a specimen carries the intended label. That is a requirement, not a side effect, and it is why (7) is in the decision rather than in the roadmap.

**The physical world can disagree with us and we will not always know.** A wrong label may stay on a pin because nobody removed it; whether that swap is ever confirmed is [open](../questions.md), and this ADR does not pretend to close it. Reusing the number makes the failure mode benign — a stale label and a fresh label say the same number, so the specimen is still identifiable — which is a genuine argument for this decision over Arthur's, where the two labels would disagree and the pin becomes ambiguous.

**We inherit a history this rule was never applied to.** Five identifier eras, ~86,000 skipped numbers, 411 `E` numbers that collide with plain ones if the letter is stripped, one live duplicate, and 61% of the corpus whose print date is a backfilled 31 December. None of that is repaired by this decision; it is bounded by it. Historical records keep what they have, and code that reads them assumes nothing.

**If Arthur is right, this ADR is wrong and the cost is real.** Should gh-17 come back saying correction reprints do renumber in practice, then voiding needs first-class events, downstream notification needs designing, and `beeline-1kb.5` reopens. That is why this is **proposed** and not accepted, and why nothing in phase 5 should be built against it until the confirmation lands.

## Alternatives considered

**Renumber on correction (Arthur's account).** Rejected as the *default* on the grounds above — chiefly that it makes every published catalog number perishable and turns a pin bearing two labels into an ambiguity rather than a redundancy. Kept in the one place it is genuinely needed, duplicate repair, where there is no alternative.

**Compound identity `(atlas, field number)` forever.** Considered because history is not globally unique. Rejected for *new* numbers: there is one production deployment and one sequence, so a constraint is enough, and a compound key would propagate into every downstream system to solve a problem only the archive has. Historical data is handled as historical data.

**Treat the two accounts as both true, splitting on case.** Tempting, since Arthur's wording may be about duplicates all along. Rejected as a decision to make *for* staff rather than *with* them: it would encode a reconciliation nobody has confirmed, and the failure mode is that Beeline quietly does something neither of them described.
