# Beeline

A rebuild of the specimen-cataloging and label-printing system for the Master Melittologist program (OSU Extension) and its member bee atlases: Oregon, British Columbia, Washington, Idaho, New Mexico, Oklahoma.

**Status: sandbox.** This repository currently exists to design the replacement data model. The production system it will replace lives at [oregon-bee-project/OBP-Server](https://github.com/oregon-bee-project/OBP-Server/); [docs/reference-implementation.md](docs/reference-implementation.md) records how that system actually works and the requirements those findings imply.

**Timeline.** The atlases follow the field season, so the goal is production use for the **2027 season**. 2026 is for building the system and building confidence in it: training people, and running it **in parallel with the reference system** — collecting continues through September and tapers into November–December — comparing the two systems' outputs. An early deliverable is a **re-runnable ingestion pipeline** over the existing (soon: historical) data, cheap to iterate on. Prior years stay in active use — many determinations arrive one to three years after collection — so freezing data past a certain age is a possible tool, never an assumption.

## The two jobs

1. **Catalog of record for specimens.** Volunteers and staff collect bees (by net or trap); Beeline creates and governs the specimen records, assigns catalog numbers, and records taxonomic determinations by volunteers and experts. Downstream systems — reporting, GBIF, Ecdysis — consume these records.
2. **Label governance.** Printing pinned-specimen labels accurately and exactly once per specimen: ensuring data quality before printing, guaranteeing catalog-number uniqueness, and identifying which physical labels a later data correction invalidates.

Domain vocabulary lives in [CONTEXT.md](CONTEXT.md). The first schema sketch is [docs/schema-sketch.md](docs/schema-sketch.md); the build order toward cutover is [docs/roadmap.md](docs/roadmap.md). Downstream consumers and the scopes planned to build on this system are in [docs/surrounding-systems.md](docs/surrounding-systems.md); open questions for staff are in [docs/questions.md](docs/questions.md). Architectural decisions will live in `docs/adr/`.

## Principles

- **Cheap to run, few moving parts, easy to reason about.** When something goes wrong, both operators and users should be able to see what happened and recover.
- **Lean on the database.** Express data relationships, constraints, and derivations in the database (views, constraints, history tables) rather than imperative TypeScript. Consistency must come from the data model, not from having exactly one careful operator.
- **Self-service.** Collectors sign in (via iNaturalist), see the data-quality issues assigned to them, understand what to do, and resolve them in one session — replacing weekly hand-assembled email digests.
- **Domain-driven, plainly worded.** We follow the values of Domain Driven Design without burdening readers with its vocabulary.

## Open technology questions

- DuckDB vs PostgreSQL as the primary store: DuckDB promises fast iteration (in-memory testing, easy ingestion) at some risk from its development velocity. The deciding constraint and the decision point are in the [roadmap](docs/roadmap.md#duckdb-vs-postgresql).
