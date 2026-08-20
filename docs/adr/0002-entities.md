# ADR 0002: Entities — one identity space for the whole model

**Status:** accepted (2026-08-20) · **Review:** pre-cutover audit (beeline-27c)

## Context

The model needs to talk *about* its own rows: corrections name the row they
amend, QC waivers name what they excuse, notification and audit events will
name what they concern. With per-table id sequences, such a reference needs a
`(table, id)` pair, `id` values collide across tables, and a bare id in a log
or a debugger means nothing until you guess its table. Datomic demonstrates
the alternative: one identity space, where an id *is* a name.

## Decision

**An entity is anything the system may need to refer to from outside its own
table** — to correct it, excuse it, audit it, or notify about it. All entity
ids are drawn from the single global `entity_id_seq`, so an id names exactly
one thing in the whole model, forever.

### Norms

- **Entity tables** name their primary key **`entity_id`**. Current entities:
  `person`, `atlas`, `animal`, `sample`, `specimen`, `determination`,
  `elevation_source`.
- **Facet tables** extend an entity 1:1 and have no identity of their own:
  their primary key is the parent's entity id, named for the parent
  (`inat_account.person_id`, `sample_location.sample_id`). A correction to a
  facet field targets the *parent's* entity id — facets are attributes of the
  entity, not entities.
- **References** are named `<role>_id` (`collector_id`, `sample_id`,
  `atlas_assigned_by`) and are FKs to a specific table's `entity_id`.
- **Polymorphic references** — columns that may point at any entity — are
  named **`entity_id`** (the future `correction.entity_id`). The name is the
  contract: any column named `entity_id` holds a value from the global space
  and is that row's identity or its target's.
- **Named configuration is not an entity**: `qc_rule` is keyed by its name;
  rules are code-adjacent definitions, referenced by name in findings.
- The sequence hands out plain INTEGERs (~400k entities/year against a 2.1B
  range); dialect-neutral per [ADR 0001](0001-duckdb-first-with-portable-sql.md).

### What this buys

- A bare id in a finding, a log line, or a correction row is unambiguous.
- `JOIN a ON a.entity_id = b.entity_id` is visibly wrong (two entities are
  never the same thing), where `a.id = b.id` reads plausibly.
- Polymorphic tables need no `(entity_type, id)` discriminator pair for
  *identity* (a type column may still aid querying).

### Deliberately not (yet)

A registry table (`entity(entity_id, kind)` that every table FKs into) would
give polymorphic references real referential integrity, at the cost of a
second insert per row. Not adopted until a polymorphic reference actually
needs enforcement — corrections, when they return.

## Consequences

- **Pre-cutover audit** (tracked as a bead): before ids become forever,
  re-ask which tables want to be entities. Known candidates from the sketch:
  `printed_label` (a physical label wants identity the moment the
  artifact-lifecycle questions — scrapped, superseded, voided — get answers),
  `print_run`, `qc_waiver`, `correction`, and the trap-site entities when
  staff answers arrive. `minted_catalog_number` keeps its natural key (the
  number is the identity; it references its specimen's entity id).
- Promotion pipelines allocate from the same sequence (`nextval` in CTAS),
  so ingested and app-created rows share the space.
