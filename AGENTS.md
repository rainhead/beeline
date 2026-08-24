# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project. (CLAUDE.md is a symlink to this file.)

## Build & Test

```bash
pnpm install
pnpm test                      # vitest, against in-memory DuckDB
pnpm typecheck
pnpm db:build [target.duckdb]  # blow away and rebuild from schema/*.sql
pnpm db:migrate [--status|--check|--baseline] [db]  # bring a deployed store forward (ADR 0006)
pnpm app:dev                   # web app: tsx watch + vite build --watch (islands)
pnpm app:build && pnpm app:start  # web app, production shape
```

Populating a fresh database end to end (production access = `beeline` in
`~/.ssh/config`; iNat access = dev OAuth credentials in `data/secrets/`):

```bash
pnpm legacy:fetch && pnpm legacy:load && pnpm legacy:promote  # production Mongo → model
pnpm inat:login                             # OAuth sign-in; mints the 24h JWT sync reads
pnpm inat:sync <projectId> [d1] [d2]        # observation window → append-only loads
pnpm inat:promote                           # current observation state → samples
pnpm inat:backfill-accounts                 # resolve legacy logins → iNat accounts
pnpm elevation:fetch && pnpm elevation:derive  # DEM tiles (legacy SRTM archive, Copernicus GLO-30 fallback) → missing elevations
```

## Architecture Overview

The schema **is** the `schema/*.sql` files, applied in filename order (0xx tables, 1xx derived views). Databases are blown away and rebuilt before cutover ([docs/roadmap.md](docs/roadmap.md)); the ones that can't be — the sandbox, production later — catch up through `migrations/NNNN-slug.sql` and `pnpm db:migrate`, recorded in `schema_migration` and stamped (never run) on a fresh build ([ADR 0006](docs/adr/0006-migrations-for-deployed-stores.md)). QC rules, printability, and determination-of-record are SQL views, not app code. Engine: DuckDB behind dialect-neutral SQL — [ADR 0001](docs/adr/0001-duckdb-first-with-portable-sql.md). The web app (`src/app/`) is the process that owns the database — [ADR 0005](docs/adr/0005-app-process-owns-the-store.md): Hono with `hono/jsx` SSR views, Lit light-DOM islands built by Vite, MD3 color tokens generated from a seed (`src/app/theme/tokens.ts`), every route session-gated by construction; `/design` is the design system (component library in `src/app/views/components/`, stylesheets split `elements`/`layout`/`components` under `src/app/static/`, every section rendering live from the real tokens), and `/glossary` is its volunteer-facing counterpart. Auth is iNat OAuth; sessions and OAuth tokens live in the attached private store ([ADR 0003](docs/adr/0003-private-data-store.md)), whose schema is `schema/private/*.sql`, applied by the app at boot when missing. Browsing lives at `/samples` and `/specimens` (`src/app/listings.ts` + `src/app/views/listings.tsx`, beeline-2c3.21): the same paged table at two grains, with scope, filters, search, and page all in the query string so a filtered listing is a shareable URL, and a CSV of exactly what the filters select. Scope is `mine` (the only one a volunteer has, forced at parse time), one atlas, `outside` (collected where no member atlas reaches), or all of them — staff being the admin allowlist until a per-atlas role exists. Scope asks where a sample fell; a separate staff-only `member` filter asks where its collector belongs, and the two genuinely disagree — most records from outside the atlases are members travelling (beeline-lcl). Exports carry coordinates with their provenance and geoprivacy beside them: the open per-atlas question ([docs/questions.md](docs/questions.md)) is about revealing taxon-obscured coordinates *downstream* — on labels, to Ecdysis and GBIF — not about showing a participant their own data, and CONTEXT.md's stance is that anyone trusted with this store is trusted with them. Dashboards scope to the open season: from 1 March the previous season is settled (`season`/`settled_sample`), still flagged and still fixable but no longer asking. Volunteer-facing copy goes through the message catalog (`src/app/messages/` — en only; those views never carry literal prose); QC self-service instructions and the glossary live there, pinned by test to the `qc_rule` seed and to the rendered anchors. Admin screens (`/jobs`, `/people`, `/design*`) are English-only: `/design*` carries literal prose, `/jobs` and `/people` read from the catalog like everything else, since there is no reason for staff copy to be worse-kept than volunteer copy — only untranslated. Names are derived, never typed: `TaxonName` derives italics, subgenus brackets, and qualifier placement from rank, and `labelName()` (`src/person-name.ts`) derives a label's "P. Abrahamsen" from `person.given_name`/`family_name` — family names print whole, `label_name` overrides (`/design/names`). Who is in the store, and who they are, is `/people` (`src/app/roster.ts` + `src/app/views/roster.tsx`, beeline-eft): the roster, admin-gated, showing each person's iNat binding **with the evidence for it** — how many of their legacy records file under the bound account, what the runners-up were, and a plain verdict when the bound account is not the best-attested one. That column exists because a wrong binding is invisible in any view that prints only the login, which is how one survived review. Staff act there too — rebind or unbind an account, grant or revoke admin, set where someone belongs (`person_membership`), fix name parts — and every one of those writes goes to `data/person-overlay.csv` first and is applied from there (`src/person-overlay.ts`, `src/apply-person-overlay.ts`), so promotion replays it onto a rebuilt store. Membership has two shapes and one absence: a member atlas, or the umbrella program itself with no atlas — Master Melittology membership without a member atlas is real, so absence is reserved for "nobody has asked" (beeline-lcl; the overlay field stays `home_atlas` and takes `program` as a value). Samples answer the same question geographically through `atlas_region`, where a row with a NULL atlas says "known region, no atlas covers it" and no row at all is what `qc_rule_place_unrecognised` fires on. The overlay names a person `name:<display_name>` or `inat:<user_id>` and **never** by `entity_id`, which is a per-store sequence draw: the same human is 356 in dev and 21 on the sandbox. The admin roster itself now lives in `person_admin`; `config.adminLogins` is only the bootstrap seed, applied at boot when that table is empty *and* the overlay records no admin decision — the table alone cannot tell "never granted" from "revoked down to nobody", so a revocation sticks across a restart. Non-iNat samples are edited in-app (`/samples/:id/edit`, collector-gated): each save updates the live sample row and records correction events keyed by staging Mongo `_id` in `data/corrections.csv` (`src/corrections.ts` — outside the blow-away path), which legacy promotion reads union the git-curated `ingest/legacy-corrections.csv`, app rows winning ([ADR 0004](docs/adr/0004-correction-overlay.md), beeline-2c3.8). Ingestion runs as in-process scheduled jobs (`src/app/jobs/`, history in `job_run`, page at `/jobs`): interactive-window jobs chunk work into SLA-timed steps, the nightly pipeline (updated_since incremental sync → promote → elevation; `BEELINE_SYNC_PROJECTS`/`BEELINE_SWEEP_DAYS`) runs in the 2am-Pacific night carve-out, and a Sunday full sweep of the trailing year is the presence proof deletion detection reads (beeline-3hj).

## Conventions & Patterns

- Build only what the current roadmap phase needs; the fuller domain sketch waits in [docs/schema-sketch.md](docs/schema-sketch.md) and is re-reviewed when its phase arrives.
- Keep DDL dialect-neutral per ADR 0001: `TEXT` + `CHECK` for enum-ish columns, `concat()`/`concat_ws()` over `||`, no partial unique indexes.
- Collecting is often a pair (two thirds of legacy trap specimens), so collectors are a list: `sample_collector` in `recordedBy` order, position 1 being `sample.collector_id` (the primary, whose sample numbering it is). Every "my samples" query reads the list, never `collector_id` (beeline-77j).

Identity per [ADR 0002](docs/adr/0002-entities.md): entity tables have an `entity_id` PK drawn from the global `entity_id_seq`; facet tables (1:1 satellites) are keyed by their parent's id; only global-identity columns are named `entity_id`.
- Document tables and columns with `COMMENT ON` (queryable in-database); reserve `--` comments for design rationale spanning statements.
- `src/model.ts` (Kysely types) follows the SQL by hand — update it with any schema change.
- Kysely is pinned to 0.28.x until `kysely-duckdb` supports 0.29.

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
