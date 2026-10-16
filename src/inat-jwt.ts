import { readFile } from "node:fs/promises";

/**
 * Fresh 24h JWT from the stored pipeline access token — same source the CLI
 * uses (dev: Peter's registration; production: its own, beeline-5ep).
 * Missing token or failed mint throws: never silently anonymous.
 *
 * It is the app's token, never a volunteer's: volunteers' OAuth tokens were
 * dropped (beeline-cj6), and an authenticated read of a project is what
 * yields the true coordinates, which only the project's curator token sees.
 */
export async function mintPipelineJwt(fetchImpl: typeof fetch = fetch): Promise<string> {
  const { access_token } = JSON.parse(await readFile("data/secrets/inat-oauth-token", "utf8")) as {
    access_token: string;
  };
  const res = await fetchImpl("https://www.inaturalist.org/users/api_token", {
    headers: { Authorization: `Bearer ${access_token}` },
    signal: AbortSignal.timeout(30_000), // a hung mint must not stall the scheduler
  });
  if (!res.ok) throw new Error(`JWT mint failed (${res.status}) — aborting rather than syncing anonymously`);
  return ((await res.json()) as { api_token: string }).api_token;
}

let cached: { token: string; at: number } | null = null;

/**
 * The same token, minted at most once an hour, for the dashboard's "Check
 * iNaturalist now" (beeline-yso): a click should not cost a mint, and a JWT
 * lives a day. The nightly mints its own each run. `forgetPipelineJwt` drops
 * it, for a 401 after the stored token was replaced.
 */
export async function cachedPipelineJwt(maxAgeMs = 3_600_000): Promise<string> {
  if (cached !== null && Date.now() - cached.at < maxAgeMs) return cached.token;
  const token = await mintPipelineJwt();
  cached = { token, at: Date.now() };
  return token;
}

export function forgetPipelineJwt(): void {
  cached = null;
}
