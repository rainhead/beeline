# Benchmarks

Two questions, asked of the real app against a copy of a real store, so that a change to the engine, a query, or the machine can be judged against a number rather than a feeling.

- **`pnpm bench:pages [store]`** — how long each page takes, one request at a time: the pages people open, as the store's most prolific collector (the worst case for `mine`) and as staff (every listing is the whole corpus), plus the one write a volunteer makes, saving a sample edit. `--compare=<result.json>` adds a column against an earlier run, and `--only=<text>` runs just the cases whose "who and name" contain the text, in any case (the first column and the page name, such as `staff samples, all`). The two whole-corpus downloads (`staff samples.csv, all` and `staff specimens.xlsx, all`, tens of seconds each) run only when `--only` names them, and it matches by containment, so `--only=all` or `--only=samples` pulls a full download in as well as the pages. To run just the downloads, name each in a run of its own, `--only='csv, all' --n=3` for the samples CSV and `--only='xlsx, all' --n=3` for the specimens Excel file, since each would add minutes to a plain run. With `--only`, the sample-edit write runs only if `volunteer save a sample edit` contains the text.
- **`pnpm bench:contention [store]`** — what happens when things overlap. Each phase adds one actor to the one before — readers, readers on one session, a collector saving edits, the nightly promotion looping, and a synthetic writer on rows promotion rewrites — and reports latency beside every failure, with conflicts counted apart. DuckDB has no row locks: readers never wait, and the second of two writers to one row fails at once rather than queueing, so "contention" here is two different things, shared CPU and conflict errors, and the phases keep them apart.

Both drive the app through `app.request` — every route, the session gate, SSR — with real sessions behind the real resolver, because the resolver writes on every request and a benchmark that skipped it would measure a read-only app that does not exist. What is left out is the network.

## The store is always a copy

The benchmarks write, and exactly one process may hold a store ([ADR 0005](../docs/adr/0005-app-process-owns-the-store.md)). [`lib.ts`](lib.ts) copies the file and its WAL into a temporary directory (`BENCH_TMP`, else the system's), migrates the copy forward, and deletes the lot afterwards (`BENCH_KEEP=1` keeps it). Subjects — which sample, which genus, which collector — are chosen from the store by rule, so the same file runs anywhere, and results carry no names, logins, or record ids: the repository is public.

## Results are only comparable within an environment

A result file records the kind of machine (never its hostname), DuckDB's thread and memory budgets, the store's size, the commit and the flags it was run with; under each summary it keeps every timing as taken and a count of what each request answered, so a later reader can compute the statistic nobody thought of. Error text is reduced to its class before it is written — DuckDB quotes the offending value in a constraint error, and the store is real people's records. The first sandbox baseline predates the raw timings and holds summaries only; the next run there replaces it. Compare like with like: the workstation runs the same pages two to three times faster than the sandbox, and says nothing about it. Baselines live in [`results/`](results/).

## Running on the machine

These ran on the sandbox until it was retired on 2026-11-05. The only Fly machine now is production's — two shared vCPUs, DuckDB at two threads and 1.5 GB, 3 GB in all ([`fly.production.toml`](../fly.production.toml)) — and a run there slows the site for everyone using it and competes with the live app for memory. So run it there only when nobody is on the site and with Peter's say-so; otherwise run locally against a downloaded nightly backup, and compare only with other local runs. The image carries `src/` and `tsx` but not `bench/`, so the files are uploaded to a directory a deploy erases, run beside the live app against a copy of its store, and removed:

```sh
fly ssh console --app beeline-production -C "mkdir -p /app/bench"
for f in lib.ts pages.ts contention.ts; do fly ssh sftp put --app beeline-production bench/$f /app/bench/$f; done
fly ssh sftp put --app beeline-production --mode 0755 bench/on-machine.sh /app/bench/on-machine.sh
fly ssh console --app beeline-production -C "/app/bench/on-machine.sh pages --n=15"
fly ssh console --app beeline-production -C "/app/bench/on-machine.sh contention --seconds=30"
fly ssh sftp get --app beeline-production /app/data/bench-tmp/pages.json bench/results/pages-production-$(date +%F).json
fly ssh console --app beeline-production -C "rm -rf /app/bench /app/data/bench-tmp"
```

It is a second DuckDB entitled to a gigabyte beside the live app; [`on-machine.sh`](on-machine.sh) refuses to start unless the memory is there, and says why a lower cap is not the answer. The site is slow for everyone while it runs — about three minutes each, when the CPU is not throttled.

**It can drain the CPU burst balance.** The machine's shared vCPUs may run flat out only while a burst balance lasts, and are held to a lower baseline once it is spent. On 2026-11-07 `on-machine.sh pages --n=15` spent the balance within minutes and then ran throttled (89% of CPU time stolen in `/proc/stat`; Fly's metrics showed the balance empty for 48 minutes). It was stopped after 50 minutes, and the live site was slow throughout. `on-machine.sh` checks memory before it starts but not steal or the balance (beeline-f6k8), so check them yourself: do not start a run when steal is already high or Fly's metrics show a low balance, and stop it if steal climbs. The `cpu` line of `/proc/stat` counts since boot, so read it twice a few seconds apart: steal is the growth of its eighth figure as a share of the growth of all the figures together. The safer course is to run locally against a downloaded nightly backup. The uploaded `bench/` must match the deployed `src/`: run it from the commit that is deployed. Shared vCPUs are throttled once their burst balance is spent, so a second run straight after a first can read slower than it should. The first baseline has one such outlier — a single 40-second save in an otherwise steady column, on the third run in a row — whose cause was not established; read the p50, and rerun before believing a max.
