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
import { checklistArchive, programChecklist } from "./dwc-checklist.js";
import { EMPTY_QUERY, listSpecimens, OUTSIDE, STAFF_READER } from "./listings.js";

/**
 * The program archives, one per program per year, written nightly
 * (beeline-rvun, Peter 2026-10-10) into `<exportsDir>/dwca/`, with a manifest
 * the Exports page reads.
 *
 * A year is the calendar year a sample was collected in, by its first day,
 * because that is how the taxonomists who receive these records count
 * (Peter, 2026-10-23). That is also what a season is (sample_season,
 * schema/102, since beeline-rxn8), so an archive holds one season.
 *
 * Every program-year with specimens is written, whatever its program has
 * decided, so staff can download and review them (Peter, 2026-10-23). The
 * licence and the privacy policy (src/program-governance.ts) are what a year
 * needs before it is *published*, not before it is written: the licence in
 * force goes into `meta.xml`, and the manifest records what the year still
 * lacks. An archive for a program-year that no longer has specimens is
 * removed at the next run.
 *
 * Beside them, each program with specimens gets one checklist covering every
 * year (src/app/dwc-checklist.ts, beeline-024a).
 */

export interface ArchiveEntry {
  program: string;
  name: string;
  /** The calendar year the specimens were collected in. */
  year: number;
  /** Specimens the program holds for the year. */
  specimens: number;
  /** The licence in force when the archive was written, which is the one its `meta.xml` states. */
  license: LicenseId | null;
  /** The privacy policy's page; null where there is no policy, or a policy with no page yet. */
  policyUrl: string | null;
  policy: boolean;
  /** The archive's file name in the directory. */
  file: string;
  bytes: number;
}

/** A program's checklist, every year at once. */
export interface ChecklistEntry {
  program: string;
  /** Names on it, ancestors included. */
  taxa: number;
  file: string;
  bytes: number;
}

export interface ArchiveManifest {
  writtenAt: string;
  entries: ArchiveEntry[];
  /** Absent from a manifest written before there were checklists. */
  checklists?: ChecklistEntry[];
}

export const archiveDir = (exportsDir: string) => join(exportsDir, "dwca");
export const archiveFileName = (program: string, year: number) => `${program}-${year}.zip`;
export const checklistFileName = (program: string) => `${program}-checklist.zip`;
const MANIFEST = "manifest.json";

/** Specimens per program and year, by the same scopes and the same year the archives read. */
async function countsByYear(db: Kysely<Database>): Promise<Map<string, Map<number, number>>> {
  const year = sql<number>`extract(year from s.date_start)`;
  const rows = await db
    .selectFrom("specimen as sp")
    .innerJoin("sample as s", "s.entity_id", "sp.sample_id")
    .leftJoin("sample_atlas as sa", "sa.sample_id", "sp.sample_id")
    .leftJoin("atlas as a", "a.entity_id", "sa.atlas_id")
    .select(["a.code as atlas_code", year.as("year"), sql<number>`count(*)`.as("n")])
    .groupBy(["a.code", year])
    .execute();
  const counts = new Map<string, Map<number, number>>();
  for (const r of rows) {
    // An atlas's code is its listing scope; no atlas is `outside`.
    const scope = r.atlas_code ?? OUTSIDE;
    const byYear = counts.get(scope) ?? new Map<number, number>();
    byYear.set(Number(r.year), Number(r.n));
    counts.set(scope, byYear);
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

/** Write every program-year with specimens, list each with what publishing it still lacks, and remove the rest. */
export async function writeProgramArchives(
  db: Kysely<Database>,
  exportsDir: string,
  opts: WriteArchivesOptions = {},
): Promise<ArchiveManifest> {
  const dir = archiveDir(exportsDir);
  await mkdir(dir, { recursive: true });
  const governance = await readProgramGovernance(opts.governance);
  const counts = await countsByYear(db);
  const step = opts.step ?? ((_label, fn) => fn());
  const entries: ArchiveEntry[] = [];
  const checklists: ChecklistEntry[] = [];
  for (const program of await programArchives(db)) {
    if (program.scope === null) continue;
    const scope = program.scope;
    const years = [...(counts.get(scope) ?? new Map<number, number>()).entries()].sort(([a], [b]) => a - b);
    if (years.length > 0) {
      const file = checklistFileName(program.code);
      const taxa = await step(`${program.code} checklist`, async () => {
        const rows = await programChecklist(db, scope);
        const tmp = join(dir, `${file}.tmp`);
        try {
          await writeFile(tmp, checklistArchive(rows));
          await rename(tmp, join(dir, file));
        } catch (err) {
          await rm(tmp, { force: true });
          throw err;
        }
        return rows.length;
      });
      checklists.push({ program: program.code, taxa, file, bytes: (await stat(join(dir, file))).size });
    }
    for (const [year, specimens] of years) {
      const { license, policy } = governanceFor(governance, program.code, year);
      const file = archiveFileName(program.code, year);
      const query = { ...EMPTY_QUERY, scope };
      const bytes = await step(`${program.code} ${year}`, () =>
        writeStream(
          join(dir, file),
          specimenArchiveStream(
            async (limit, offset) => {
              const page = await listSpecimens(db, query, 0, STAFF_READER, { limit, offset, withTotal: false, year });
              return { ...page, identifications: await identificationsOf(db, page.rows.map((r) => r.specimen_id)) };
            },
            { license: license === null ? null : LICENSES[license.license].url },
          ),
        ),
      );
      entries.push({
        program: program.code,
        name: program.name,
        year,
        specimens,
        license: license?.license ?? null,
        policyUrl: policy === null || policy.url === "" ? null : policy.url,
        policy: policy !== null,
        file,
        bytes,
      });
    }
  }
  // Whatever is in the directory and was not written tonight is removed.
  const written = new Set([...entries, ...checklists].map((e) => e.file));
  for (const name of await readdir(dir)) {
    if (name.endsWith(".zip") && !written.has(name)) await rm(join(dir, name), { force: true });
  }
  const manifest: ArchiveManifest = { writtenAt: (opts.now ?? new Date()).toISOString(), entries, checklists };
  const tmp = join(dir, `${MANIFEST}.tmp`);
  await writeFile(tmp, JSON.stringify(manifest, null, 2));
  await rename(tmp, join(dir, MANIFEST));
  return manifest;
}

/**
 * The manifest the last run wrote, or null before the first — and before the
 * first since the archives were cut by year rather than by season, since an
 * older manifest names files by a season that may not be the year.
 */
export async function readArchiveManifest(exportsDir: string): Promise<ArchiveManifest | null> {
  try {
    const manifest = JSON.parse(await readFile(join(archiveDir(exportsDir), MANIFEST), "utf8")) as ArchiveManifest;
    return manifest.entries.every((e) => typeof e.year === "number") ? manifest : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** One line for the job's detail: what was written, and how much of it is not yet publishable, and why. */
export function describeManifest(m: ArchiveManifest): string {
  const noLicense = m.entries.filter((e) => e.license === null).length;
  const noPolicy = m.entries.filter((e) => !e.policy).length;
  return `${m.entries.length} program-years written (${m.entries.reduce((n, e) => n + e.specimens, 0)} specimens) and ${(m.checklists ?? []).length} checklists; ${noLicense} without a licence, ${noPolicy} without a privacy policy`;
}
