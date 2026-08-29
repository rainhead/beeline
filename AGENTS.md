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

### Store and schema

The schema **is** the `schema/*.sql` files, applied in filename order (0xx tables, 1xx derived views). Databases are blown away and rebuilt before cutover ([docs/roadmap.md](docs/roadmap.md)); the ones that can't be — the sandbox, production later — catch up through `migrations/NNNN-slug.sql` and `pnpm db:migrate`, recorded in `schema_migration` and stamped (never run) on a fresh build ([ADR 0006](docs/adr/0006-migrations-for-deployed-stores.md)). QC rules, printability, and determination-of-record are SQL views, not app code. Engine: DuckDB behind dialect-neutral SQL — [ADR 0001](docs/adr/0001-duckdb-first-with-portable-sql.md).

### The app process, and its gate

The web app (`src/app/`) is the process that owns the database — [ADR 0005](docs/adr/0005-app-process-owns-the-store.md): Hono with `hono/jsx` SSR views, Lit light-DOM islands built by Vite, MD3 color tokens generated from a seed (`src/app/theme/tokens.ts`), every route session-gated by construction — and the gate remembers the URL it refused, so signing in lands you on the page you asked for rather than home (same-site GET paths only, carried in a short-lived cookie beside the OAuth state, beeline-2c3.31); `/design` is the design system (component library in `src/app/views/components/`, stylesheets split `elements`/`layout`/`components` under `src/app/static/`, every section rendering live from the real tokens), off the nav for non-admins but not gated — it reads no records, so walling a curious volunteer out of it protects nothing; the reason it is not on their nav is that it is not their tool — and `/glossary` is its volunteer-facing counterpart. Auth is iNat OAuth; sessions and OAuth tokens live in the attached private store ([ADR 0003](docs/adr/0003-private-data-store.md)), whose schema is `schema/private/*.sql`, applied by the app at boot when missing.

### Browsing: scope, filters, season

Browsing lives at `/samples` and `/specimens` (`src/app/listings.ts` + `src/app/views/listings.tsx`, beeline-2c3.21): the same paged table at two grains, with scope, filters, search, and page all in the query string so a filtered listing is a shareable URL, and a CSV of exactly what the filters select. A session is keyed by `inat_user_id`, never by `person.entity_id`: that is a per-store sequence draw a rebuild or `db:reseed` redraws, so a session holding one resolved to whoever inherited the number and a volunteer browsed as somebody else under the `mine` scope forced for them (beeline-ten). The person is resolved through `inat_account` per request, which also makes unbinding an account end its sessions and rebinding move them. A private store predating that change is repaired at boot — it outlives the blow-away era, so its schema changes are patched in `src/app/db.ts` rather than by rebuild, per table rather than all-or-nothing, because a store that holds some of its tables and not others is a state that patch itself can create. Resolution failing is not revocation: an unbound session stops sliding its `last_seen_at` so the idle cutoff never reaches it, and rebinding that iNat user would revive every cookie ever issued for it as whoever now holds the account — so `endSessionsFor` runs on both sides of an account change and the idle purge collects orphans. Scope is `mine` (the only one a volunteer has, forced at parse time), one atlas, `outside` (collected where no member atlas reaches), or all of them — staff being the admin allowlist until a per-atlas role exists. Scope asks where a sample fell; a separate staff-only `member` filter asks where its collector belongs, and the two genuinely disagree — most records from outside the atlases are members travelling (beeline-lcl). Exports carry coordinates with their provenance and geoprivacy beside them: the open per-atlas question ([docs/questions.md](docs/questions.md)) is about revealing taxon-obscured coordinates *downstream* — on labels, to Ecdysis and GBIF — not about showing a participant their own data, and CONTEXT.md's stance is that anyone trusted with this store is trusted with them. Dashboards scope to the open season: from 1 March the previous season is settled (`season`/`settled_sample`), still flagged and still fixable but no longer asking.

### One record

`/samples/:id` and `/specimens/:id` (`src/app/record.ts` + `src/app/views/record.tsx`, beeline-2c3.34) are the two record pages, and the specimen one exists because `determination` is append-only and `determination_of_record` is a view: a correction is a newer event and an expert never overwrites a volunteer, and the specimen listing gave that whole history one cell. The page is the events — who, when, through which channel, expert or not, the qualifier, `verbatim_identification`, which row is the record — newest first and with the record *marked* rather than hoisted, because hoisting it rebuilds the flattened read this replaces. The record is frequently not the newest (61,102 specimens on the dev store), so where they differ the page says why. The grain split follows the data: QC findings are keyed to the sample, so "why will this not print" is answered on the sample's page, which also carries the coordinates with their `source` provenance and the observation's geoprivacy beside them, the elevation with its `elevation_source`, and a paged list of its specimens — the largest trap sample holds 2,252. Each page carries the whole of the other's sample block, through the same components, because a determination read without where and when the insect was collected is not a record of anything. Reachability is the listings' rule with the filters gone — a volunteer reaches their own, staff reach everything, `mine` follows the acting-for switch — and unreachable is answered as 404 rather than 403, so a URL cannot be probed. A record is addressed by `entity_id`, which a rebuild redraws; there is no better handle, since a field number is nullable and, across the four identifier eras, not unique.

### Copy

Volunteer-facing copy goes through the message catalog (`src/app/messages/` — en only; those views never carry literal prose); QC self-service instructions and the glossary live there, pinned by test to the `qc_rule` seed and to the rendered anchors. Staff screens (`/jobs`, `/people`, `/design*`) are English-only: `/design*` carries literal prose, `/jobs` and `/people` read from the catalog like everything else, since there is no reason for staff copy to be worse-kept than volunteer copy — only untranslated.

### Determinations and names

Rank is reference data, not free text: `animal_rank` (`schema/020`) holds the ranks the store admits with an `ordinal` gapped by 10, because "species or finer" is the comparison the domain needs and a bare TEXT column cannot answer it — every caller was growing its own copy of the ladder instead (beeline-a2p, beeline-4zi). The numbers live in the table and callers join, which is the half of Symbiota's rank design worth copying without the ~150 bare `rankid > 220` literals that came with it. `TaxonName`'s `ITALIC_RANKS` stays a separate, deliberately wider list — it must do something sensible with a rank the store has never heard of — and a test pins the two to agree wherever they overlap. `determination_misplaced_qualifier` (`schema/115`) is the CHECK the engine cannot hold, since "species or finer" is a fact about `animal_rank` rather than about the determination row: a test asserts it empty, the same shape as `sample_elevation_stale` and for the same reason. A determination says which node and, since beeline-tgu, how sure: `determination.qualifier` holds the three open-nomenclature qualifiers that modify a species assertion (`cf.`, `aff.`, `nr.`) and cannot be expressed by dropping to genus, which would throw away the resemblance the determiner observed; `sp.`/`spp.` are deliberately absent, being what a genus-rank determination already means. `verbatim_identification` keeps the name as the source wrote it beside the node it resolved to — staging is re-pullable today and frozen at cutover, and Ecdysis import brings names from a system that records both. Only `nr.` is attested in the legacy corpus (3 records, `Lasioglossum nr. tenax`, which used to land on the bare genus because `specificEpithet` is empty on those rows and nothing read the string); the glossary and `/design/names` teach all three. Names are derived, never typed: `TaxonName` derives italics, subgenus brackets, and qualifier placement from rank, and `labelName()` (`src/person-name.ts`) derives a label's "P. Abrahamsen" from `person.given_name`/`family_name` — family names print whole, `label_name` overrides (`/design/names`).

### The roster

Who is in the store, and who they are, is `/people` (`src/app/roster.ts` + `src/app/views/roster.tsx`, beeline-eft): the roster, admin-gated — a listing of people first and, after cutover, only. The account promotion picked for someone can be wrong, and a wrong one is invisible in any view that prints only the login, which is how one survived review; but checking them is a job that ends when the legacy records stop being the source, so it gets no column, no sort order, and no vocabulary of its own (beeline-eyk). A row says something only when something is wrong with it — a chip in the account cell, in the words anyone would use — with a count above the table, since the listing is ordered as a roster rather than as a worklist. Two dates ask whether someone is still active and neither implies the other: `Last sample` reads from `sample_collector`, and `Last seen` from the private store, which a store opened without it simply has no answer for. `Last seen` answers from two sources of different strength and now says which it is using: a visit — a request they actually made, recorded in `person_activity` and throttled to an hour — prints plain, while a bare sign-in prints as one, because iNat tokens never expire and that date can be months behind somebody who has been here every week. It is a table rather than a column on `session` in either direction: the session's `last_seen_at` has to slide on every request for the 30-day expiry to mean anything, and it cannot serve as the person's activity because the idle cutoff is per credential — a phone in daily use would keep an abandoned laptop's cookie alive. Keyed on `inat_user_id`, so it outlives a rebuild; kept outside the session, so that destroying sessions — an expiry purge, a rebind, the beeline-ten rekey — no longer silently ages the column toward "less active" (beeline-dji). A person with no account whose records point at somebody else's is a household sharing one login (`inat_user_id` is unique, so only one of them can hold it): the row names the holder rather than leaving a blank, and squaring the model itself is beeline-oyl.

### The person's own page, and the overlay

The person's own page is where the work is done and so explains itself at length; a store with no legacy staging drops the apparatus entirely rather than explaining its absence. Staff act there too — rebind or unbind an account, grant or revoke admin, set where someone belongs (`person_membership`), say who may act for whom (`person_delegate`), fix name parts — and every one of those writes goes to `data/person-overlay.csv` first and is applied from there (`src/person-overlay.ts`, `src/apply-person-overlay.ts`), so promotion replays it onto a rebuilt store. The one decision with no screen behind it is `create`, which asserts that a person exists at all: promotion mints people from records, so a staffer who collects nothing — an intern, a coordinator — has no other way into the store and therefore no way to sign in, since the approval gate is an account bound to a person. It names them `name:<display name>`, is applied before every other row so the account binding and the admin grant compose with it, is idempotent on replay, and refuses a name two people already share rather than minting a third (beeline-2c3.32); a hand-written INSERT would do the same thing once and be gone at the next `db:reseed`.

### What happened to a person, and when

The overlay says what was decided; it cannot say what happened. One current row per (`person_ref`, field) means a later edit replaces the earlier one, so it answers "who last changed this, and why" and never when, what the value was before, that it changed twice, or who changed it the first time — and nothing displayed it at all. So there is a second artifact beside it, in the shape the project already settled for a correction to a determination (`schema/040`): authored changes are append-only events. `data/person-change.csv` (`src/person-change.ts`) holds one entry per (when, `person_ref`, field, old, new, author, source, reason), read on `/people/:id` as that person's history and on the unfiltered `/people` as the newest entries across everybody — filtered, the panel is dropped, since a search for one person answered with somebody else's history reads as a filter that leaked. A CSV rather than a table for the same reason the overlays are, and a sharper one: a history the blow-away erases answers "who changed this" with "nobody, we rebuilt it". That constraint dies at cutover and the natural home is then a table — [ADR 0007](docs/adr/0007-authored-changes-are-events.md), beeline-o22.

Every writer is covered, not just the screen — legacy promotion mints people and binds accounts wholesale, observation promotion rewrites `inat_account.login` whenever iNaturalist renames an account, and both used to leave no trace but the code that did it, which is exactly the class of change that bound three people to the wrong account (beeline-eft). Coverage does not depend on each writer remembering: entries are produced by comparing the store against what the log itself last said (`recordPersonChanges`, idempotent, run at the end of legacy promotion, after observation promotion, and at boot), so a change made any other way is caught by the next pass and attributed to that pass rather than to a person — which is what `source` says and `author` deliberately does not. Both producers read one query (`PERSON_STATE_SQL`) and record **state** rather than the overlay's instructions, because a log minted from what a writer intended would differ from what a rebuild computes and report a change nobody made. The entries are keyed by the overlay's `person_ref` and never by `entity_id`, a per-store sequence draw a rebuild redraws (beeline-ten). A rename moves that reference and the log's own `display_name` entries follow it — forward only, in file order, never onto a name the log already knows somebody by, because treating a rename as evidence that two names *are* one person merges two people the moment their names swap or a vacated name is reused, and then reports the difference between them on every pass forever. A reference also moves when nothing has happened to the person — a namesake arriving pushes them off their own name onto their account, a rebuild that respells `MaryJo` as `Mary Jo` moves it with no rename recorded anywhere — so a pass matches the store's people against the log's in order of evidence: the reference itself, then the name the log last recorded (a name changes only when somebody changes it), then the account. Every claim is proposed before any is granted, because whether a claim is safe depends on what the other people in the store turn out to be — deciding one at a time is a different and wrong problem, and produced a fabricated rebinding in every review round that went looking. What cannot be attributed is recorded as **nothing** and counted (`contested`): two people reaching one history claim nothing, and a history whose account somebody else in the store now holds is nobody's to claim, since a newcomer taking over a respelled person's old name is identical in evidence to the person whose account was taken away and who is still standing there. That costs an account shuffle one of its two rebindings — silence is a gap somebody can look into, where a fabricated rebinding is a lie about the one thing this log exists to make visible (beeline-eft). A name the store still carries means its person is still here, so an account only recognises somebody whose last recorded name nobody answers to any more. A reference falling silent records **nothing**: it looks like a departure and is equally a name that became ambiguous or a store promoted from a smaller corpus, and the version that wrote departures made flat false statements about people standing right there. A page's history is addressed by the reference the **store** gives that person rather than by a name two of them might share. Read leniently where both overlays are read strictly — refusing a malformed row protects a file that gets rewritten wholesale, and this one is only ever appended to, so its own order is the order things were recorded and no timestamp can restate it.

### Delegation

Delegation exists because a household shares one iNat login and `inat_account` is 1:1 and stays that way (beeline-oyl): the partner who does not hold it cannot sign in, and since `mine` is forced for volunteers their samples are unreachable by the only person who can — 1,087 of the Pedersons' 2,233 are in that state. It grants reach and never credit; attribution and Master Melittology progress stay with whoever collected. Staff grant it rather than the person represented, because being unable to sign in is the whole reason the row exists. The `acts_for` overlay value names the **whole** set of people, semicolon-separated, since one row per (person_ref, field) with latest-wins cannot say "and also". Turning it on is an explicit switch rather than a widening: `mine` keeps meaning mine everywhere, and while the switch is on `mine` *is* the person being acted for — never both, since a page blending Gretchen's 1,146 samples with Robert's 1,087 leaves a volunteer unable to say whose work they are reading. The switch is a cookie (`src/app/acting.ts`) naming the person the way the overlay does — by display name, never by `entity_id`, since the cookie is client-held and no rebuild can reach it, so a delegate holding two grants whose numbers permuted would have had a stale cookie silently select the other one on a switch that gates writes. Deliberately not a query parameter like scope and the filters: those are questions about the records and travel fine in a pasted URL, this one is about who is asking and the recipient may hold no grant. The grant is re-read on every request, so a revocation takes effect at once and a forged cookie resolves to nothing. Every "mine" surface follows it — the QC home, both listings and their CSVs, and the collector gate on sample editing — while admin rights and a correction's recorded author stay with whoever is signed in.

### Membership

Membership has two shapes and one absence: a member atlas, or the umbrella program itself with no atlas — Master Melittology membership without a member atlas is real, so absence is reserved for "nobody has asked" (beeline-lcl; the overlay field stays `home_atlas` and takes `program` as a value). Samples answer the same question geographically through `atlas_region`, where a row with a NULL atlas says "known region, no atlas covers it" and no row at all is what `qc_rule_place_unrecognised` fires on.

### Addressing a person, and admin

A person is addressed in a URL by their login where they have one and their `entity_id` otherwise (`personHandle`), and both resolve — `/people/pandg` and `/people/722396` are the same page, matched case-insensitively, and an all-digit segment is always an id since no iNaturalist login is all digits. The login is preferred because an `entity_id` is a per-store sequence draw that a rebuild or a `db:reseed` redraws: `/people/722436` was Steve Lang in one promotion of the sandbox's data and Robert Pederson in the next. The overlay is a separate question and a stricter one — it names a person `name:<display_name>` or `inat:<user_id>` and **never** by `entity_id`, because it is replayed onto a store that does not exist yet. The admin roster itself now lives in `person_admin`; `config.adminLogins` is only the bootstrap seed, applied at boot **per person** — to anyone on the list who holds no row and whom the overlay has not revoked. Asked of the store instead of of the person, it locks people out: `db:reseed` does not carry `person_admin`, so a reseeded store rebuilds the roster from the overlay alone, and the one grant anyone had written (to a new staff member) was enough to make the table non-empty and the overlay non-silent — which disabled the bootstrap for the five people who had only ever been in it, with no way back because granting admin requires being an admin (beeline-2c3.38). Only a revocation of *this* person suppresses their seed, which is the property the guard was reaching for; someone else's grant is none of their business, and neither is already holding a row a reason to skip the rest of the list. Both overlays are read, since half the decisions are curated in git.

### Editing and corrections

Non-iNat samples are edited in-app (`/samples/:id/edit`, collector-gated): each save updates the live sample row and records correction events keyed by staging Mongo `_id` in `data/corrections.csv` (`src/corrections.ts` — outside the blow-away path), which legacy promotion reads union the git-curated `ingest/legacy-corrections.csv`, app rows winning ([ADR 0004](docs/adr/0004-correction-overlay.md), beeline-2c3.8).

### Ingestion, jobs, and elevation

Ingestion runs as in-process scheduled jobs (`src/app/jobs/`, history in `job_run`, page at `/jobs`): interactive-window jobs chunk work into SLA-timed steps, the nightly pipeline (updated_since incremental sync → promote → elevation; `BEELINE_SYNC_PROJECTS`/`BEELINE_SWEEP_DAYS`) runs in the 2am-Pacific night carve-out, and a Sunday full sweep of the trailing year is the presence proof deletion detection reads (beeline-3hj). An elevation is a statement about a point, so `sample_location` records the point it was read at (`elevation_latitude`/`elevation_longitude`, CHECK-paired with `elevation_m`) and `schema/170_views_elevation.sql` states the rule once: `sample_elevation_stale` is an elevation about somewhere else, `sample_elevation_pending` is what the derive job selects. A coordinate too vague to place gets no elevation at all: `elevation_derivation_limit` states the threshold once (100 m, tighter than the 250 m at which `qc_rule_coordinate_uncertainty` blocks printing, because an elevation is a stricter claim than a locality string), `sample_elevation_pending` drops those rows so they are never a standing backlog, and the derive job counts them separately so a shrinking gap count is not mistaken for progress. `sample_elevation_unsupportable` names the ones already in the store — 1,558 on the dev store, 744 of them on records that still print, and 1,546 from iNaturalist rather than the legacy import — and removes none of them, because that is a decision rather than a consequence (beeline-6vc). **Do not add a clear-the-elevation rule to a new coordinate writer** — the pending view already covers it, so a move self-heals on the next derive run rather than depending on the writer having remembered; observation promotion clears eagerly only so the intervening state reads "unknown" rather than "confidently wrong", and it does so by naming the view, not by restating its tolerance (beeline-x5c). Observations reach the model through one stored projection: `observation_field` (`schema/060`) is the materialisation of `observation_current_fields` (`schema/105`), which stays the definition and is now also what the table is refreshed from and checked against. It is the one place a view's output is kept, licensed by an input nothing but a sync writes — where a *finding* also depends on `sample`, which the in-app editor writes while promising the flags update immediately, and on `specimen`, which printing will write, so findings stay derived (`schema/050`). Shredding 63k JSON projections costs ~200 ms and three QC rules read it, which is why scanning `qc_finding` cost ~670 ms and the QC home, both listings, printability and the record pages each paid it; storing it took the union to ~205 ms, and replacing `qc_rule_locality_format`'s nineteen `LIKE` passes with one regular expression took it the rest of the way to ~25 ms (beeline-2c3.36, beeline-2c3.37). `refreshObservationFields` runs inside the sync run's own transaction — so loads and their shredded form agree at every commit boundary — and again at the head of promotion, which is how a reseeded or hand-staged store gets one at all; `observation_field_stale` names the disagreement, the way `sample_elevation_stale` does, because an unrefreshed table is not a visibly broken one: the rules simply report nothing and printability calls every sample clean.

## Conventions & Patterns

- Build only what the current roadmap phase needs; the fuller domain sketch waits in [docs/schema-sketch.md](docs/schema-sketch.md) and is re-reviewed when its phase arrives.
- Keep DDL dialect-neutral per ADR 0001: `TEXT` + `CHECK` for enum-ish columns, `concat()`/`concat_ws()` over `||`, no partial unique indexes. Two exceptions are named and taken deliberately — the iNaturalist JSON shredding (`schema/105`) and the street-suffix predicate in `qc_rule_locality_format` (`schema/120`) — each marked in place with what a port must rewrite, and each with a measurement behind it rather than a preference. **Never `~`**: DuckDB's is `regexp_full_match` and Postgres's is a partial match, the one construct found so far that answers differently in the two engines without erroring.
- Collecting is often a pair (two thirds of legacy trap specimens), so collectors are a list: `sample_collector` in `recordedBy` order, position 1 being `sample.collector_id` (the primary, whose sample numbering it is). Every "my samples" query reads the list, never `collector_id` (beeline-77j) — and that the two agree is `sample_primary_collector_mismatch` (`schema/116`), a view because the rule spans two tables and depends on a row's position, so no CHECK reaches it. Asserted empty after each promotion, and it separates the three ways to break it: no head to the list, a head naming somebody else, two collectors both at position 1 — the last of which `(sample_id, person_id)` does nothing to stop. One writer maintains it today; the check exists before the second arrives, not after (beeline-daa). That list comes from the rows a sample is made of, never from everything its `(firstName, lastName)` pair ever recorded — one stray name on one row used to collect 1,675 samples. Person identity is the recordedBy name folded to letters and digits, so typography cannot split a human in two, and the display name is the spelling used **last** — a name changes only when somebody corrects it — but only where the later spelling *succeeds* the earlier rather than interleaving with it, since a single stray row is a keystroke and not a change of name; spellings that fold apart but name one human (`Barrett Barrett`, `Emily Hoskins`) are curated in `ingest/collector-aliases.csv`, and the worklist they are curated from is `legacy_collector_duplicate_candidate` — person records filing under one iNat login, minus the ones who collect together (beeline-eyk). The legacy system's own hand-curated name register (`shared/data/usernames.csv`, fetched by `pnpm legacy:fetch` into gitignored `data/legacy/`) is a second opinion and not an authority over any of this: it fills no missing name part — the people who have none have no iNat login for it to match on, which `legacy_register_unreached` is the view of — and of the 414 people it does reach it disagrees about 25. A few it has right in a way promotion cannot see (`MaryJo`→`Mary Jo`), several it has plainly wrong (`Herrmann`→`Hermann`, against a login of `mherrmann` and an iNat profile of `Mady Herrmann`), some are a nickname against a formal name in both directions (Kim/Kimberly, but also William/Bill), some are its own bad rows, and one is a shared household login that would hand Tom Robertson the name Julie Biddle. The login is the cheap adjudicator wherever it says anything at all; where it says nothing the person gets asked rather than picked for. So it lands as `legacy_register_name_conflict`, which is a **report and not a worklist** (Peter, 2026-08-28): staff fix names on `/people/:id`, which writes the overlay and applies immediately, so a name nobody has complained about is not worth a curation session in git. The view stays because "what does the register think about this person" is a fair question to be able to ask; nothing graduates from it on a schedule. Its email and mailing-address columns are never staged into the store at all — that satellite does not exist yet (beeline-8t8, beeline-1kb.6).
- Scientific names come apart in exactly one place, `ingest/parse-names.sql`, which runs before anything reads them apart: `legacy_det_taxa` names the outcome (genus, subgenus, epithet, authorship, trinomial) and `legacy_name_parse` is the survey of what those rules do to every distinct verbatim string, because a parser is a pile of assumptions about strings nobody here wrote and the only way to know which hold is to run it over all of them and read the residue (beeline-qcd). Two rules were wrong until it did: authorship was "whatever follows the binomial", which on a trinomial is the third epithet — `Osmia montana` authored *montana*, `Bembix americana` *spinolae* — and authorship prints on a label, which is permanent; and a subspecies was recognised from `taxonRank`, which calls two of the corpus's five trinomials a species. So authorship must look like one (`(` or a capital) and must have had a binomial to follow, and a trinomial is this row's own genus and epithet plus one more bare epithet, anchored on the parted columns rather than the string's shape — which read `Not a bee` as a subspecies of *Not a*. `test/legacy-name-parse.test.ts` runs the real parser over strings lifted from production staging, near-exhaustively by category, since the corpus is only 727 distinct names. What the model still cannot say is in `legacy_name_flattened`: 25 morphospecies (`Melissodes sp.1` and `sp.5` are one node, beeline-8g7) and one `nr.` (beeline-tgu) — nobody typed those wrong and no volunteer can fix them, so they are a view rather than a flag. `legacy_verbatim_shape` surveys the other parsed fields the same way, and its answers are what license their rules: `recordedBy` uses `|` and nothing else — no `&`, no comma — so splitting on the pipe is complete; 1,731 records spell the month in Roman numerals, which `legacy_month` already takes; and of the URLs the observation id is read off, five point at an iNat *taxon* page and correctly yield nothing.

Identity per [ADR 0002](docs/adr/0002-entities.md): entity tables have an `entity_id` PK drawn from the global `entity_id_seq`; facet tables (1:1 satellites) are keyed by their parent's id; only global-identity columns are named `entity_id`.
- Document tables and columns with `COMMENT ON` (queryable in-database); reserve `--` comments for design rationale spanning statements.
- Tests run against in-memory DuckDB built from the real `schema/*.sql` (`createMemoryDb`), so a schema mistake fails a test rather than a review; `insertCleanSample` (`test/helpers.ts`) is the fixture that makes a sample nothing is wrong with, and a test that wants something wrong says which. Assert against strings the source actually produced rather than invented ones — `test/legacy-name-parse.test.ts` is the pattern, its corpus lifted from production staging and its few synthetic cases labelled as such, because a parser tested only on strings we wrote is a parser tested on our assumptions.
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

## Git Authority

**This repository authorizes agents to commit and push without asking, and
work lands as a pull request** (2026-08-28). Branch, commit, push, open it with
`gh pr create`; close the beads you finished when it merges. No approval is
needed to open one, or to merge a green one — the review, not the asking, is
the point. **Do not commit or push to `main` directly**: nothing gets reviewed
on the way in that way, which is the whole reason for the branch.

This is the "repository profile" the Beads block below defers to, and it
overrides that block's conservative default — stated here, outside the managed
markers, so `bd setup` cannot regenerate it away.

Committing straight to `main` was the stance until CodeRabbit began reviewing
every pull request, and the reason to change was empirical rather than
procedural: on beeline-o22 it found a real defect that four rounds of
adversarial design review had missed — an identity shortcut on the sibling code
path of one already fixed. A second reader that only ever sees pull requests is
worth the branch, and it is good at exactly what design review is worst at.
Triage what it says: fix what is real, and reply on the PR with the reason when
declining.

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
