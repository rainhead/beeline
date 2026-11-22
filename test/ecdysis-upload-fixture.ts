import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { createKysely } from "../src/db.js";
import { cachedArchivePath, ECDYSIS_COLLECTIONS, readMarkerPath, type EcdysisCollection } from "../src/fetch-ecdysis.js";
import { UPLOAD_CONSTANTS } from "../src/app/ecdysis-upload.js";
import { CURRENT_SEASON, SETTLED_SEASON, createMemoryDb, insertCleanSample, rows } from "./helpers.js";

/**
 * A store with invented people and specimens for the upload to Ecdysis
 * (beeline-8dx9.12), shared by the tests of the files and of the Data tab.
 */

export const WABA = ECDYSIS_COLLECTIONS.find((c) => c.program === "WaBA")!;
export const BC = ECDYSIS_COLLECTIONS.find((c) => c.program === "BC")!;
export const HOUR = 3_600_000;
/** British Columbia's offered years as the code sets them, before a test changes them. */
export const BC_OFFERED_YEARS_IN_CODE = [...UPLOAD_CONSTANTS.BC!.years];

type Spec = {
  field: string | null;
  program?: "WaBA" | "BC" | "OBA";
  year?: number;
  /** Sample columns, as SQL. */
  sample?: Record<string, string>;
  /** The specimen's number in its sample. */
  n?: number;
};

/**
 * A store of invented people and specimens. A specimen is British Columbia's
 * unless it says otherwise, since only a collection Beeline reads whole is
 * offered files.
 */
export async function fixture() {
  // The setting names a written year; a test offers the seasons its fixtures are dated in, never a year it writes.
  UPLOAD_CONSTANTS.BC!.years = [CURRENT_SEASON, SETTLED_SEASON];
  const { instance, conn } = await createMemoryDb();
  const db = createKysely(instance);
  const person = async (name: string) =>
    ((await rows(conn, `INSERT INTO person (display_name, given_name, family_name) VALUES ('${name}', '${name.split(" ")[0]}', '${name.split(" ")[1]}') RETURNING entity_id`)) as [[number]])[0][0];
  const casey = await person("Casey Collector");
  const eva = await person("Eva Expert");
  const vic = await person("Vic Volunteer");
  for (const [rank, name] of [["species", "Bombus vosnesenskii"], ["species", "Bombus mixtus"], ["species", "Andrena prunorum"], ["genus", "Lasioglossum"]]) {
    await conn.run(`INSERT INTO animal (rank, scientific_name, authorship) VALUES ('${rank}', '${name}', ${name === "Bombus mixtus" ? "'Cresson, 1878'" : "NULL"})`);
  }
  const program = (code: string) => `(SELECT entity_id FROM program WHERE code = '${code}')`;
  let sampleSeq = 0;
  /** One specimen with its own sample. */
  const specimen = async ({ field, program: code = "BC", year = CURRENT_SEASON, sample = {}, n = 1 }: Spec) => {
    const day = `DATE '${year}-07-14'`;
    const isBc = code === "BC";
    const id = await insertCleanSample(conn, {
      sample_number: `'S${++sampleSeq}'`,
      specimen_count: "1",
      date_start: day,
      date_end: day,
      atlas_id: program(code),
      collector_id: String(casey),
      country: isBc ? "'CAN'" : "'USA'",
      state_province: isBc ? "'BC'" : code === "OBA" ? "'OR'" : "'WA'",
      county: "'Kittitas'",
      locality: "'Umtanum Creek'",
      ...sample,
    });
    const [[spec]] = (await rows(conn, `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${id}, ${n}, ${field === null ? "NULL" : `'${field}'`}) RETURNING entity_id`)) as [[number]];
    return { sample: id, id: spec };
  };
  const determine = (specimenId: number, animal: string, who: { person?: number; name?: string }, expert: boolean, extra: { on?: string; precision?: string; sex?: string; caste?: string; recorded?: string; qualifier?: string } = {}) =>
    conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_id, determiner_name, verbatim_identification, determined_on, determined_on_precision, sex, caste, qualifier, recorded_at)
       VALUES (${specimenId}, (SELECT entity_id FROM animal WHERE scientific_name = '${animal}'),
               ${expert}, 'in_app', ${who.person ?? "NULL"}, ${who.name === undefined ? "NULL" : `'${who.name}'`}, '${animal}',
               ${extra.on === undefined ? "NULL" : `DATE '${extra.on}'`}, ${extra.precision === undefined ? "NULL" : `'${extra.precision}'`},
               ${extra.sex === undefined ? "NULL" : `'${extra.sex}'`}, ${extra.caste === undefined ? "NULL" : `'${extra.caste}'`},
               ${extra.qualifier === undefined ? "NULL" : `'${extra.qualifier}'`}, TIMESTAMPTZ '${extra.recorded ?? "2026-05-01 10:00:00"}+00')`,
    );
  const dir = await mkdtemp(join(tmpdir(), "beeline-ecdysis-"));
  /**
   * The archive last downloaded for a collection, holding these catalog numbers (some of which match no specimen),
   * and the marker the fetch leaves for a read that began this many hours ago and loaded it.
   */
  const cacheArchive = async (c: EcdysisCollection, catalogNumbers: string[], opts: { readHoursAgo?: number; header?: string; source?: "downloaded" | "cached" } = {}) => {
    const header = opts.header ?? "catalogNumber";
    const occurrences = [`id\t${header}\trecordID`, ...catalogNumbers.map((n, i) => `${i + 1}\t${n}\tuuid-${i}`)].join("\n") + "\n";
    await writeFile(cachedArchivePath(dir, c), zipSync({ "occurrences.tab": strToU8(occurrences), "identifications.tab": strToU8("coreid\trecordID\n") }));
    await writeMarker(c, opts.readHoursAgo ?? 1, catalogNumbers.length, opts.source ?? "downloaded");
  };
  /** The marker for a read that began this many hours ago and loaded the zip as it is on disk now. */
  const writeMarker = async (c: EcdysisCollection, hoursAgo: number, records = 0, source: "downloaded" | "cached" = "downloaded") => {
    const st = await stat(cachedArchivePath(dir, c));
    await writeFile(
      readMarkerPath(dir, c),
      JSON.stringify({
        scope: c.collectionId !== undefined ? `collection ${c.collectionId}` : `dataset ${c.datasetId}`,
        readAt: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
        source,
        zipBytes: st.size,
        zipModifiedAt: st.mtime.toISOString(),
        records,
      }),
    );
  };
  return { instance, conn, db, dir, casey, eva, vic, specimen, determine, cacheArchive, writeMarker };
}

/**
 * What a refusal at a POST's address says, from the page it is shown in, which must also link back to the program's
 * Data tab (reloading that address would repeat the POST). Exact: the sentence is the callout's whole text.
 */
export async function refusalSaid(res: Response, code = "BC"): Promise<string> {
  const page = await res.text();
  if (!page.includes(`<a href="/programs/${code}/data">Go back to the Data tab</a>`)) throw new Error("the refusal does not link back to the Data tab");
  const callout = /<div class="callout warning">([^]*?)<\/div>/.exec(page);
  if (callout === null) throw new Error("no refusal on the page");
  return callout[1]!.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
