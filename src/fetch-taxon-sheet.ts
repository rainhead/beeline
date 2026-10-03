import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { accessToken, fileMeta, sheetTabs } from "./google-drive.js";

/**
 * A taxonomist's worksheet, as they left it, to disk (beeline-45v.1): every
 * tab of the Google Sheet as a CSV under data/taxon-decisions/<modified>/,
 * with a meta.json naming the sheet and when it was last touched. The
 * directory is the sheet's last-modified instant, so each version of the
 * sheet is its own snapshot and a second fetch of an unchanged sheet lands in
 * the same place; nothing is ever overwritten by a later version.
 *
 * Fetch and nothing more. The first version of this read the answers too —
 * matched the dropdown strings, prefix-matched "Keep…", picked an author's
 * surname out of free text — and that is the wrong tool: an answer comes
 * back as prose, a crossed-out proposal, a row added at the bottom, or an
 * email saying "mostly fine, except…", and a script that maps those with
 * confidence is exactly what a reviewer of a forty-row diff will not catch
 * (Peter, 2026-10-03). So the reading is a person's or a model's, from this
 * snapshot, and what gets recorded goes through `pnpm taxon:decide`, which
 * fills in the ITIS facts and validates every row. The snapshot is the
 * record of what was actually said, dated, for the diff later.
 *
 * Reads through the Sheets API with the same gcloud token the worksheet
 * export uses (src/google-drive.ts).
 */

export const DEFAULT_SNAPSHOT_DIR = "data/taxon-decisions";

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const safeName = (title: string) => title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

/** Two titles can sanitise to one name ("A B", "A-B"); the second gets a suffix rather than the first's file. */
export const snapshotFileNames = (titles: readonly string[]): string[] => {
  const taken = new Set<string>();
  return titles.map((t) => {
    const base = safeName(t) || "tab";
    let file = `${base}.csv`;
    for (let n = 2; taken.has(file); n++) file = `${base}-${n}.csv`;
    taken.add(file);
    return file;
  });
};

export async function fetchTaxonSheet(sheetId: string, dir: string = DEFAULT_SNAPSHOT_DIR): Promise<{ dir: string; tabs: { title: string; file: string; rows: number }[] }> {
  const token = accessToken();
  const meta = await fileMeta(token, sheetId);
  const tabs = await sheetTabs(token, sheetId);
  // 2026-10-07T14-32-11Z: the instant, with the colons a filename cannot hold.
  const out = join(dir, meta.modifiedTime.replace(/\.\d+Z$/, "Z").replaceAll(":", "-"));
  await mkdir(out, { recursive: true });
  const written = [];
  const files = snapshotFileNames(tabs.map((t) => t.title));
  for (const [n, tab] of tabs.entries()) {
    const width = Math.max(0, ...tab.rows.map((r) => r.length));
    const text = tab.rows.map((r) => Array.from({ length: width }, (_, i) => cell(r[i] ?? "")).join(",")).join("\n");
    const file = files[n]!;
    await writeFile(join(out, file), `${text}\n`);
    written.push({ title: tab.title, file, rows: Math.max(0, tab.rows.length - 1) });
  }
  await writeFile(join(out, "meta.json"), `${JSON.stringify({ id: meta.id, name: meta.name, modifiedTime: meta.modifiedTime, tabs: written }, null, 1)}\n`);
  return { dir: out, tabs: written };
}

// CLI: pnpm taxon:fetch-sheet <sheet-id> [dir]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [sheetId, dir] = process.argv.slice(2);
  if (sheetId === undefined) {
    console.error("usage: pnpm taxon:fetch-sheet <sheet-id> [dir]");
    process.exit(2);
  }
  console.log(JSON.stringify(await fetchTaxonSheet(sheetId, dir), null, 2));
}
