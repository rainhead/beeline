import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { readEml } from "./load-archive.js";

/**
 * The Darwin Core archive a museum publishes to GBIF, downloaded from the
 * publisher and unpacked for `pnpm archive:load` (beeline-muke).
 *
 * From the publisher, not from GBIF. GBIF's registry says where the
 * publisher's own archive is, and that is the file read: GBIF's copy of the
 * same records respells names to its own taxonomy (*Calliopsis anthidius*
 * becomes *anthidia*) and replaces some years with a timestamp, and its
 * download needs an account. Measured on OSAC's Oregon Bee Atlas dataset,
 * 2026-11-15: the same 64,927 records either way.
 *
 * An IPT, which is what OSAC publishes from, keeps its earlier versions at
 * the same address with `&v=<version>`, so `--version` reads one of those.
 * Whichever is asked for, the version recorded is the one the archive's own
 * eml.xml states.
 */

export const DEFAULT_ARCHIVES_DIR = "data/archives";

/** OSAC's archive is 2 MB zipped and 70 MB unpacked (65,000 records). */
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;

export interface FetchedArchive {
  datasetKey: string;
  version: string;
  publishedOn: string;
  url: string;
  /** The directory holding `occurrence.txt`, `eml.xml` and `meta.xml`. */
  dir: string;
}

export async function fetchArchive(opts: {
  datasetKey: string;
  version?: string;
  dir?: string;
  fetch?: typeof fetch;
}): Promise<FetchedArchive> {
  const get = opts.fetch ?? fetch;
  if (!/^[0-9a-f-]{36}$/.test(opts.datasetKey)) throw new Error(`${opts.datasetKey}: not a GBIF dataset key`);
  const registry = await get(`https://api.gbif.org/v1/dataset/${opts.datasetKey}`);
  if (!registry.ok) throw new Error(`GBIF's registry answered ${registry.status} for dataset ${opts.datasetKey}`);
  const dataset = (await registry.json()) as { endpoints?: Array<{ type?: string; url?: string }> };
  const endpoint = dataset.endpoints?.find((e) => e.type === "DWC_ARCHIVE")?.url;
  if (endpoint === undefined) throw new Error(`dataset ${opts.datasetKey} has no Darwin Core archive in GBIF's registry`);
  if (!endpoint.startsWith("https://")) throw new Error(`${endpoint}: the archive's address is not https`);
  let url = endpoint;
  if (opts.version !== undefined) {
    if (!/^[0-9]+(\.[0-9]+)*$/.test(opts.version)) throw new Error(`${opts.version}: not a version number`);
    if (!endpoint.includes("archive.do?r=")) {
      throw new Error(`${endpoint} is not an IPT's archive address, so an earlier version cannot be asked for`);
    }
    url = `${endpoint}&v=${opts.version}`;
  }
  const response = await get(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  // Read a piece at a time, so an answer far larger than an archive is
  // refused before it is all in memory.
  if (response.body === null) throw new Error(`${url} answered with nothing`);
  const pieces: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ZIP_BYTES) {
      await reader.cancel();
      throw new Error(`${url}: more than ${MAX_ZIP_BYTES} bytes, more than an archive is expected to be`);
    }
    pieces.push(value);
  }
  const zipped = new Uint8Array(size);
  let at = 0;
  for (const piece of pieces) {
    zipped.set(piece, at);
    at += piece.length;
  }
  // An archive is unpacked in memory, so no more than expected is: only the
  // files at its top level, where a Darwin Core archive keeps them, and
  // only up to a total.
  let unpacked = 0;
  const files = unzipSync(zipped, {
    filter: (f) => {
      if (f.name.includes("/")) return false;
      unpacked += f.originalSize;
      if (unpacked > MAX_UNPACKED_BYTES) throw new Error(`${url}: unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
      return true;
    },
  });
  const eml = files["eml.xml"];
  const meta = files["meta.xml"];
  if (eml === undefined || meta === undefined) throw new Error(`${url}: not a Darwin Core archive (no eml.xml or meta.xml)`);
  const stated = readEml(strFromU8(eml));
  if (stated.datasetKey !== opts.datasetKey) {
    throw new Error(`${url} is dataset ${stated.datasetKey}, not ${opts.datasetKey}`);
  }
  if (opts.version !== undefined && stated.version !== opts.version) {
    throw new Error(`${url} is version ${stated.version}, not ${opts.version}`);
  }
  // The core file, by the name meta.xml gives it; the loader reads it as occurrence.txt.
  const coreName = /<core\b[\s\S]*?<location>\s*([^<\s]+)\s*<\/location>/.exec(strFromU8(meta))?.[1];
  const core = coreName === undefined ? undefined : files[coreName];
  if (core === undefined) throw new Error(`${url}: meta.xml names no core file the archive holds`);
  const dir = join(opts.dir ?? DEFAULT_ARCHIVES_DIR, opts.datasetKey, stated.version);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "occurrence.txt"), core);
  await writeFile(join(dir, "eml.xml"), eml);
  await writeFile(join(dir, "meta.xml"), meta);
  return { ...stated, url, dir };
}

// CLI: pnpm archive:fetch <gbif-dataset-key> [--version <v>] [--dir <path>]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const valued = ["--version", "--dir"];
  const key = args.find((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1] ?? ""));
  if (key === undefined) {
    console.error("usage: pnpm archive:fetch <gbif-dataset-key> [--version <v>] [--dir <path>]");
    process.exit(2);
  }
  console.log(JSON.stringify(await fetchArchive({ datasetKey: key, version: option("--version"), dir: option("--dir") }), null, 2));
}
