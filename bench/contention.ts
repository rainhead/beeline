import { duckdbReader } from "../src/person-change.js";
import { promoteObservations } from "../src/promote-observations.js";
import { recordSampleChanges } from "../src/sample-change.js";
import {
  args,
  environment,
  isConflict,
  openBench,
  rows,
  sessionFor,
  summarize,
  table,
  timed,
  writeResult,
  type Bench,
  type Subject,
  type Timing,
} from "./lib.js";

/**
 * What happens when things overlap: pages while the nightly promotes, edits
 * while it promotes, two tabs on one session.
 *
 *   pnpm bench:contention [store.duckdb] [--seconds=20] [--readers=4] [--out=file.json]
 *
 * DuckDB has no row locks. Readers take a snapshot and never wait; two
 * transactions writing one row do not queue either — the second FAILS, at
 * once, with a conflict error. So the questions are whether pages slow down
 * beside a promotion (CPU is shared, snapshots are not free), and whether
 * any real pair of writers ever meets on a row. Each phase adds one thing to
 * the phase before it, so a difference has one cause:
 *
 *   reads               K readers, a session each, cycling the common pages
 *   one session         the same, all on ONE cookie — every request slides the
 *                       same session row, which is two tabs, or a page and
 *                       its CSV
 *   + edits             the readers beside a collector saving sample edits
 *                       through the form, ten a second at most
 *   + nightly           the readers beside promotion + the sample change pass,
 *                       looping on the job connection as the 2am run does
 *   + nightly + edits   all three
 *   + overlap           SYNTHETIC: a writer dirties the locality of unprinted
 *                       iNat-linked samples, which promotion rewrites. No
 *                       screen does this today (an iNat-linked sample is not
 *                       editable in the app); it is here to show what a
 *                       collision looks like and which side loses, because
 *                       the staff override screen will be exactly this writer.
 */

const { positional, flags } = args(process.argv.slice(2));
const source = positional[0] ?? "beeline.duckdb";
const seconds = Number(flags.seconds ?? 20);
const readerCount = Number(flags.readers ?? 4);

interface Failure {
  actor: string;
  conflict: boolean;
  message: string;
}

interface Phase {
  name: string;
  reads: Timing[];
  edits: Timing[];
  nightlyMs: number[];
  overlapWrites: number;
  failures: Failure[];
  /** What the app logged while the phase ran: a 500's body says nothing, its log line says why. */
  logged: string[];
  elapsedS: number;
}

const READ_MIX: { who: "volunteer" | "staff"; path: string }[] = [
  { who: "volunteer", path: "/" },
  { who: "volunteer", path: "/samples" },
  { who: "volunteer", path: "/specimens" },
  { who: "staff", path: "/samples?scope=all" },
  { who: "staff", path: "/specimens?scope=all" },
  { who: "staff", path: "/samples?scope=all&qc=flagged" },
];

const bench = await openBench(source);

const anotherSession = (of: Pick<Subject, "personId" | "inatUserId">) => sessionFor(bench, of);

/** The collector with the most samples the edit form will accept, and those samples. */
async function editor(b: Bench): Promise<{ who: Subject; samples: { id: number; locality: string }[] } | null> {
  const [top] = await rows<{ person_id: number; inat_user_id: number }>(
    b.jobConn,
    `SELECT a.person_id, a.inat_user_id
       FROM sample s
       JOIN sample_collector sc ON sc.sample_id = s.entity_id
       JOIN inat_account a ON a.person_id = sc.person_id
      WHERE s.inat_observation_id IS NULL
      GROUP BY ALL ORDER BY count(*) DESC, a.person_id LIMIT 1`,
  );
  if (top === undefined) return null;
  const samples = await rows<{ id: number; locality: string | null }>(
    b.jobConn,
    `SELECT s.entity_id AS id, s.locality
       FROM sample s JOIN sample_collector sc ON sc.sample_id = s.entity_id
      WHERE sc.person_id = ${top.person_id} AND s.inat_observation_id IS NULL
      ORDER BY s.entity_id LIMIT 200`,
  );
  const who = await anotherSession({ personId: Number(top.person_id), inatUserId: Number(top.inat_user_id) });
  return { who, samples: samples.map((s) => ({ id: Number(s.id), locality: s.locality ?? "" })) };
}

async function runPhase(
  name: string,
  opts: { sharedSession?: boolean; nightly?: boolean; edits?: boolean; overlap?: boolean },
): Promise<Phase> {
  const phase: Phase = { name, reads: [], edits: [], nightlyMs: [], overlapWrites: 0, failures: [], logged: [], elapsedS: 0 };
  const phaseStarted = performance.now();
  const consoleError = console.error;
  console.error = (...parts: unknown[]) => {
    phase.logged.push(parts.map((x) => (x instanceof Error ? x.message : String(x))).join(" ").slice(0, 200));
  };
  const until = performance.now() + seconds * 1000;
  const running = () => performance.now() < until;
  const fail = (actor: string, message: string) =>
    phase.failures.push({ actor, conflict: isConflict(message), message: message.slice(0, 200) });

  const shared = { volunteer: bench.volunteer, staff: bench.staff };
  const readers = Array.from({ length: readerCount }, async (_, i) => {
    const own = opts.sharedSession
      ? shared
      : { volunteer: await anotherSession(bench.volunteer), staff: await anotherSession(bench.staff) };
    for (let k = i; running(); k++) {
      const c = READ_MIX[k % READ_MIX.length]!;
      const t = await timed(bench, own[c.who], c.path);
      phase.reads.push(t);
      if (t.status !== 200) fail(`read ${c.path}`, t.error ?? `status ${t.status}`);
    }
  });

  const actors: Promise<unknown>[] = [...readers];

  if (opts.nightly) {
    actors.push(
      (async () => {
        while (running()) {
          const started = performance.now();
          try {
            await promoteObservations(bench.jobConn);
            await recordSampleChanges(
              duckdbReader(bench.jobConn),
              { log: bench.paths.sampleLog, state: bench.paths.sampleState },
              { source: "observation_promotion" },
            );
            phase.nightlyMs.push(performance.now() - started);
          } catch (err) {
            fail("nightly", (err as Error).message);
          }
        }
      })(),
    );
  }

  if (opts.edits) {
    const ed = await editor(bench);
    if (ed === null || ed.samples.length === 0) console.error("no editable samples in this store; the edit phase has no editor");
    else
      actors.push(
        (async () => {
          for (let k = 0; running(); k++) {
            const s = ed.samples[k % ed.samples.length]!;
            // Alternate between the locality it had and a marked one, so every
            // save is a real change and the store ends close to where it began.
            const next = k % 2 === 0 ? `${s.locality} (bench)`.trim() : s.locality;
            const t = await timed(bench, ed.who, `/samples/${s.id}/edit`, {
              method: "POST",
              body: new URLSearchParams({ locality: next, note: "bench" }),
              redirect: "manual",
            });
            phase.edits.push(t);
            // A save answers with a redirect home; 409 is a sample with no staging rows, not a failure of the store.
            if (t.status !== 302 && t.status !== 303 && t.status !== 409) fail(`edit ${s.id}`, t.error ?? `status ${t.status}`);
            await new Promise((r) => setTimeout(r, 100));
          }
        })(),
      );
  }

  if (opts.overlap) {
    const targets = (
      await rows<{ id: number }>(
        bench.jobConn,
        `SELECT s.entity_id AS id FROM sample s
          WHERE s.inat_observation_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM specimen sp WHERE sp.sample_id = s.entity_id)
          ORDER BY s.entity_id LIMIT 500`,
      )
    ).map((r) => Number(r.id));
    if (targets.length === 0) console.error("no unprinted iNat-linked samples; the overlap phase has no writer");
    else {
      const writer = await bench.instance.connect();
      actors.push(
        (async () => {
          try {
            for (let k = 0; running(); k++) {
              try {
                await writer.run(`UPDATE sample SET locality = 'bench overlap ${k}' WHERE entity_id = ${targets[k % targets.length]}`);
                phase.overlapWrites++;
              } catch (err) {
                fail("overlap writer", (err as Error).message);
              }
              await new Promise((r) => setTimeout(r, 20));
            }
          } finally {
            writer.closeSync();
          }
        })(),
      );
    }
  }

  try {
    await Promise.all(actors);
  } finally {
    console.error = consoleError;
  }
  // A phase ends when its last actor does, and a promotion pass that began
  // inside the window finishes outside it.
  phase.elapsedS = (performance.now() - phaseStarted) / 1000;
  return phase;
}

try {
  const env = await environment(bench, source);
  // The first change pass over a store is the baseline — a million cells, a
  // second or so — and belongs to no phase.
  await recordSampleChanges(
    duckdbReader(bench.jobConn),
    { log: bench.paths.sampleLog, state: bench.paths.sampleState },
    { source: "observation_promotion" },
  );
  // Likewise the first promotion: on a store that has not been promoted since
  // its last sync it mints and links for real. Every later pass is the steady
  // nightly, which is the one that runs every night.
  const firstPromotion = performance.now();
  await promoteObservations(bench.jobConn);
  const firstPromotionMs = Math.round(performance.now() - firstPromotion);
  for (const c of READ_MIX) await timed(bench, bench[c.who], c.path);

  const phases = [
    await runPhase("reads", {}),
    await runPhase("one session", { sharedSession: true }),
    await runPhase("+ edits", { edits: true }),
    await runPhase("+ nightly", { nightly: true }),
    await runPhase("+ nightly + edits", { nightly: true, edits: true }),
    await runPhase("+ overlap (synthetic)", { nightly: true, edits: true, overlap: true }),
  ];

  const report = phases.map((p) => {
    const reads = summarize(p.reads.filter((r) => r.status === 200).map((r) => r.ms));
    const edits = summarize(p.edits.filter((r) => r.status < 400).map((r) => r.ms));
    const nightly = summarize(p.nightlyMs);
    const by = (pred: (f: Failure) => boolean) => p.failures.filter(pred).length;
    return {
      phase: p.name,
      reads,
      readsPerSecond: Math.round((reads.n / p.elapsedS) * 10) / 10,
      elapsedS: Math.round(p.elapsedS * 10) / 10,
      edits,
      nightly,
      overlapWrites: p.overlapWrites,
      conflicts: {
        reads: by((f) => f.conflict && f.actor.startsWith("read")),
        edits: by((f) => f.conflict && f.actor.startsWith("edit")),
        nightly: by((f) => f.conflict && f.actor === "nightly"),
        overlapWriter: by((f) => f.conflict && f.actor === "overlap writer"),
      },
      // Requests that failed, whatever the reason; `loggedConflicts` is how
      // many of the app's own error lines in the phase were a conflict.
      failedReads: by((f) => f.actor.startsWith("read")),
      failedEdits: by((f) => f.actor.startsWith("edit")),
      loggedConflicts: p.logged.filter(isConflict).length,
      logged: [...new Set(p.logged)].slice(0, 8),
      otherFailures: by((f) => !f.conflict),
      // One of each distinct message: the wording is the finding.
      messages: [...new Map(p.failures.map((f) => [`${f.actor.split(" ")[0]}: ${f.message}`, f])).keys()].slice(0, 8),
    };
  });

  console.log(`\n${env.host} · ${env.cpu} · duckdb ${env.duckdb}, ${env.duckdbThreads} threads, ${env.duckdbMemoryLimit}`);
  console.log(`${env.storeMb} MB store · commit ${env.commit}${env.dirty ? "+" : ""} · ${readerCount} readers, ${seconds}s a phase · first promotion ${firstPromotionMs} ms\n`);
  console.log(
    table(
      ["phase", "reads/s", "read p50", "read p95", "read max", "edits", "edit p50", "edit p95", "passes", "pass p50", "failed reads", "failed edits", "nightly conflicts", "writer conflicts", "logged conflicts"],
      report.map((r) => [
        r.phase,
        r.readsPerSecond,
        r.reads.p50,
        r.reads.p95,
        r.reads.max,
        r.edits.n,
        r.edits.p50,
        r.edits.p95,
        r.nightly.n,
        r.nightly.p50,
        r.failedReads,
        r.failedEdits,
        r.conflicts.nightly,
        r.conflicts.overlapWriter,
        r.loggedConflicts,
      ]),
    ),
  );
  console.log("");
  for (const r of report) for (const m of [...r.messages, ...r.logged.map((l) => `logged: ${l}`)]) console.log(`[${r.phase}] ${m}`);
  console.log(`\n(milliseconds) → ${await writeResult("contention", { env, seconds, readers: readerCount, firstPromotionMs, phases: report }, flags.out)}`);
} finally {
  await bench.close();
}
