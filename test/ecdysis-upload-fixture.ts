import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { createKysely } from "../src/db.js";
import { cachedArchivePath, describeFetch, ECDYSIS_COLLECTIONS } from "../src/fetch-ecdysis.js";
import { CURRENT_SEASON, createMemoryDb, insertCleanSample, rows } from "./helpers.js";

/**
 * A store with invented people and specimens for the upload to Ecdysis
 * (beeline-8dx9.12), shared by the tests of the files and of the Exports page.
 */

export const WABA = ECDYSIS_COLLECTIONS.find((c) => c.program === "WaBA")!;
export const BC = ECDYSIS_COLLECTIONS.find((c) => c.program === "BC")!;
export const HOUR = 3_600_000;

/** A job_run detail the way describeFetch writes one for a collection that was read. */
export const readDetail = (c: typeof WABA, source: "downloaded" | "cached" = "cached") =>
  describeFetch({
    scope: c.datasetId !== undefined ? `dataset ${c.datasetId}` : `collection ${c.collectionId}`,
    source,
    reason: "unchanged since 2026-11-01 (3 records)",
    load: { loaded: 0, matched: 0, occurrences: 3, catalogNumbers: 0, ambiguousCatalogNumbers: 0, ambiguousIdentifications: 0, adopted: [], filedUnder: [], unresolvedNames: [] } as never,
  });

type Spec = {
  field: string | null;
  program?: "WaBA" | "BC" | "OBA";
  year?: number;
  /** Sample columns, as SQL. */
  sample?: Record<string, string>;
  /** The specimen's number in its sample. */
  n?: number;
};

export async function fixture() {
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
  const specimen = async ({ field, program: code = "WaBA", year = CURRENT_SEASON, sample = {}, n = 1 }: Spec) => {
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
  /** A successful nightly read of the collections, started this long ago. */
  const readHoursAgo = (hours: number, detail: string, outcome: "succeeded" | "failed" = "succeeded") =>
    conn.run(
      `INSERT INTO job_run (job_name, started_at, completed_at, outcome, detail)
       VALUES ('ecdysis-fetch', now() - INTERVAL '${hours} hours', now() - INTERVAL '${hours} hours', '${outcome}', '${detail.replaceAll("'", "''")}')`,
    );
  const dir = await mkdtemp(join(tmpdir(), "beeline-ecdysis-"));
  /** The archive last downloaded for a collection, holding these catalog numbers (some of which match no specimen). */
  const cacheArchive = async (c: typeof WABA, catalogNumbers: string[]) => {
    const occurrences = ["id\tcatalogNumber\trecordID", ...catalogNumbers.map((n, i) => `${i + 1}\t${n}\tuuid-${i}`)].join("\n") + "\n";
    await writeFile(cachedArchivePath(dir, c), zipSync({ "occurrences.tab": strToU8(occurrences), "identifications.tab": strToU8("coreid\trecordID\n") }));
  };
  return { instance, conn, db, dir, casey, eva, vic, specimen, determine, readHoursAgo, cacheArchive };
}

