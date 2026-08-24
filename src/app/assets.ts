import { readdir, readFile, stat } from "node:fs/promises";

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

const STATIC_DIR = new URL("static/", import.meta.url);

/**
 * A cache-busting stamp for the stylesheets: the newest mtime among them.
 *
 * The static files carry no version in their names, and a browser with no
 * cache headers to go on caches them heuristically — which means a CSS change
 * reaches nobody until they hard-reload, in development and after a deploy
 * alike (Peter hit exactly this, 2026-08-23). Re-read per call so an edit
 * shows up without restarting the server; a handful of stats per page render
 * is nothing next to the queries beside them.
 */
export async function styleVersion(): Promise<string> {
  try {
    const names = (await readdir(STATIC_DIR)).filter((name) => name.endsWith(".css"));
    const times = await Promise.all(names.map(async (name) => (await stat(new URL(name, STATIC_DIR))).mtimeMs));
    return Math.floor(Math.max(0, ...times)).toString(36);
  } catch {
    return "0";
  }
}
