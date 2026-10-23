import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import {
  governanceFor,
  LICENSES,
  readProgramGovernance,
  type GovernancePaths,
  type LicenseId,
} from "../program-governance.js";
import { identificationsOf, programArchives, specimenArchiveStream } from "./dwc-archive.js";
import { EMPTY_QUERY, listSpecimens, OUTSIDE } from "./listings.js";

/**
 * The program archives, one per program per season, written nightly
 * (beeline-rvun, Peter 2026-10-10) into `<exportsDir>/dwca/`, with a manifest
 * the Exports page reads.
 *
 * Every program-season with specimens is written, whatever its program has
 * decided, so staff can download and review them (Peter, 2026-10-23). The
 * licence and the privacy policy (src/program-governance.ts) are what a
 * season needs before it is *published*, not before it is written: the
 * licence in force goes into `meta.xml`, and the manifest records what the
 * season still lacks. An archive for a program-season that no longer has
 * specimens is removed at the next run.
 */

export interface ArchiveEntry {
  program: string;
  name: string;
  season: number;
  /** Specimens the program holds for the season, written or not. */
  specimens: number;
  license: LicenseId | null;
  /** The privacy policy's page; null where there is no policy, or a policy with no page yet. */
  policyUrl: string | null;
  policy: boolean;
  /** The archive's file name in the directory; null only in a manifest written before every season was. */
  file: string | null;
  bytes: number | null;
}

export interface ArchiveManifest {
  writtenAt: string;
  entries: ArchiveEntry[];
}

export const archiveDir = (exportsDir: string) => join(exportsDir, "dwca");
export const archiveFileName = (program: string, season: number) => `${program}-${season}.zip`;
const MANIFEST = "manifest.json";

/** Specimens per program and season, by the same scopes the archives read. */
async function countsBySeason(db: Kysely<Database>): Promise<Map<string, Map<number, number>>> {
  const rows = await db
    .selectFrom("specimen as sp")
    .innerJoin("sample_season as ss", "ss.sample_id", "sp.sample_id")
    .leftJoin("sample_atlas as sa", "sa.sample_id", "sp.sample_id")
    .leftJoin("atlas as a", "a.entity_id", "sa.atlas_id")
    .select(["a.code as atlas_code", "ss.season", sql<number>`count(*)`.as("n")])
    .groupBy(["a.code", "ss.season"])
    .execute();
  const counts = new Map<string, Map<number, number>>();
  for (const r of rows) {
    // An atlas's code is its listing scope; no atlas is `outside`.
    const scope = r.atlas_code ?? OUTSIDE;
    const bySeason = counts.get(scope) ?? new Map<number, number>();
    bySeason.set(Number(r.season), Number(r.n));
    counts.set(scope, bySeason);
  }
  return counts;
}

async function writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<number> {
  const tmp = `${path}.tmp`;
  try {
    await pipeline(Readable.fromWeb(stream as NodeReadableStream<Uint8Array>), createWriteStream(tmp));
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return (await stat(path)).size;
}

export interface WriteArchivesOptions {
  governance?: GovernancePaths;
  now?: Date;
  /** Run before each archive, so a job can time it as a step and stop between them. */
  step?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
}

/** Write every program-season with specimens, list each with what publishing it still lacks, and remove the rest. */
export async function writeProgramArchives(
  db: Kysely<Database>,
  exportsDir: string,
  opts: WriteArchivesOptions = {},
): Promise<ArchiveManifest> {
  const dir = archiveDir(exportsDir);
  await mkdir(dir, { recursive: true });
  const governance = await readProgramGovernance(opts.governance);
  const counts = await countsBySeason(db);
  const step = opts.step ?? ((_label, fn) => fn());
  const entries: ArchiveEntry[] = [];
  for (const program of await programArchives(db)) {
    if (program.scope === null) continue;
    const scope = program.scope;
    const seasons = [...(counts.get(scope) ?? new Map<number, number>()).entries()].sort(([a], [b]) => a - b);
    for (const [season, specimens] of seasons) {
      const { license, policy } = governanceFor(governance, program.code, season);
      const entry: ArchiveEntry = {
        program: program.code,
        name: program.name,
        season,
        specimens,
        license: license?.license ?? null,
        policyUrl: policy === null || policy.url === "" ? null : policy.url,
        policy: policy !== null,
        file: archiveFileName(program.code, season),
        bytes: null,
      };
      const query = { ...EMPTY_QUERY, scope };
      entry.bytes = await step(`${program.code} ${season}`, () =>
        writeStream(
          join(dir, entry.file!),
          specimenArchiveStream(
            async (limit, offset) => {
              const page = await listSpecimens(db, query, 0, { limit, offset, withTotal: false, season });
              return { ...page, identifications: await identificationsOf(db, page.rows.map((r) => r.specimen_id)) };
            },
            { license: license === null ? null : LICENSES[license.license].url },
          ),
        ),
      );
      entries.push(entry);
    }
  }
  // Whatever is in the directory and was not written tonight is removed.
  const written = new Set(entries.flatMap((e) => (e.file === null ? [] : [e.file])));
  for (const name of await readdir(dir)) {
    if (name.endsWith(".zip") && !written.has(name)) await rm(join(dir, name), { force: true });
  }
  const manifest: ArchiveManifest = { writtenAt: (opts.now ?? new Date()).toISOString(), entries };
  const tmp = join(dir, `${MANIFEST}.tmp`);
  await writeFile(tmp, JSON.stringify(manifest, null, 2));
  await rename(tmp, join(dir, MANIFEST));
  return manifest;
}

/** The manifest the last run wrote, or null before the first. */
export async function readArchiveManifest(exportsDir: string): Promise<ArchiveManifest | null> {
  try {
    return JSON.parse(await readFile(join(archiveDir(exportsDir), MANIFEST), "utf8")) as ArchiveManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** One line for the job's detail: what was written, and how much of it is not yet publishable, and why. */
export function describeManifest(m: ArchiveManifest): string {
  const noLicense = m.entries.filter((e) => e.license === null).length;
  const noPolicy = m.entries.filter((e) => !e.policy).length;
  return `${m.entries.length} program-seasons written (${m.entries.reduce((n, e) => n + e.specimens, 0)} specimens); ${noLicense} without a licence, ${noPolicy} without a privacy policy`;
}
