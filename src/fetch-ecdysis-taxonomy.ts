import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Fetch the insects of Ecdysis's taxonomic thesaurus (beeline-7gob): the
 * names the curated taxonomy is matched against, in place of ITIS.
 *
 * Ecdysis is the Symbiota portal the program's taxonomists already determine
 * in, so its thesaurus holds the names they use — the bee subgenera, the
 * potter wasps, Brachymelecta where ITIS still says Xeromelecta — which ITIS
 * does not (beeline-45v.1.2). Symbiota exports a branch of the thesaurus as
 * CSV from its taxonomy display page (TaxonomyDisplayManager::exportCsv): every
 * name in the branch with its rank, author, parent, and whether it is accepted
 * or a synonym of which name, plus the chain of names above the branch. No
 * sign-in is needed.
 *
 * Insecta in one export fails, as does Coleoptera — Ecdysis answers 500, or
 * an empty body, a limit on the server's side, presumably time or memory — so
 * the branch is split: a taxon whose export fails that way is asked for its
 * children
 * (taxa/taxonomy/rpc/getdynamicchildren.php) and each is exported in turn, down
 * to whatever size the server will answer. On 2026-10-23 an order answered in
 * about ten seconds (Hymenoptera, 138,652 names). Requests are made one at a
 * time: this is somebody else's server.
 *
 * Targets are given by Ecdysis's own id, never by name: the page reads a
 * name as a prefix (`Bombus` matches every name that begins so), and an id
 * is unambiguous.
 *
 * What it writes is one CSV of every row the exports held, at every rank,
 * read back from PHP's CSV dialect into ordinary CSV, and a manifest saying
 * what was asked for and when. src/load-ecdysis-taxonomy.ts puts that into a
 * store. Ecdysis's text is kept as Ecdysis stores it: some Lepidoptera and
 * Diptera authors, and a few Diptera names, are stored double-encoded
 * (`OberthÃ¼r`), which no bee name is, and repairing them here would make the
 * store disagree with Ecdysis about what it says.
 */

const EXPORT_URL = "https://ecdysis.org/taxa/taxonomy/taxonomydisplay.php";
const CHILDREN_URL = "https://ecdysis.org/taxa/taxonomy/rpc/getdynamicchildren.php";
const API_URL = "https://ecdysis.org/api/v2/taxonomy";
const USER_AGENT = "beeline (https://github.com/rainhead/beeline)";

/** Where `pnpm ecdysis:taxonomy` keeps the fetch, relative to the working directory like every other data/ input. */
export const LIVE_ECDYSIS_TAXONOMY_DIR = "data/ecdysis-taxonomy";
export const TAXA_FILE = "ecdysis-taxa.csv";
export const MANIFEST_FILE = "manifest.json";

/** The columns of the CSV this writes, in order: the export's, less the ones nothing here reads. */
export const TAXA_COLUMNS = ["tid", "name", "author", "rank_id", "parent_tid", "status", "accepted_tid"] as const;

export interface FetchedExport {
  tid: number;
  name: string;
  rows: number;
}

export interface FetchEcdysisTaxonomyResult {
  /** The CSV written. */
  path: string;
  fetchedAt: string;
  /** Distinct names written, at every rank. */
  taxa: number;
  /** The branches that were exported whole, in the order they were asked for. */
  exports: FetchedExport[];
}

export interface FetchEcdysisTaxonomyOptions {
  dir?: string;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: Date;
  /** Told of each export as it lands; the CLI prints them. */
  progress?: (message: string) => void;
  /** How long to wait before asking again after a failed export; 15 seconds, and 0 in tests. */
  retryDelayMs?: number;
}

const within = (ms: number, signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

/**
 * PHP's CSV, as fputcsv writes it: RFC 4180, except that a backslash inside a
 * quoted field makes the character after it literal — so `\"` is a backslash
 * and a quote, not the field's end, and fputcsv does not double that quote.
 * Two authors in the 2026-10-23 Lepidoptera export need it
 * (`Ã\x83â\x80\"zdikmen`); a standard parser reads each of those rows as 18
 * fields.
 */
export function parsePhpCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === "\\" && i + 1 < text.length) {
        field += c + text[i + 1];
        i++;
      } else if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const EXPORT_HEADER = [
  "taxonID",
  "scientificName",
  "scientificNameAuthorship",
  "unitName1",
  "unitName2",
  "unitInd3",
  "unitName3",
  "cultivarEpithet",
  "tradeName",
  "rankID",
  "kingdomName",
  "family",
  "parentTaxonID",
  "parentScientificName",
  "acceptance",
  "acceptedTaxonID",
  "acceptedScientificName",
] as const;

export type TaxonRow = Record<(typeof TAXA_COLUMNS)[number], string>;

/** An export's rows in this module's columns. Throws on a header or a row that is not the export's shape. */
export function readExport(text: string, where: string): TaxonRow[] {
  const records = parsePhpCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (records.length === 0) return [];
  const header = records[0]!;
  if (header.join(",") !== EXPORT_HEADER.join(",")) {
    throw new Error(`${where}: the export's header is '${header.join(",")}', not Symbiota's taxonomy export`);
  }
  const at = Object.fromEntries(EXPORT_HEADER.map((c, j) => [c, j])) as Record<(typeof EXPORT_HEADER)[number], number>;
  return records.slice(1).map((r, n) => {
    const v = (c: (typeof EXPORT_HEADER)[number]) => (r[at[c]] ?? "").trim();
    // An accepted id comes from a LEFT JOIN in Symbiota's export, so it can
    // be empty; a row without one would fail the load's NOT NULL unnamed.
    const shaped = /^\d+$/.test(v("taxonID")) && /^\d+$/.test(v("rankID")) && /^\d+$/.test(v("acceptedTaxonID"));
    if (r.length !== EXPORT_HEADER.length || !shaped || !["0", "1"].includes(v("acceptance"))) {
      throw new Error(`${where} row ${n + 2}: not the export's shape (${r.length} fields)`);
    }
    return {
      tid: v("taxonID"),
      name: v("scientificName"),
      author: v("scientificNameAuthorship"),
      rank_id: v("rankID"),
      parent_tid: v("parentTaxonID"),
      status: v("acceptance") === "1" ? "accepted" : "synonym",
      accepted_tid: v("acceptedTaxonID"),
    };
  });
}

/** One request for an export: the CSV, `too large` for a 500 or an empty body, or `unavailable` for a gateway's 502, 503 or 504. */
async function askForExport(f: typeof fetch, tid: number, signal?: AbortSignal): Promise<string | "too large" | "unavailable"> {
  const body = new URLSearchParams({
    target: String(tid),
    displayauthor: "1",
    displaysubgenera: "1",
    displayfulltree: "1",
    taxauthid: "1",
    tdsubmit: "exportTaxonTree",
  });
  let res: Response;
  try {
    res = await f(EXPORT_URL, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: within(300_000, signal),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw new Error(`Ecdysis took more than five minutes to export taxon ${tid}`);
    throw err;
  }
  if (res.status === 500) return "too large";
  if ([502, 503, 504].includes(res.status)) return "unavailable";
  if (!res.ok) throw new Error(`Ecdysis answered ${res.status} to the export of taxon ${tid}`);
  const text = await res.text();
  return text.replace(/^\uFEFF/, "").trim() === "" ? "too large" : text;
}

/**
 * The export's CSV, or null where Ecdysis could not make it. A failure is
 * asked again once, after a pause, before it is believed: a 500 is how a
 * branch too large to export answers, and also how a passing fault answers,
 * and a genus mistaken for too large is split into one request per species.
 */
async function exportBranch(f: typeof fetch, tid: number, retryDelayMs: number, signal?: AbortSignal): Promise<string | null> {
  let answer = await askForExport(f, tid, signal);
  if (answer === "too large" || answer === "unavailable") {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    answer = await askForExport(f, tid, signal);
  }
  if (answer === "unavailable") throw new Error(`Ecdysis was unavailable for the export of taxon ${tid}, twice`);
  return answer === "too large" ? null : answer;
}

interface Child {
  tid: number;
  name: string;
}

/** A taxon's accepted children, as the tree browser lists them. */
async function children(f: typeof fetch, tid: number, signal?: AbortSignal): Promise<Child[]> {
  const res = await f(`${CHILDREN_URL}?id=${tid}`, { headers: { "User-Agent": USER_AGENT }, signal: within(60_000, signal) });
  if (!res.ok) throw new Error(`Ecdysis answered ${res.status} for the children of taxon ${tid}`);
  const json = (await res.json()) as { children?: { id: number | string; label?: string }[] };
  // The label is `<taxauthid>-<rankid>-<rank name>-<scientific name>`.
  return (json.children ?? []).map((c) => ({ tid: Number(c.id), name: String(c.label ?? "").split("-").slice(3).join("-") }));
}

/** Insecta's id, asked of the API rather than written down, and refused unless exactly one accepted Insecta answers. */
async function insectaTid(f: typeof fetch, signal?: AbortSignal): Promise<number> {
  const res = await f(`${API_URL}?taxon=Insecta`, { headers: { "User-Agent": USER_AGENT }, signal: within(60_000, signal) });
  if (!res.ok) throw new Error(`Ecdysis's taxonomy API answered ${res.status}`);
  const { results = [] } = (await res.json()) as { results?: { tid: number; rankID: number; kingdomName: string }[] };
  const classes = results.filter((t) => t.rankID === 60 && t.kingdomName === "Animalia");
  if (classes.length !== 1) throw new Error(`expected one class Insecta in Ecdysis, found ${classes.length}`);
  return classes[0]!.tid;
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

export async function fetchEcdysisTaxonomy(options: FetchEcdysisTaxonomyOptions = {}): Promise<FetchEcdysisTaxonomyResult> {
  const f = options.fetch ?? fetch;
  const dir = options.dir ?? LIVE_ECDYSIS_TAXONOMY_DIR;
  const say = options.progress ?? (() => {});
  const fetchedAt = (options.now ?? new Date()).toISOString();

  const taxa = new Map<string, TaxonRow>();
  const exports: FetchedExport[] = [];
  const visit = async (target: Child): Promise<void> => {
    const text = await exportBranch(f, target.tid, options.retryDelayMs ?? 15_000, options.signal);
    if (text !== null) {
      const rows = readExport(text, `the export of ${target.name} (${target.tid})`);
      // A branch's export repeats the chain above it, so the same name
      // arrives from every branch; the first copy stands.
      for (const row of rows) if (!taxa.has(row.tid)) taxa.set(row.tid, row);
      exports.push({ tid: target.tid, name: target.name, rows: rows.length });
      say(`${target.name}: ${rows.length} names`);
      return;
    }
    // The tree browser lists a taxon's accepted children by their parent, and
    // the export walks Symbiota's ancestor index: a name filed under a
    // synonym directly below a split taxon (Thysanura under Insecta) could in
    // principle fall between the two. Ateluridae, below Thysanura, is in the
    // fetch of 2026-10-23, because the index files it under the accepted name.
    const below = await children(f, target.tid, options.signal);
    if (below.length === 0) throw new Error(`Ecdysis could not export ${target.name} (${target.tid}), which has no children to split it into`);
    say(`${target.name}: too large to export whole, splitting into ${below.length}`);
    for (const child of below) await visit(child);
  };
  await visit({ tid: await insectaTid(f, options.signal), name: "Insecta" });

  await mkdir(dir, { recursive: true });
  const path = join(dir, TAXA_FILE);
  const lines = [TAXA_COLUMNS.join(","), ...[...taxa.values()].map((r) => TAXA_COLUMNS.map((c) => cell(r[c])).join(","))];
  // Into a temp file first, so a failed fetch never replaces a good one.
  await writeFile(`${path}.tmp`, `${lines.join("\n")}\n`);
  await rename(`${path}.tmp`, path);
  const manifest = join(dir, MANIFEST_FILE);
  await writeFile(`${manifest}.tmp`, `${JSON.stringify({ fetchedAt, taxa: taxa.size, exports }, null, 2)}\n`);
  await rename(`${manifest}.tmp`, manifest);
  return { path, fetchedAt, taxa: taxa.size, exports };
}
