import { dirname, join } from "node:path";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { CSV_BOM, csvLine } from "../src/app/listings.js";
import { parseCsvRecords } from "../src/app/upload-plan.js";
import { createMemoryDb, insertCleanSample, SETTLED_SEASON, rows, scratchPaths } from "./helpers.js";

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

/**
 * A store for the upload tests, built from the real schema: three specimens of
 * one sample from the current season (`a1` with an expert's determination,
 * `a2` with none, `a3` with a volunteer's and no field number) and one of a
 * sample from a settled season (`b1`). The app answers as staff, or as a
 * volunteer when asked, and `download()` is its own specimens CSV, which the
 * tests edit.
 */
export async function uploadFixture(
  signedInAs: "staffer" | "volunteer" = "staffer",
  /** `unprinted` adds a sample (UP-3) whose one specimen is in a print run that has not printed. */
  options: { unprinted?: boolean } = {},
) {
  const { instance, conn } = await createMemoryDb();
  const person = async (name: string) => {
    const [given, family] = name.split(" ");
    const [[id]] = (await rows(
      conn,
      `INSERT INTO person (display_name, given_name, family_name) VALUES ('${name}', '${given}', '${family}') RETURNING entity_id`,
    )) as [[number]];
    return id;
  };
  const staffer = await person("Sam Staff");
  const volunteer = await person("Vera Volunteer");
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staffer})`);

  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('genus', 'Bombus')`);
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id, authorship)
     SELECT 'species', 'Bombus vosnesenskii', entity_id, 'Radoszkowski, 1862' FROM animal WHERE scientific_name = 'Bombus'`,
  );
  const sampleA = await insertCleanSample(conn, { collector_id: String(volunteer), sample_number: "'UP-1'", specimen_count: "3", locality: "'Corvallis'" });
  const sampleB = await insertCleanSample(conn, {
    collector_id: String(volunteer),
    sample_number: "'UP-2'",
    specimen_count: "1",
    locality: "'Philomath'",
    date_start: `DATE '${SETTLED_SEASON}-06-02'`,
    date_end: `DATE '${SETTLED_SEASON}-06-02'`,
  });
  const specimen = async (sample: number, n: number, fieldNumber: string | null) => {
    const [[id]] = (await rows(
      conn,
      `INSERT INTO specimen (sample_id, specimen_number, field_number)
       VALUES (${sample}, ${n}, ${fieldNumber === null ? "NULL" : `'${fieldNumber}'`}) RETURNING entity_id`,
    )) as [[number]];
    return id;
  };
  const a1 = await specimen(sampleA, 1, "OBA10001");
  const a2 = await specimen(sampleA, 2, "OBA10002");
  const a3 = await specimen(sampleA, 3, null);
  const b1 = await specimen(sampleB, 1, "OBA10004");
  const determine = (id: number, expert: boolean, by: string, extra = "") =>
    conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_name, verbatim_identification, sex, determined_on ${extra === "" ? "" : ", determined_on_precision"})
       SELECT ${id}, entity_id, ${expert}, 'ecdysis_import', '${by}', 'Bombus vosnesenskii', 'female', DATE '2024-05-03' ${extra === "" ? "" : `, ${extra}`}
       FROM animal WHERE scientific_name = 'Bombus vosnesenskii'`,
    );
  await determine(a1, true, "Dee Determiner");
  await determine(a3, false, "A Volunteer");
  await determine(b1, false, "A Volunteer");

  const ids: { a1: number; a2: number; a3: number; b1: number; sampleA: number; sampleB: number; c1?: number; sampleC?: number } = {
    a1,
    a2,
    a3,
    b1,
    sampleA,
    sampleB,
  };
  if (options.unprinted) {
    // A label in a run that has not printed, with its number minted by that run: not on paper (schema/101).
    const sampleC = await insertCleanSample(conn, { collector_id: String(volunteer), sample_number: "'UP-3'", specimen_count: "1", locality: "'Albany'" });
    const c1 = await specimen(sampleC, 1, "OBA10005");
    await conn.run(`INSERT INTO print_run (prepared_by) VALUES (${staffer})`);
    await conn.run(
      `INSERT INTO minted_field_number (field_number, print_run_id, specimen_id)
       SELECT 'OBA10005', max(entity_id), ${c1} FROM print_run`,
    );
    await conn.run(
      `INSERT INTO printed_label (print_run_id, specimen_id, sheet, cell, location_text, coordinates_text, date_text,
                                  collector_text, method_text, number_text, latitude, longitude, date_start, date_end)
       SELECT (SELECT max(entity_id) FROM print_run), ${c1}, 1, 0, 'USA:OR:BentonCo', '44.5 -123.6', 'd', 'c', 'net', 'OBA10005',
              44.5, -123.6, s.date_start, s.date_end
       FROM sample s WHERE s.entity_id = ${sampleC}`,
    );
    ids.c1 = c1;
    ids.sampleC = sampleC;
  }
  const resolved = signedInAs === "staffer" ? staffer : volunteer;
  const db = createKysely(instance);
  const paths = await scratchPaths();
  const app = createApp({
    ...paths,
    db,
    conn,
    // Sandbox, not development: development makes everyone an admin (beeline-6va).
    config: { environment: "sandbox" as const, origin: "http://localhost:3054", exportsDir: join(dirname(paths.uploadsDir), "exports") },
    inat: unusedInat,
    resolveSession: async () => ({ personId: resolved, login: signedInAs, iconUrl: null }),
  });

  const download = async () => (await app.request("/specimens.csv?scope=all")).text();
  return { instance, conn, db, app, paths, staffer, volunteer, ids, download };
}

export type UploadFixture = Awaited<ReturnType<typeof uploadFixture>>;

/** A file's cells, header first. */
export const readRecords = (csv: string): string[][] => parseCsvRecords(csv.replace(/^﻿/, ""));

/**
 * An edited copy of the download: each entry sets cells of the row whose
 * `specimenId` it names. Written the way a spreadsheet would, with a BOM, so
 * a cell that needs quoting is quoted. `dropColumns` leaves columns out.
 */
export function edited(
  download: string,
  edits: Array<{ id: number; set: Record<string, string> }> = [],
  options: { dropColumns?: string[]; lineEnding?: "\n" | "\r\n"; dropRows?: number[] } = {},
): string {
  const records = readRecords(download);
  const head = records[0]!;
  const idAt = head.indexOf("specimenId");
  const drop = new Set((options.dropColumns ?? []).map((c) => head.indexOf(c)));
  const kept = records
    .filter((r, i) => i === 0 || !(options.dropRows ?? []).includes(Number(r[idAt])))
    .map((r, i) => {
      if (i > 0) {
        const edit = edits.filter((e) => String(e.id) === r[idAt]);
        r = r.map((cell, at) => {
          const name = head[at]!;
          let value = cell;
          for (const e of edit) if (name in e.set) value = e.set[name]!;
          return value;
        });
      }
      return r.filter((_, at) => !drop.has(at));
    });
  const text = kept.map((r) => csvLine(r)).join("");
  return CSV_BOM + (options.lineEnding === "\r\n" ? text.replaceAll("\n", "\r\n") : text);
}

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
