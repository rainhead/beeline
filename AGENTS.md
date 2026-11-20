# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project. (CLAUDE.md is a symlink to this file.) `test/agents-md-size.test.ts` holds it under 12 KB: put detail that matters only for one kind of work in `docs/agents/` behind a pointer, not here.

## Build & Test

```bash
pnpm install
pnpm test                      # vitest, against in-memory DuckDB
pnpm typecheck
pnpm db:build [target.duckdb]  # blow away and rebuild from schema/*.sql; refuses a target that has printed
pnpm db:migrate [--status|--check|--baseline] [db]  # bring a deployed store forward (ADR 0006)
pnpm db:reseed <old.duckdb> <new.duckdb>  # re-derive a deployed store: fresh schema + its staging, then re-promote; refused once it has printed
pnpm app:dev                   # web app: tsx watch + vite build --watch (islands)
pnpm app:build && pnpm app:start  # web app, production shape
pnpm bench:pages [store]       # page latency against a copy of a store; --compare=<result.json> (bench/README.md)
pnpm bench:contention [store]  # pages, edits and the nightly overlapping: latency, and conflicts counted apart
pnpm store:query "<one SELECT>"  # ask last night's copy of the store a question; on production over fly ssh, with the app running (docs/runbooks/deploy-fly.md)
```

Populating a store end to end, from the old system, iNaturalist, elevation tiles, the gazetteer and Ecdysis, and checking a backup: the `populate-store` skill (`.claude/skills/populate-store/SKILL.md`).

## Architecture Overview

How each part of Beeline works is in [`docs/architecture/`](docs/architecture/README.md), one file per area, listed there with the source each covers. Read the file for the area you are about to change before changing it: each records the decisions and traps behind that code, with the issues and ADRs that carry them. When a change alters how an area works, update its file in the same pull request.

## Conventions & Patterns

- Build only what the current roadmap phase needs; the fuller domain sketch waits in [docs/schema-sketch.md](docs/schema-sketch.md) and is re-reviewed when its phase arrives.
- Keep DDL dialect-neutral (ADR 0001): `TEXT` + `CHECK` for enum-ish columns, `concat()`/`concat_ws()` over `||`, no partial unique indexes. **Never `~`**: DuckDB and Postgres answered it differently without erroring, so write `regexp_matches` (part of the string) or `regexp_full_match` (all of it). Before changing any `schema/*.sql` file or a migration, read [docs/agents/schema-conventions.md](docs/agents/schema-conventions.md): it names the three deliberate exceptions, the Postgres port decision, and the rules for entity ids, `COMMENT ON` and Kysely.
- `src/model.ts` (Kysely types) follows the SQL by hand: update it with any schema change. Kysely stays on 0.28.x until `kysely-duckdb` supports 0.29.
- A `TIMESTAMP` means UTC in every process. Write an instant as `current_timestamp` or `toISOString()`, never as a local-time string (the reason is in the schema-conventions doc above).
- Collectors are a list: `sample_collector` in `recordedBy` order, position 1 is the primary. There is no `sample.collector_id`; read the primary through `sample_primary_collector` and "my samples" through the list. The legacy name register is a report, not an authority or a worklist (Peter, 2026-08-28). Before changing how collectors or person names are modelled, promoted or read, read [docs/agents/collectors-and-people.md](docs/agents/collectors-and-people.md).
- Scientific names are split into parts in exactly one place, `ingest/parse-names.sql`; misspellings are curated only in `ingest/taxon-aliases.csv`. Before changing the parser or touching either file, read [docs/agents/scientific-names.md](docs/agents/scientific-names.md).
- **Report every check count split by season** (Peter, 2026-08-29): active seasons against settled ones, never one number, using the store's own line (`season.active_since` / `settled_sample`, `schema/102`) and not a hand-rolled date. A combined figure hides whether a defect is live or leftover. Definitions are under **Season** in CONTEXT.md; the reasoning and worked numbers are in [docs/agents/reporting-counts.md](docs/agents/reporting-counts.md), which also records the exception: the held-back and changes pages count by program.
- Tests run against in-memory DuckDB built from the real `schema/*.sql` (`createMemoryDb` from `test/helpers.ts`), so a schema mistake fails a test. Date a fixture that should be active or printed with `CURRENT_SEASON` or `currentSeasonDate`, and one that should have settled with `SETTLED_SEASON`, never a year written into the test. A test that builds the app spreads `scratchPaths()` into it, so it never writes the developer's own files under `data/`. Make temporary folders with `mkdtemp(join(tmpdir(), …))` and leave them: `test/global-setup.ts` deletes them when the run ends. Before writing or changing a test or fixture, read [docs/agents/testing.md](docs/agents/testing.md): it covers the shared-store rules, `createFileDb`, `promotedStore` and real-corpus assertions.

## Non-Interactive Shell Commands

Always use non-interactive forms: `cp`, `mv` and `rm` may be aliased to `-i` and hang waiting for a y/n answer.

```bash
cp -f source dest    # mv -f, rm -f; rm -rf and cp -rf for directories
```

Also: `scp` and `ssh` with `-o BatchMode=yes` (fail instead of prompting), `apt-get -y`, `HOMEBREW_NO_AUTO_UPDATE=1 brew`.

## Git Authority

**Agents may commit and push without asking, and work lands as a pull request** (2026-08-28). Branch, commit, push, open it with `gh pr create`, and stop there. No approval is needed to open one. Close the beads you finished when the PR merges.

- **Peter merges, not the agent that opened the PR** (since cutover, Peter, 2026-11-03). Minted field numbers are permanent, backups are mandatory and production is never reseeded (ADR 0006), so a merge wants a human reading it. GitHub's review approval cannot stand in, because `gh` opens every PR as Peter and an author cannot approve their own PR; this is a practice recorded here, not a branch protection. An agent that finds a green PR waiting leaves it waiting.
- **Do not commit or push to `main` directly**: nothing is reviewed on the way in that way.
- Peter's branches are reviewed locally with the CodeRabbit CLI before the PR is opened; the PR bot skips his PRs (`.coderabbit.yaml`) and still reviews everyone else's. Triage what it says: fix what is real, and give the reason in the PR when declining.
- Deploying production (`fly deploy -c fly.production.toml`, docs/runbooks/deploy-fly.md) is done when asked, never as the tail of a merge.
- **Beads make no commits at all** (Peter, 2026-10-23). Run `bd sync` without asking, after filing or changing issues and before ending a session (the SessionStart hook runs it too); it pushes the Dolt store over `refs/dolt/data`, and nothing in the working tree changes. The JSONL export is ignored; `bd export -o <file>` writes one when something needs it.
- Don't commit someone else's uncommitted work, don't rewrite published history, and keep documentation current in the same commit as the change it describes.

## Issue tracker and domain docs

- Two trackers, split by audience: GitHub Issues for discussion-shaped work, customer requests and bugs someone reported; beads (`bd`) for everything else, including bugs found while working. Where this disagrees with `.beads/PRIME.md` ("track work in beads"), [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) wins. Read it before filing an issue.
- Triage labels apply to GitHub Issues only: [docs/agents/triage-labels.md](docs/agents/triage-labels.md). Read it before labelling or triaging.
- Single-context domain docs: [CONTEXT.md](CONTEXT.md) and [docs/adr/](docs/adr/); see [docs/agents/domain.md](docs/agents/domain.md). The files in `docs/agents/` configure the engineering skills (written by `/setup-matt-pocock-skills`); edit them directly.

## Beads

How to track work in beads, the commands, and what to do before finishing are in [`.beads/PRIME.md`](.beads/PRIME.md), which `bd prime` prints. Claude Code's SessionStart hook runs `bd sync` and then `bd prime`, and Codex's hook adds PRIME.md to the session; if it did not appear when your session started (a subagent, or Codex without hooks), run `bd prime` before starting work. Don't run `bd setup` or `bd init` here: either writes a generic beads block back into this file, and that block contradicts the Git Authority section above. Beads data is public, like the repo, so don't use `bd remember`.
