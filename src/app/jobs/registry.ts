import { readFile } from "node:fs/promises";
import type { Kysely } from "kysely";
import { deriveElevations } from "../../derive-elevation.js";
import type { Database } from "../../model.js";
import { promoteObservations } from "../../promote-observations.js";
import { syncINat } from "../../sync-inat.js";
import type { AppConfig } from "../config.js";
import { purgeIdleSessions } from "../session.js";
import type { Job, JobContext } from "./framework.js";

/**
 * Fresh 24h JWT from the stored pipeline access token — same source the CLI
 * uses (dev: Peter's registration; production: its own, beeline-5ep).
 * Missing token or failed mint aborts the job: never silently anonymous.
 */
async function mintJwt(): Promise<string> {
  const { access_token } = JSON.parse(await readFile("data/secrets/inat-oauth-token", "utf8")) as {
    access_token: string;
  };
  const res = await fetch("https://www.inaturalist.org/users/api_token", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) throw new Error(`JWT mint failed (${res.status}) — aborting rather than syncing anonymously`);
  return ((await res.json()) as { api_token: string }).api_token;
}

/** Start of the most recent completed sync run for a source, or null. */
export async function lastSyncStart(db: Kysely<Database>, source: string): Promise<Date | null> {
  const row = await db
    .selectFrom("sync_run")
    .where("source", "=", source)
    .where("completed_at", "is not", null)
    .select(({ fn }) => fn.max("started_at").as("at"))
    .executeTakeFirst();
  return row?.at ?? null;
}

/** Overlap margin for incremental runs: re-fetching an hour twice is free (hash-dedup). */
const UPDATED_SINCE_MARGIN_MS = 60 * 60 * 1000;

const sweepStart = (sweepDays: number) => new Date(Date.now() - sweepDays * 86_400_000).toISOString().slice(0, 10);

/** Promote and elevation, shared by both sync jobs. */
async function pipelineTail(ctx: JobContext, parts: string[]): Promise<string> {
  const promoted = await ctx.step("promote observations", () => promoteObservations(ctx.conn));
  parts.push(`${promoted.linkedSamples} samples linked`);
  const elevation = await ctx.step("derive elevations", () => deriveElevations(ctx.conn));
  parts.push(
    `elevation ${elevation.filled}/${elevation.gaps} filled` +
      (elevation.missingTiles.length > 0 ? ` (missing tiles: ${elevation.missingTiles.join(", ")})` : ""),
  );
  return parts.join("; ");
}

export function buildJobs(config: Pick<AppConfig, "syncProjects" | "sweepDays">): Job[] {
  return [
    {
      name: "session-purge",
      schedule: { kind: "everyMinutes", minutes: 60 },
      window: "interactive",
      async run(ctx) {
        await ctx.step("purge idle sessions", () => purgeIdleSessions(ctx.db));
      },
    },
    {
      // Incremental ingestion (beeline-3hj): updated_since catches edits and
      // creations of any-aged observation since the last run. First run ever
      // for a source falls back to a full sweep of the presence window.
      name: "nightly-pipeline",
      schedule: { kind: "dailyLA", hour: 2 },
      window: "night",
      async run(ctx) {
        if (config.syncProjects.length === 0) {
          return "no projects configured (BEELINE_SYNC_PROJECTS) — nothing to sync";
        }
        const token = await ctx.step("mint JWT", mintJwt);
        const parts: string[] = [];
        for (const projectId of config.syncProjects) {
          const last = await lastSyncStart(ctx.db, String(projectId));
          if (last === null) {
            const d1 = sweepStart(config.sweepDays);
            const r = await ctx.step(`first full sweep ${projectId}`, () => syncINat(ctx.conn, { projectId, d1, token }));
            parts.push(`project ${projectId} (first sweep since ${d1}): ${r.fetched} fetched, ${r.newLoads} new`);
          } else {
            const updatedSince = new Date(last.getTime() - UPDATED_SINCE_MARGIN_MS).toISOString();
            const r = await ctx.step(`incremental ${projectId}`, () => syncINat(ctx.conn, { projectId, updatedSince, token }));
            parts.push(`project ${projectId} (updated since ${updatedSince.slice(0, 16)}Z): ${r.fetched} fetched, ${r.newLoads} new`);
          }
        }
        return pipelineTail(ctx, parts);
      },
    },
    {
      // Anti-entropy (beeline-3hj): a full presence sweep of the trailing
      // window — the only kind of run that can prove an observation gone
      // (deletion detection reads covering runs; incremental runs are not).
      name: "weekly-sweep",
      schedule: { kind: "weeklyLA", weekday: 0, hour: 3 },
      window: "night",
      async run(ctx) {
        if (config.syncProjects.length === 0) {
          return "no projects configured (BEELINE_SYNC_PROJECTS) — nothing to sweep";
        }
        const token = await ctx.step("mint JWT", mintJwt);
        const d1 = sweepStart(config.sweepDays);
        const parts: string[] = [];
        for (const projectId of config.syncProjects) {
          const r = await ctx.step(`sweep ${projectId}`, () => syncINat(ctx.conn, { projectId, d1, token }));
          parts.push(`project ${projectId} (full sweep since ${d1}): ${r.fetched} fetched, ${r.newLoads} new`);
        }
        return pipelineTail(ctx, parts);
      },
    },
  ];
}
