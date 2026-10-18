# ADR 0004: Corrections are a three-way-merge overlay anchored on loads

**Status:** accepted (2026-08-21) · **Review:** before the self-service QC
phase builds the correction table ([roadmap](../roadmap.md) phase 4) ·
**Reviewed** (2026-08-22, beeline-2c3.8): the frozen-upstream store now
exists — in-app sample edits write correction events to `data/corrections.csv`
(outside the blow-away path; [src/corrections.ts](../../src/corrections.ts)),
read at promotion union the git-curated CSV with app rows winning per
(record, field). The correction table for *synced iNat observations* still
waits. **Reviewed** (2026-09-25, beeline-649): its first instance exists
without the table — a staff locality over an iNat-linked sample lives in
`data/sample-overlay.csv` ([src/sample-overlay.ts](../../src/sample-overlay.ts)),
keyed by observation id rather than by load, with the base recorded as the
locality the observation yielded at the time. The merge is this ADR's with
one simplification: a conflict is a view
(`sample_locality_override_diverged`) shown on the sample page, not a QC
finding, and nothing auto-retires — the override stands until a person
removes it. **Amended** (2026-10-17, beeline-9z4): no correction
auto-retires either; upstream arriving at the corrected value is the
correction applying. See *Nothing retires a correction but a person* below.

## Context

The pipeline is a pure, re-runnable transform over append-only observation
loads ([schema/060](../../schema/060_sync.sql)). A staff or volunteer
correction must survive every re-run — and must not silently clobber, or be
clobbered by, an upstream edit that arrives in a later load. The schema
sketch left this open: *"take upstream when upstream changed and we didn't
correct; keep the correction otherwise; surface a conflict when both
moved."* Two correction populations share this shape: synced iNat
observations (this ADR) and frozen legacy staging rows (beeline-uuu), where
upstream never moves — the degenerate case.

Loads are entities (ADR 0002) precisely so corrections can anchor on them.

## Decision

**A correction is an append-only event anchored on the load the corrector
saw. That load is the merge base — no stored old value plays any role in
merging.** Per (observation, field), promotion resolves:

| upstream (theirs vs base) | result |
|---|---|
| unchanged | correction applies |
| changed **to** the corrected value | correction applies (the two agree, so nothing changes) |
| changed to a third value | **the correction stands** — a deliberate human assertion beats an unreviewed upstream edit — and a `correction_conflict` QC finding opens showing both values |

- **Field vocabulary is the typed extraction view's columns**
  ([schema/105](../../schema/105_views_observation.sql)): corrections name
  the seam's fields, never raw JSON paths. Renaming an extraction column is
  thereafter a migration of corrections.
- **Conflicts never auto-resolve.** The finding is the workflow; resolving
  means a human writes a *new* correction whose base is the current load —
  re-asserting the value or accepting upstream. Resolution is recorded,
  never an edit: the new correction replaces the old one for that field.
- **The overlay applies at promotion**, over the latest load, before model
  entities are written — the same point where legacy corrections apply to
  staging (beeline-uuu). Downstream (QC rules, promotion) reads one
  relation: the corrected extraction view layered on
  `observation_current_fields`.

## Consequences

- The correction table itself waits for the self-service phase; nothing in
  the sync schema needs to change now — anchoring on load entities already
  works, which is what this ADR fixes in place.
- `correction_conflict` enters the QC rule metadata as a warning: the model
  already shows a human-asserted value, so printing needn't block on
  upstream noise; staff re-review at their pace.
- Because the base is a load row, the merge is evaluable for any past state:
  the same three-way rule re-derives identically on every re-run — no
  correction ordering or timestamp arithmetic involved.
- Legacy staging corrections (beeline-uuu) are this shape with a frozen
  upstream: base = the staged row, theirs never moves, so they simply always
  apply. One table, one rule.

## Nothing retires a correction but a person (amended 2026-10-17, beeline-9z4)

As accepted, the table's second row said that when upstream changed **to**
the corrected value, the correction **auto-retired**: it was superseded by
that load, upstream was taken from then on, and a one-way
`superseded_by_load_id` latch, set once by promotion, recorded it. That row is gone. The correction now applies
when upstream agrees with it, which changes nothing that day, and it goes on
governing the field until a person writes a new correction in its place.

The reason is what retirement does to the person who asserted the value. Once
upstream happened to agree, the system stopped honouring their correction
without anyone deciding so, and a later upstream edit would then have been
taken silently instead of opening a conflict. A correction is a deliberate
human assertion, and the table already says that beats an unreviewed upstream
edit; retirement was the one place an upstream edit could end it.

It also never had a case to serve. The correction table for synced iNat
observations was never built, and the only implemented instance is the legacy
one, whose upstream is frozen and so cannot converge. The staff locality and
coordinate override over iNat-linked samples (beeline-649, beeline-942) had
already chosen to do without it.

What the retire branch did carry was reverting an in-app edit (beeline-eef):
editing a field from X to Z and back to X writes a correction whose base and
new value both equal the staged X, and that row was classified as retired. It
now classifies as applying, which writes X over X. The rule is therefore
that a correction applies when upstream equals either its base or its
corrected value, and is in conflict otherwise. No status `retired` exists
([ingest/promote-legacy.sql](../../ingest/promote-legacy.sql),
`legacy_correction_state`), and the legacy promotion report no longer counts
retired corrections.
