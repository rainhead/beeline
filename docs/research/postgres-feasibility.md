# Could Beeline run on Postgres?

Measured 2026-10-12 (Peter, with Claude) on a copy of the dev store (2 October, migrated
to `0050`): 3.03 million rows in 63 tables. Both engines ran on one workstation (Apple
M1, 16 GB, Postgres 17.11, DuckDB 1.5.5 through `@duckdb/node-api`), which other work
kept at a load average of about 8 throughout, so every figure is a median of three or
five runs and the comparison between engines matters more than any single number. It
informed [beeline-yfb](../../.beads/): whether the store should leave DuckDB at cutover,
when rebuilding stops being free. Peter decided to stay on DuckDB ([The
decision](#the-decision), below).

## What it found

**Postgres gives the same answers.** Every one of the schema's 78 views returned the
same rows on both engines, row for row, once the SQL was rewritten by
a translator, [`src/postgres-port.ts`](https://github.com/rainhead/beeline/blob/07fd0f37f6a08c6baf3bef749d84c725fd9cc1a3/src/postgres-port.ts). The rewrite is
mechanical: a list of rules, one for each DuckDB-only construct the SQL uses. It and a
CI check that applied the schema to Postgres through it (beeline-l6w) were removed with
the decision to stay; [Reproducing it](#reproducing-it) says where they are kept.

**A straight port is 5 to 20 times slower on most pages people open, and indexes do not
fix it.** (The People pages are slower still, for a reason of their own, below.) The
cause is how the schema is built. QC findings, printability,
determination-of-record and the observation views are views that compute their whole
result on every read. DuckDB does that for the 7,958 QC findings in about 120 ms;
Postgres takes 1.4 to 1.6 s. A page that asks for one sample's findings cannot narrow
the work, because `sample_qc_finding` computes its `sample_id` with `coalesce()` and the
union's arms rank and group across every sample, so Postgres computes all of it and
then keeps one row. An index on every foreign key changed none of the timings.

**Storing four views' rows puts Postgres level with DuckDB or ahead of it on every page
but People.** Created as
materialized views — Postgres keeps the rows and recomputes them only when told — with
an index on each `…_id` column, `qc_finding`, `determination_of_record`,
`observation_place` and `observation_locality` took most pages below DuckDB's times. A
single sample's page went from 2.7 s to 30 ms (DuckDB: 323 ms). That is a change of
design, not of engine: something has to keep those rows current, and the in-app
sample editor promises that a sample's flags update the moment it is saved.

A worked example, the volunteer's front page: twelve queries, 693 ms of them in
DuckDB. Ported as written, 12.4 s — 4.1 s in one query that joins the person's 535
unnumbered observations to `observation_locality`, which Postgres builds for all 64,357
observations (parsing every `place_guess`, then ranking the parts) before keeping
535. With the four views stored, 642 ms.

## Each page's share of database time

The queries each page of `bench:pages` sends, recorded and replayed on both engines by
[`bench/postgres/pages.ts`](https://github.com/rainhead/beeline/blob/07fd0f37f6a08c6baf3bef749d84c725fd9cc1a3/bench/postgres/pages.ts). Postgres had an index on
every foreign key, `work_mem` 64 MB, `shared_buffers` 512 MB and JIT off; with the
defaults (4 MB, JIT on) it was slower still.

| Page | Who | DuckDB | Postgres, ported | Postgres, four views stored |
|---|---|--:|--:|--:|
| front page | volunteer | 693 ms | 12.4 s | 642 ms |
| samples, mine | volunteer | 208 ms | 1.4 s | 22 ms |
| samples, mine, flagged | volunteer | 182 ms | 3.1 s | 49 ms |
| specimens, mine | volunteer | 362 ms | 751 ms | 178 ms |
| samples.csv, mine | volunteer | 122 ms | 1.5 s | 29 ms |
| sample page, own | volunteer | 323 ms | 2.7 s | 30 ms |
| specimen page, own | volunteer | 373 ms | 1.6 s | 85 ms |
| taxonomy index | volunteer | 203 ms | 519 ms | 344 ms |
| front page | staff | 730 ms | 9.2 s | 657 ms |
| samples, all | staff | 155 ms | 1.5 s | 80 ms |
| samples, all, last page | staff | 178 ms | 1.6 s | 242 ms |
| samples, all, search | staff | 322 ms | 1.6 s | 251 ms |
| specimens, all | staff | 358 ms | 883 ms | 180 ms |
| sample page, largest | staff | 331 ms | 3.3 s | 23 ms |
| people | staff | 62 ms | 14.1 s | 15.7 s |
| print runs | staff | 173 ms | 3.2 s | 476 ms |

Across all 30 cases: 7.0 s in DuckDB, 84.8 s ported, 34.9 s with the four views stored,
of which 30 s is the two People cases. Those are a different problem: the roster's
count of each person's legacy logins (`loginWeights` in
[`src/app/roster.ts`](../../src/app/roster.ts)) joins 314,466 legacy records to 580
people on `IS NOT DISTINCT FROM`, which DuckDB answers with a hash join and Postgres
cannot, so Postgres compares every pair. Written as an equality on `coalesce()`d names,
the same join took 88 ms instead of 2.9 s. `ingest/promote-legacy.sql` joins the legacy
records that way at least nine times, so legacy promotion would need the same rewrite.

What the stored views cost to bring up to date, each recomputed whole:
`qc_finding` 1.6 s, `observation_place` 1.4 s, `determination_of_record` 0.35 s,
`observation_locality` 0.32 s. The two observation views change only when a sync
does, which is the reason `observation_field` is already stored
([schema/060](../../schema/060_sync.sql)); `qc_finding` changes on every sample edit.

**One plan went badly wrong.** With only `qc_finding` stored, the volunteer's specimen
listing took 33 to 54 s: the new statistics led Postgres to scan the whole
`determination_of_record` view (210,499 rows) once for each of 4,109 specimens, where
before it had built it once. Storing that view too fixed it. A planner choosing a
different plan after its statistics change is ordinary Postgres behaviour, and a view
that is costly to compute is where it hurts.

## The nightly

The batch half of the work, measured by
[`bench/postgres/promotion.ts`](https://github.com/rainhead/beeline/blob/07fd0f37f6a08c6baf3bef749d84c725fd9cc1a3/bench/postgres/promotion.ts): observation
promotion in the order the nightly runs it, each run one transaction rolled back.

| Step | DuckDB | Postgres |
|---|--:|--:|
| refresh `observation_field` | 1,055 ms | 1,775 ms |
| `harvest-inat-accounts.sql` | 13 ms | 104 ms |
| `mint-samples.sql` | 590 ms | 9,564 ms |
| `promote-observations.sql` | 55 ms | 310 ms |

Twelve seconds is nothing at 2am. It matters on `/unclaimed`, which runs the same
promotion while an admin waits for the page; that took about 0.7 s on DuckDB.

Not measured: legacy promotion, the legacy export (a 160 MB `COPY`), the export
comparison, ITIS loading, the label sheets, and anything on the sandbox's two shared
CPUs. Nor is concurrency: Postgres's row locks would end the write conflicts that
[`src/write-conflict.ts`](../../src/write-conflict.ts) retries around, but
`bench:contention` was not run against it.

## Three differences that would not have raised an error

The comparison of views found, or the rules had to handle, three places where the same
SQL runs on both engines and means something different. `~` was the first such
construct ADR 0001 records.

- `\b` in a regular expression is a word boundary in DuckDB and a backspace in
  Postgres, which writes the boundary `\y`. The Canadian postcode rule in
  `observation_locality` uses it.
- `j ->> '$.name'` reads a JSONPath in DuckDB and, in Postgres, a key literally named
  `$.name`, so every field-value lookup in `schema/105` would have answered NULL.
- `round(latitude, 4)` prints `47.1` in DuckDB and `47.1000` in Postgres, by way of the
  numeric Postgres needs to round a double to places. It appears in QC finding text.

A fourth was found by checking the helper rather than by the data: DuckDB's
`try_cast('1.5' AS INTEGER)` is 2 and Postgres refuses the cast, so the helper rounds
by way of numeric as DuckDB does.

## What a move would buy back

From beeline-yfb and from building the nightly backup (rainhead/beeline#152), each
something DuckDB 1.5.5 cannot do and Postgres can:

- Change a deployed schema in place: add a constraint to an existing table, drop a
  column another table references, and do either inside a transaction. Today those are
  `db:reseed`, which stops being available at cutover.
- Update an indexed column on a row another table references
  (duckdb/duckdb#20246). `sample_atlas`, the print-run author columns and cancelling a
  print run are all shaped around that limit.
- Lock rows, so two writers to one row wait instead of one failing.
- Insert a row and its parent in one statement, or defer the check to commit. The
  backup copies `animal` one level of the tree at a time because DuckDB checks a
  foreign key only against rows already stored.
- Copy a whole database in one consistent snapshot while the app writes to it
  (`pg_dump`), and recover to a point in time. DuckDB has no online backup, so the
  backup copies rows, and the main and private stores in two transactions, since one
  transaction can write to only one attached database.

## The decision

Peter decided on 2026-10-16 to stay on DuckDB. What decided it is that Beeline has to
outlive the people building it, so whoever inherits it must be able to run it and change
it. Every way found of making Postgres as fast as DuckDB adds code that DuckDB does not
need. Stored QC findings have to be brought up to date after every sample edit, and the
code that does it has to know which other samples an edit can affect: renumbering one
sample can create or clear another sample's duplicate-number flag. Whoever adds a QC rule
would have to understand that code first. DuckDB computes the findings when they are
read, so a new rule is a new view and nothing more.

Looked at after the measurements above, and set aside:

- **Storing three views and leaving `qc_finding` computed on read.** Every page that
  shows flags still spent about 1.5 s in the database. Filtered to one sample,
  `qc_finding` itself takes 183 ms against 1.44 s whole. Eleven of its thirteen rules
  take 0.3 ms or less for one sample. The duplicate-number rule takes 124 ms and the
  missing-upstream rule 56 ms, because each counts across every sample or every sync
  run before keeping the one asked for.
- **[pg_ivm](https://github.com/sraoss/pg_ivm)**, an extension that keeps a stored view
  current with triggers. It can maintain none of the four views as written: three pick
  a row with `row_number() OVER (…)`, and `qc_finding` is a `UNION ALL` of views, some
  with `HAVING`. pg_ivm supports none of those, and reads only tables.
- **[Feldera](https://github.com/feldera/feldera)**, a separate engine that keeps SQL
  views current as their inputs change. Its Postgres connectors are marked
  experimental, its stable routes in and out of Postgres go through Kafka, and
  checkpoints are only in its paid edition, so the free edition recomputes everything
  after each restart (October 2026).
- **pg_duckdb**, which is no longer actively developed.

Staying costs what [What a move would buy back](#what-a-move-would-buy-back) lists,
from cutover on. The translator, its CI check and the benchmarks were removed, since
every new DuckDB-only construct would have needed a rule for a move nobody plans; the
silent differences below and the "never `~`" rule in ADR 0001 are what a later port
most needs, and they stay.

Were it revisited, a move would also mean running Postgres on the 3 GB Fly machine
beside the app, rewriting the deploy and backup runbooks, and porting the app's queries. The
translator already handles most of that: every query those 30 pages send, and the
three promotion files, ran on Postgres after two more rules (`INTERVAL 30 DAY`,
`CREATE OR REPLACE TEMP TABLE`). One thing it cannot see is the case of a name. DuckDB
matches `r.userLogin` to a column `userLogin` in any case, and Postgres matches it
only to `userlogin`, so the staging tables have to be created with unquoted names.

## Reproducing it

The tools were removed with the decision. They are at commit
[`07fd0f3`](https://github.com/rainhead/beeline/tree/07fd0f37f6a08c6baf3bef749d84c725fd9cc1a3), which the tag `postgres-port-2026-10` keeps reachable; check it out
in a worktree, and expect the translator to need rules for whatever DuckDB-only SQL
has been written since.

```sh
pnpm db:migrate <copy.duckdb>
tsx bench/postgres/load.ts <copy.duckdb> postgres://…/postgres [db] [--materialize=v1,v2]
tsx bench/postgres/compare-views.ts <copy.duckdb> postgres://…/<db>
tsx bench/postgres/pages.ts <copy.duckdb> postgres://…/<db> --n=5
tsx bench/postgres/promotion.ts <copy.duckdb> postgres://…/<db>
tsx bench/postgres/explain.ts <pages.json> postgres://…/<db> "<query prefix>" --page="<name>"
```

The loader needs the Postgres server on the same machine, since the server reads the
CSV files itself, and a role that may create databases, read server files and set
`session_replication_role`, which in practice means a superuser. Results stay out of
the repository: the recorded queries carry real people's ids as parameters.
