import { readFile } from "node:fs/promises";
import { duckdbReader } from "../src/person-change.js";
import { recordSampleChanges } from "../src/sample-change.js";
import { args, environment, openBench, pageCases, rows, samples, sessionFor, statusCounts, summarize, table, timed, writeResult, type Case, type Subject, type Summary } from "./lib.js";

/**
 * How long each page takes, one request at a time, against a copy of a store.
 *
 *   pnpm bench:pages [store.duckdb] [--n=15] [--out=file.json] [--compare=baseline.json]
 *
 * The cases are the pages people actually open, as the two kinds of people
 * who open them: the store's most prolific collector, for whom `mine` is as
 * expensive as it gets, and a member of staff, for whom every listing is the
 * whole corpus. Subjects — which sample, which genus — are chosen from the
 * store by rule rather than written down, so the same file runs against the
 * dev store, the sandbox's, and a synthetic one, and none of the results name
 * anybody.
 *
 * Sequential on purpose. This is the number a change to a query moves; what
 * happens when requests overlap is `bench:contention`'s question.
 */

interface CaseResult extends Case, Summary {
  status: number;
  kb: number;
  /** The first request, before anything is warm: what the first visitor after a deploy waits for. */
  coldMs: number;
  /** Every warm timing as taken, and what every request (the cold one included) answered. */
  ms: number[];
  statuses: Record<string, number>;
}

const { positional, flags } = args(process.argv.slice(2));
const source = positional[0] ?? "beeline.duckdb";
const n = Number(flags.n ?? 15);

const bench = await openBench(source);
try {
  const env = await environment(bench, source);
  const results: CaseResult[] = [];
  for (const c of await pageCases(bench)) {
    const who: Subject = bench[c.who];
    const cold = await timed(bench, who, c.path);
    const runs = [];
    for (let i = 0; i < n; i++) runs.push(await timed(bench, who, c.path));
    const bad = [cold, ...runs].find((r) => r.status !== 200);
    if (bad) console.error(`! ${c.who} ${c.path} answered ${bad.status}${bad.error ? `: ${bad.error}` : ""}`);
    results.push({
      ...c,
      // Which record it was is this store's business: an id is a per-store
      // draw, and the repository the result is committed to is public.
      path: c.path.replace(/\/\d+/g, "/:id"),
      ...summarize(runs.map((r) => r.ms)),
      status: bad?.status ?? 200,
      kb: Math.round(cold.bytes / 1024),
      coldMs: Math.round(cold.ms * 10) / 10,
      ms: samples(runs.map((r) => r.ms)),
      statuses: statusCounts([cold, ...runs]),
    });
  }

  // The one write a volunteer makes. Measured like a page — cold, then n more —
  // each save a real change to a different sample, since a save that changes
  // nothing skips the work.
  const [ed] = await rows<{ person_id: number; inat_user_id: number }>(
    bench.jobConn,
    `SELECT a.person_id, a.inat_user_id FROM sample s
       JOIN sample_collector sc ON sc.sample_id = s.entity_id
       JOIN inat_account a ON a.person_id = sc.person_id
      WHERE s.inat_observation_id IS NULL
      GROUP BY ALL ORDER BY count(*) DESC, a.person_id LIMIT 1`,
  );
  if (ed !== undefined) {
    // The copy has no change snapshot yet, and a save that falls on a missing
    // one becomes the baseline pass — a different, one-off cost.
    await recordSampleChanges(
      duckdbReader(bench.jobConn),
      { log: bench.paths.sampleLog, state: bench.paths.sampleState },
      { source: "observation_promotion" },
    );
    const who =await sessionFor(bench, { personId: Number(ed.person_id), inatUserId: Number(ed.inat_user_id) });
    const editable = await rows<{ id: number; locality: string | null }>(
      bench.jobConn,
      `SELECT s.entity_id AS id, s.locality FROM sample s
         JOIN sample_collector sc ON sc.sample_id = s.entity_id
        WHERE sc.person_id = ${ed.person_id} AND s.inat_observation_id IS NULL
        ORDER BY s.entity_id LIMIT ${n + 1}`,
    );
    const saves = [];
    for (const s of editable) {
      saves.push(
        await timed(bench, who, `/samples/${s.id}/edit`, {
          method: "POST",
          body: new URLSearchParams({ locality: `${s.locality ?? ""} (bench)`.trim(), note: "bench" }),
        }),
      );
    }
    const [cold, ...rest] = saves;
    if (cold !== undefined && rest.length > 0) {
      const bad = saves.find((r) => r.status !== 302);
      if (bad) console.error(`! sample edit answered ${bad.status}${bad.error ? `: ${bad.error}` : ""}`);
      results.push({
        name: "save a sample edit",
        who: "volunteer",
        path: "POST /samples/:id/edit",
        ...summarize(rest.map((r) => r.ms)),
        status: bad?.status ?? 302,
        kb: 0,
        coldMs: Math.round(cold.ms * 10) / 10,
        ms: samples(rest.map((r) => r.ms)),
        statuses: statusCounts(saves),
      });
    }
  }

  const baseline = flags.compare
    ? new Map(
        (JSON.parse(await readFile(flags.compare, "utf8")).results as CaseResult[]).map((r) => [`${r.who} ${r.name}`, r]),
      )
    : null;
  const change = (r: CaseResult) => {
    const was = baseline?.get(`${r.who} ${r.name}`);
    if (!was || was.p50 === 0) return "";
    const pct = Math.round(((r.p50 - was.p50) / was.p50) * 100);
    return `${pct > 0 ? "+" : ""}${pct}%`;
  };

  console.log(`\n${env.host} · ${env.cpu} · duckdb ${env.duckdb}, ${env.duckdbThreads} threads, ${env.duckdbMemoryLimit}`);
  console.log(`${env.storeMb} MB store · ${env.rows.sample} samples, ${env.rows.specimen} specimens · commit ${env.commit}${env.dirty ? "+" : ""} · n=${n}\n`);
  console.log(
    table(
      ["who", "page", "status", "kB", "cold", "p50", "p95", "max", ...(baseline ? ["vs baseline p50"] : [])],
      results.map((r) => [r.who, r.name, r.status, r.kb, r.coldMs, r.p50, r.p95, r.max, ...(baseline ? [change(r)] : [])]),
    ),
  );
  console.log(`\n(milliseconds) → ${await writeResult("pages", { env, n, results }, flags.out)}`);
} finally {
  await bench.close();
}
