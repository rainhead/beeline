# ADR 0004: Corrections are a three-way-merge overlay anchored on loads

**Status:** accepted (2026-08-21) · **Review:** before the self-service QC
phase builds the correction table ([roadmap](../roadmap.md) phase 4) ·
**Reviewed** (2026-08-22, beeline-2c3.8): the frozen-upstream store now
exists — in-app sample edits write correction events to `data/corrections.csv`
(outside the blow-away path; [src/corrections.ts](../../src/corrections.ts)),
read at promotion union the git-curated CSV with app rows winning per
(record, field). The correction table for *synced iNat observations* still
waits.

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
| changed **to** the corrected value | correction **auto-retires** (superseded by that load); upstream is taken from here on |
| changed to a third value | **the correction stands** — a deliberate human assertion beats an unreviewed upstream edit — and a `correction_conflict` QC finding opens showing both values |

- **Field vocabulary is the typed extraction view's columns**
  ([schema/105](../../schema/105_views_observation.sql)): corrections name
  the seam's fields, never raw JSON paths. Renaming an extraction column is
  thereafter a migration of corrections.
- **Conflicts never auto-resolve.** The finding is the workflow; resolving
  means a human writes a *new* correction whose base is the current load —
  re-asserting the value or accepting upstream. Resolution and retirement
  are recorded, never edits: a retired correction keeps a one-way
  `superseded_by_load_id` latch, set once by promotion.
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
