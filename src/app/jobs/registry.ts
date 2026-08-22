import { readFile } from "node:fs/promises";
import { deriveElevations } from "../../derive-elevation.js";
import { promoteObservations } from "../../promote-observations.js";
import { syncINat } from "../../sync-inat.js";
import type { AppConfig } from "../config.js";
import { purgeIdleSessions } from "../session.js";
import type { Job } from "./framework.js";

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

export function buildJobs(config: Pick<AppConfig, "syncProjects" | "syncDays">): Job[] {
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
      // The whole ingestion chain, in the ADR 0005 night carve-out.
      name: "nightly-pipeline",
      schedule: { kind: "dailyLA", hour: 2 },
      window: "night",
      async run(ctx) {
        if (config.syncProjects.length === 0) {
          return "no projects configured (BEELINE_SYNC_PROJECTS) — nothing to sync";
        }
        const token = await ctx.step("mint JWT", mintJwt);
        const d1 = new Date(Date.now() - config.syncDays * 86_400_000).toISOString().slice(0, 10);
        const parts: string[] = [];
        for (const projectId of config.syncProjects) {
          const r = await ctx.step(`sync project ${projectId}`, () => syncINat(ctx.conn, { projectId, d1, token }));
          parts.push(`project ${projectId}: ${r.fetched} fetched, ${r.newLoads} new`);
        }
        const promoted = await ctx.step("promote observations", () => promoteObservations(ctx.conn));
        parts.push(`${promoted.linkedSamples} samples linked`);
        const elevation = await ctx.step("derive elevations", () => deriveElevations(ctx.conn));
        parts.push(
          `elevation ${elevation.filled}/${elevation.gaps} filled` +
            (elevation.missingTiles.length > 0 ? ` (missing tiles: ${elevation.missingTiles.join(", ")})` : ""),
        );
        return parts.join("; ");
      },
    },
  ];
}
