# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project. (CLAUDE.md is a symlink to this file.)

## Build & Test

```bash
pnpm install
pnpm test                      # vitest, against in-memory DuckDB
pnpm typecheck
pnpm db:build [target.duckdb]  # blow away and rebuild from schema/*.sql
pnpm db:migrate [--status|--check|--baseline] [db]  # bring a deployed store forward (ADR 0006)
pnpm db:reseed <old.duckdb> <new.duckdb>  # re-derive a deployed store: fresh schema + its staging, then re-promote
pnpm app:dev                   # web app: tsx watch + vite build --watch (islands)
pnpm app:build && pnpm app:start  # web app, production shape
pnpm bench:pages [store]       # page latency against a copy of a store; --compare=<result.json> (bench/README.md)
pnpm bench:contention [store]  # pages, edits and the nightly overlapping: latency, and conflicts counted apart
```

Populating a fresh database end to end (production access = `beeline` in
`~/.ssh/config`; iNat access = dev OAuth credentials in `data/secrets/`):

```bash
pnpm legacy:fetch && pnpm legacy:load && pnpm legacy:promote  # production Mongo → model
pnpm inat:login                             # OAuth sign-in; mints the 24h JWT sync reads
pnpm inat:sync <projectId> [d1] [d2]        # observation window → append-only loads
pnpm inat:promote                           # current observation state → samples
pnpm inat:backfill-accounts                 # resolve legacy logins → iNat accounts
pnpm elevation:fetch && pnpm elevation:derive  # DEM tiles (SRTM 1-arc-second, Copernicus GLO-30 where SRTM does not reach) → missing elevations
pnpm locality:fetch && pnpm locality:gazetteer  # public place names and outlines (about 2 GB) → data/gazetteer.duckdb, on a workstation
pnpm area:derive [db] [gazetteer]              # the areas (federal wildernesses, so far) each sample's coordinates lie inside (the nightly runs it)
pnpm locality:derive [db] [gazetteer]          # a locality named from each sample's coordinates, offered beside its own (the nightly runs it)
pnpm ecdysis:taxonomy [db] [--cached]        # Ecdysis's thesaurus, every insect (about 3 minutes) → data/ecdysis-taxonomy/ → ecdysis_taxon, every animal node matched
pnpm taxon:fetch-sheet <sheet-id> [dir]      # a taxonomist's worksheet, every tab as CSV, to data/taxon-decisions/<modified instant>/ — to be read, not parsed
pnpm taxon:decide <kind> <rank> "<name>" --by … --reason …   # record one decision (or --batch file.csv): Ecdysis's facts filled from the store, the row validated, the file merged
pnpm taxon:apply [db]                        # replay ingest/taxon-curation.csv onto a store: the program's departures from Ecdysis, and what a later fetch moved from under
pnpm legacy:export [db] [out.csv]            # every specimen as the legacy occurrences file (the app writes it nightly)
pnpm legacy:compare-export [db] [export.csv] # how far that file is from the staged legacy records, by kind and by column, in records split by season with a few examples each, less what ingest/legacy-export-rulings.csv explains
pnpm backup:check <archive.tar.gz> [dir]     # a nightly backup downloaded from Drive: hashes against its manifest, both stores opened (BEELINE_PRIVATE_DB_KEY for the private one), left extracted for a restore
```

## Architecture Overview

How each part of Beeline works, one file per area in [`docs/architecture/`](docs/architecture). Read the file for the area you are about to change before changing it: each records the decisions and traps behind that code, with the issues and ADRs that carry them. When a change alters how an area works, update its file in the same pull request.

- [Store and schema](docs/architecture/store-and-schema.md) — `schema/*.sql`, `migrations/NNNN-slug.sql`
- [The app process, and its gate](docs/architecture/the-app-process-and-its-gate.md) — `src/app/`, `src/app/theme/tokens.ts`
- [Browsing: scope, filters, sort](docs/architecture/browsing-scope-filters-sort.md) — `src/app/listings.ts`, `src/app/views/listings.tsx`
- [The front page](docs/architecture/the-front-page.md) — `src/app/dashboard.ts`, `src/app/views/qc.tsx`
- [One record](docs/architecture/one-record.md) — `src/app/record.ts`, `src/app/views/record.tsx`
- [Printing](docs/architecture/printing.md) — `schema/035`, `schema/155`
- [Determinations from Ecdysis](docs/architecture/determinations-from-ecdysis.md) — `src/load-ecdysis.ts`, `src/adopt-ecdysis.ts`
- [Volunteers identifying their own specimens](docs/architecture/volunteers-identifying-their-own-specimens.md) — `src/app/determine.ts`, `src/app/views/determine.tsx`
- [Determinations from worksheets](docs/architecture/determinations-from-worksheets.md) — `src/fetch-worksheets.ts`, `src/load-worksheets.ts`
- [Copy](docs/architecture/copy.md) — `src/app/messages/`
- [A value that is not there](docs/architecture/a-value-that-is-not-there.md) — `src/app/views/components/text.tsx`
- [Determinations and names](docs/architecture/determinations-and-names.md) — `schema/020`, `schema/115`
- [The roster](docs/architecture/the-roster.md) — `src/app/roster.ts`, `src/app/views/roster.tsx`
- [The person's own page, and the overlay](docs/architecture/the-persons-own-page-and-the-overlay.md) — `src/person-overlay.ts`, `src/apply-person-overlay.ts`
- [Collectors Beeline doesn't know](docs/architecture/collectors-beeline-doesnt-know.md) — `src/app/unclaimed.ts`, `src/app/views/unclaimed.tsx`
- [What happened to a person, and when](docs/architecture/what-happened-to-a-person-and-when.md) — `schema/040`, `src/person-change.ts`
- [And to a sample](docs/architecture/and-to-a-sample.md) — `src/sample-change.ts`
- [Delegation](docs/architecture/delegation.md) — `src/app/acting.ts`
- [Membership](docs/architecture/membership.md)
- [Programs](docs/architecture/programs.md) — `src/app/programs.ts`, `src/app/views/programs.tsx`
- [ORCID](docs/architecture/orcid.md) — `schema/103`
- [Addressing a person, and admin](docs/architecture/addressing-a-person-and-admin.md)
- [Editing and corrections](docs/architecture/editing-and-corrections.md) — `src/corrections.ts`, `ingest/legacy-corrections.csv`
- [The legacy-format export](docs/architecture/the-legacy-format-export.md) — `src/legacy-export.ts`, `ingest/collector-aliases.csv`
- [Errors and logs](docs/architecture/errors-and-logs.md) — `src/app/error-reporting.ts`, `src/app/usage.ts`
- [Backups](docs/architecture/backups.md) — `src/store-backup.ts`, `src/store-snapshot.ts`
- [Ingestion, jobs, and elevation](docs/architecture/ingestion-jobs-and-elevation.md) — `src/app/jobs/`, `src/write-conflict.ts`
- [Localities from coordinates](docs/architecture/localities-from-coordinates.md) — `src/locality-rule.ts`, `src/derive-locality.ts`, `ingest/gazetteer.sql`
- [Areas](docs/architecture/areas.md) — `schema/038`, `src/derive-area.ts`

## Conventions & Patterns

- Build only what the current roadmap phase needs; the fuller domain sketch waits in [docs/schema-sketch.md](docs/schema-sketch.md) and is re-reviewed when its phase arrives.
- Keep DDL dialect-neutral per ADR 0001: `TEXT` + `CHECK` for enum-ish columns, `concat()`/`concat_ws()` over `||`, no partial unique indexes. Three exceptions are named and taken deliberately — the iNaturalist JSON shredding (`schema/105`), the street-suffix predicate in `qc_rule_locality_format` (`schema/120`), and that predicate's pattern as a `MACRO` rather than a one-row view (`schema/108`, because DuckDB recompiles a regex per row unless the pattern is a literal) — each marked in place with what a port must rewrite, and each with a measurement behind it rather than a preference. **Never `~`**: DuckDB's is `regexp_full_match` and Postgres's is a partial match, the one construct found so far that answers differently in the two engines without erroring. A port was measured on 2026-10-12 and decided against (beeline-yfb); it found three more — `\b` in a regex, `->> '$.key'`, `round(x, n)`'s printing — listed with the reasons for staying in [docs/research/postgres-feasibility.md](docs/research/postgres-feasibility.md).
- Collecting is often a pair (two thirds of legacy trap specimens), so collectors are a list: `sample_collector` in `recordedBy` order, position 1 **being** the primary — whose sample numbering it is. There is no `sample.collector_id`: the column was the same fact written twice, needed a view to police the copy, and could never be UPDATEd (beeline-6e9), so `sample_primary_collector` (`schema/100`) is the one definition every primary-collector read joins, and every "my samples" query reads the list (beeline-77j). What the engine cannot hold is now exactly one head per sample — `(sample_id, person_id)` stops neither a headless list nor two collectors both at position 1 — and `sample_primary_collector_invalid` (`schema/116`) names both, asserted empty after each promotion (beeline-daa). That list comes from the rows a sample is made of, never from everything its `(firstName, lastName)` pair ever recorded — one stray name on one row used to collect 1,675 samples. Person identity is the recordedBy name folded to letters and digits, so typography cannot split a human in two, and the display name is the spelling used **last** — a name changes only when somebody corrects it — but only where the later spelling *succeeds* the earlier rather than interleaving with it, since a single stray row is a keystroke and not a change of name; spellings that fold apart but name one human (`Barrett Barrett`, `Emily Hoskins`) are curated in `ingest/collector-aliases.csv`, and the worklist they are curated from is `legacy_collector_duplicate_candidate` — person records filing under one iNat login, minus the ones who collect together (beeline-eyk). The legacy system's own hand-curated name register (`shared/data/usernames.csv`, fetched by `pnpm legacy:fetch` into gitignored `data/legacy/`) is a second opinion and not an authority over any of this: it fills no missing name part — the people who have none have no iNat login for it to match on, which `legacy_register_unreached` is the view of — and of the 414 people it does reach it disagrees about 25. A few it has right in a way promotion cannot see (`MaryJo`→`Mary Jo`), several it has plainly wrong (`Herrmann`→`Hermann`, against a login of `mherrmann` and an iNat profile of `Mady Herrmann`), some are a nickname against a formal name in both directions (Kim/Kimberly, but also William/Bill), some are its own bad rows, and one is a shared household login that would hand Tom Robertson the name Julie Biddle. The login is the cheap adjudicator wherever it says anything at all; where it says nothing the person gets asked rather than picked for. So it lands as `legacy_register_name_conflict`, which is a **report and not a worklist** (Peter, 2026-08-28): staff fix names on `/people/:id`, which writes the overlay and applies immediately, so a name nobody has complained about is not worth a curation session in git. The view stays because "what does the register think about this person" is a fair question to be able to ask; nothing graduates from it on a schedule. Its email and mailing-address columns are never staged into the store at all — that satellite does not exist yet (beeline-8t8, beeline-1kb.6).
- Scientific names come apart in exactly one place, `ingest/parse-names.sql`, which runs before anything reads them apart: `legacy_det_taxa` names the outcome (genus, subgenus, epithet, authorship, trinomial) and `legacy_name_parse` is the survey of what those rules do to every distinct verbatim string, because a parser is a pile of assumptions about strings nobody here wrote and the only way to know which hold is to run it over all of them and read the residue (beeline-qcd). All three sources that write names in columns come apart there — the expert columns, the volunteer ones (`legacy_vol_det_taxa`), and the staff taxonomy list — by rules that are facts about zoological names rather than a list: a genus is capitalised and an epithet never is, and a bracketed name is a subgenus wherever it was written, which the subgenus column (`Andrena (Andrena)` on 2,888 rows, once minted as `Andrena (Andrena (Andrena))`), the epithet column, the volunteer genus column and the staff list all do (beeline-45v.2). What no rule can recognise is misspelling (`Agopostemon`), curated in `ingest/taxon-aliases.csv` with `legacy_taxon_alias_unused` beside it — spelling only, since a gender ending or a name Ecdysis lacks is a taxonomic choice and belongs to the curation layer (beeline-45v.1). Two rules were wrong until it did: authorship was "whatever follows the binomial", which on a trinomial is the third epithet — `Osmia montana` authored *montana*, `Bembix americana` *spinolae* — and authorship prints on a label, which is permanent; and a subspecies was recognised from `taxonRank`, which calls two of the corpus's five trinomials a species. So authorship must look like one (`(` or a capital) and must have had a binomial to follow, and a trinomial is this row's own genus and epithet plus one more bare epithet, anchored on the parted columns rather than the string's shape — which read `Not a bee` as a subspecies of *Not a*. `test/legacy-name-parse.test.ts` runs the real parser over strings lifted from production staging, near-exhaustively by category, since the corpus is only 727 distinct names. What the model still cannot say is in `legacy_name_flattened`: 25 morphospecies (`Melissodes sp.1` and `sp.5` are one node, beeline-8g7) and one `nr.` (beeline-tgu) — nobody typed those wrong and no volunteer can fix them, so they are a view rather than a flag. `legacy_verbatim_shape` surveys the other parsed fields the same way, and its answers are what license their rules: `recordedBy` uses `|` and nothing else — no `&`, no comma — so splitting on the pipe is complete; 1,731 records spell the month in Roman numerals, which `legacy_month` already takes; and of the URLs the observation id is read off, five point at an iNat *taxon* page and correctly yield nothing.

Identity per [ADR 0002](docs/adr/0002-entities.md): entity tables have an `entity_id` PK drawn from the global `entity_id_seq`; facet tables (1:1 satellites) are keyed by their parent's id; only global-identity columns are named `entity_id`.
- Document tables and columns with `COMMENT ON` (queryable in-database); reserve `--` comments for design rationale spanning statements.
- **Report every check count split by season** (Peter, 2026-08-29): the active seasons against the settled ones, never one number (the words are defined under **Season** in CONTEXT.md). A defect in current-practice data says the workflow is broken now; the same defect before it is residue from the wild west, and a combined figure cannot tell you which — nor whether a number that looks stable is actually a live problem growing under a historical one. The line is the store's own, `season.active_since` / `settled_sample` (`schema/102`), judged on `date_start` for a sample and `observed_on` for an observation; not a hand-rolled date, since last season stays active until 1 March and today is read in Oregon, not UTC. It changed the reading of minting's own numbers, measured when the line was still 1 March (the "open season"): `non_tracheophyte_host` is 0 against 40, so host plants are a solved problem; a missing locality is 14% of the open season against 34% before it; but `obscured_no_true_coordinates` is 50 against 21, which is the one that *inverts* — obscured-without-trust is a live and growing gap, not a historical one, and only the split says so.
- Tests run against in-memory DuckDB built from the real `schema/*.sql` (`createMemoryDb`), so a schema mistake fails a test rather than a review — the load-bearing half being *from the real schema*, not *in memory*. Where being file-backed is itself what is under test, `createFileDb` (`test/helpers.ts`) applies the same schema to a file: the default catalog is then named after the file rather than `memory`, which is where beeline-d34 lived, invisible to a suite in which every test paired a file-backed private store with an in-memory main one. It is slower, and reaching for it anywhere else is a mistake. `insertCleanSample` (`test/helpers.ts`) is the fixture that makes a sample nothing is wrong with, and a test that wants something wrong says which. It collects on 14 July of the current season: a fixture that should be asked about or printed is dated with `CURRENT_SEASON` or `currentSeasonDate` from the same file, never with a year written into the test, because a written year settles on the 1 March after it ends and every test that expected it to be active fails (beeline-a0lj). A fixture that should have settled is dated in `SETTLED_SEASON`, not `CURRENT_SEASON - 1`, which is still active in January and February. A test that builds the app spreads `scratchPaths()` into it: the files the app writes default to the developer's own under `data/`, a test that fell back to one wrote fake history into them, and under Vitest the fallback now throws (`src/deployment-path.ts`, beeline-yq65). Assert against strings the source actually produced rather than invented ones — `test/legacy-name-parse.test.ts` is the pattern, its corpus lifted from production staging and its few synthetic cases labelled as such, because a parser tested only on strings we wrote is a parser tested on our assumptions.
- `src/model.ts` (Kysely types) follows the SQL by hand — update it with any schema change.
- Kysely is pinned to 0.28.x until `kysely-duckdb` supports 0.29.
- A `TIMESTAMP` means UTC in every process, not only on Fly: the openers in `src/db.ts` pin DuckDB's session zone to UTC, and `patches/kysely-duckdb.patch` reads the value back as UTC rather than as the machine's local time (beeline-j0aj). Write an instant as `current_timestamp` or `toISOString()`, never as a local-time string. Before this, a workstation stored the SQL clock in Pacific time and JavaScript's instants in UTC, seven hours apart in one column.

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

## Git Authority

**This repository authorizes agents to commit and push without asking, and
work lands as a pull request** (2026-08-28). Branch, commit, push, open it with
`gh pr create`; close the beads you finished when it merges. No approval is
needed to open one, or to merge a green one — the review, not the asking, is
the point. **Do not commit or push to `main` directly**: nothing gets reviewed
on the way in that way, which is the whole reason for the branch.

**Beads make no commits at all** (Peter, 2026-10-23). Issue work syncs with
`bd sync`, which pulls, checks for conflicts and pushes the Dolt store over
`refs/dolt/data` on the git remote, and nothing in the working tree changes when
an issue does. Run it without asking, after filing or changing issues and before
ending a session; the SessionStart hook runs it too. The JSONL
export used to be tracked and committed straight to `main`; it is now ignored,
because it held nothing the Dolt ref does not and every branch that carried a
copy of it conflicted with the next one on merge. `bd export -o <file>` writes
one when something needs it.

This is the "repository profile" the Beads block below defers to, and it
overrides that block's conservative default — stated here, outside the managed
markers, so `bd setup` cannot regenerate it away.

Committing straight to `main` was the stance until CodeRabbit began reviewing
every pull request, and the reason to change was empirical rather than
procedural: on beeline-o22 it found a real defect that four rounds of
adversarial design review had missed — an identity shortcut on the sibling code
path of one already fixed. It is good at exactly what design review is worst
at. Since 2026-10-04 it reads Peter's branches locally, through the CodeRabbit
CLI, before the pull request is opened, so findings become ordinary edits rather
than push-and-wait round trips; the PR bot skips his PRs (`.coderabbit.yaml`)
and still reviews everyone else's. Triage what it says: fix what is real, and
give the reason in the PR when declining. The branch still earns its keep: CI
runs on it, and the pull request records what landed and why.

Why the commit authority itself is broad is the era, not the tooling:
pre-cutover the store is blown away and rebuilt at will, nothing downstream
consumes it, and no volunteer sees it, so a bad commit costs a revert and
nothing else. **Revisit at cutover (December 2026)**, when minted field numbers
become permanent and backups become mandatory — the blow-away era ending is
what makes this stance expire, and is when a PR will want a human approving it
rather than only a bot reading it.

Still true regardless: don't commit someone else's uncommitted work, don't
rewrite published history, and keep documentation current in the same commit as
the change it describes.

## Agent skills

Per-repo configuration the engineering skills read. Written by
`/setup-matt-pocock-skills`; edit `docs/agents/*.md` directly to change it.

### Issue tracker

Two trackers, split by audience: GitHub Issues for discussion-shaped work,
customer requests, and bugs someone reported; beads (`bd`) for everything else,
including bugs found while working. Where this disagrees with the managed Beads
block below ("use `bd` for ALL task tracking"), the tracker doc wins. See
[docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Triage labels

The five canonical roles, each label string equal to its name, applied to
GitHub Issues only. See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

### Domain docs

Single-context: [CONTEXT.md](CONTEXT.md) + [docs/adr/](docs/adr/) at the repo
root. See [docs/agents/domain.md](docs/agents/domain.md).

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
- Don't use `bd remember`: this repo is public, so everything in beads, memories included, can be read by anyone from `refs/dolt/data`. Keep persistent knowledge in Claude's file memory.

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
   bd sync
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
- Don't keep project memory in `bd remember`: this repo is public, and so is everything in beads. Use Claude's file memory.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
