import { readFile } from "node:fs/promises";

const MANIFEST_URL = new URL("../../dist/app/.vite/manifest.json", import.meta.url);
const ISLANDS_ENTRY = "src/app/islands/index.ts";

/**
 * URL of the built islands bundle, from Vite's manifest — re-read per call so
 * `vite build --watch` output is picked up without a server restart. Null when
 * the islands haven't been built; pages then render server-only, which every
 * page must survive anyway.
 */
export async function islandsSrc(): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(MANIFEST_URL, "utf8")) as Record<string, { file: string }>;
    const entry = manifest[ISLANDS_ENTRY];
    return entry ? `/${entry.file}` : null;
  } catch {
    return null;
  }
}
