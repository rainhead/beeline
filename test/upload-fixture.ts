import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp, type JobsDep } from "../src/app/server.js";
import { readXlsxHere, type ReadLimits } from "../src/app/xlsx-reader.js";
import { buildWorkbook, type TestCell } from "./workbook.js";
import { ALL, EMPTY_QUERY, SPECIMEN_CSV_HEADER, STAFF_READER, hostNamesOnce, listSpecimens, specimenCsvRow, textCell } from "../src/app/listings.js";
import { writeXlsx } from "../src/app/xlsx.js";
import type { Layout } from "../src/app/upload-plan.js";
import type { UploadArchive } from "../src/app/upload-archive.js";
import { CURRENT_SEASON, createMemoryDb, insertCleanSample, SETTLED_SEASON, rows, scratchPaths } from "./helpers.js";
import { openCopy, writeCopy } from "./promoted-store.js";

/**
 * The day the app's plans are made on, in the current season and after the fixtures' summer days, so that a test does
 * not depend on the date it runs on: collecting dates are held when they come after today (`event_date_future`).
 */
export const UPLOAD_TODAY = `${CURRENT_SEASON}-12-31`;

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

/**
 * The store of the fixture, made from the real schema once for each kind and file, and copied for each test (0.2 s,
 * where the schema takes 0.4 s). Each copy is a store of its own. The template is a file in the run's folder, which
 * test/global-setup.ts removes.
 */
const templates = new Map<boolean, Promise<string>>();
async function storeOf(unprinted: boolean) {
  let template = templates.get(unprinted);
  if (template === undefined) {
    template = (async () => {
      const made = await buildStore(unprinted);
      const path = join(await mkdtemp(join(tmpdir(), "upload-fixture-")), "store.duckdb");
      try {
        await writeCopy(made.conn, path);
      } finally {
        made.conn.closeSync();
        made.instance.closeSync();
      }
      templateFacts.set(unprinted, made.facts);
      return path;
    })();
    templates.set(unprinted, template);
  }
  const { instance, conn } = await openCopy(await template);
  const facts = templateFacts.get(unprinted)!;
  return { instance, conn, ...facts, ids: { ...facts.ids } };
}
const templateFacts = new Map<boolean, { staffer: number; volunteer: number; delegate: number; ids: FixtureIds }>();

type FixtureIds = { a1: number; a2: number; a3: number; b1: number; sampleA: number; sampleB: number; c1?: number; sampleC?: number };

async function buildStore(unprinted: boolean) {
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
  // Vera's partner, who cannot sign in as Vera and acts for her (delegation).
  const delegate = await person("Dana Delegate");
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staffer})`);
  await conn.run(`INSERT INTO person_delegate (person_id, acts_for_id, granted_by) VALUES (${delegate}, ${volunteer}, 'staffer')`);

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

  const ids: FixtureIds = {
    a1,
    a2,
    a3,
    b1,
    sampleA,
    sampleB,
  };
  if (unprinted) {
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
  return { instance, conn, facts: { staffer, volunteer, delegate, ids } };
}

/**
 * A store for the upload tests, built from the real schema: three specimens of
 * one sample from the current season (`a1` with an expert's determination,
 * `a2` with none, `a3` with a volunteer's and no field number) and one of a
 * sample from a settled season (`b1`). The app answers as staff, or as a
 * volunteer when asked, and `file()` is the Excel file for editing
 * specimens and `download()` every column of the CSV, which the tests edit.
 */
export async function uploadFixture(
  signedInAs: "staffer" | "volunteer" | "delegate" = "staffer",
  /** `unprinted` adds a sample (UP-3) whose one specimen is in a print run that has not printed. */
  options: {
    unprinted?: boolean;
    readLimits?: Partial<ReadLimits>;
    layout?: Layout;
    archive?: UploadArchive;
    /** Awaited when saving, between reading what saving depends on and working out the plan (createApp's uploadApplyPause). */
    applyPause?: (uploadId: number) => Promise<void>;
    /** The job registry the app starts jobs through and asks what is running (createApp's jobs). */
    jobs?: JobsDep;
  } = {},
) {
  const { instance, conn, staffer, volunteer, delegate, ids } = await storeOf(options.unprinted === true);
  const people = { staffer, volunteer, delegate };
  const db = createKysely(instance);
  const paths = await scratchPaths();
  /** The app over this store, signed in as one of the fixture's people. */
  const appAs = (who: keyof typeof people) => createApp({
    ...paths,
    db,
    conn,
    // Sandbox, not development: development makes everyone an admin (beeline-6va).
    config: { environment: "sandbox" as const, origin: "http://localhost:3054", exportsDir: join(dirname(paths.uploadsDir), "exports") },
    inat: unusedInat,
    // In this thread, unless the test is about the worker and says `inThread: false`.
    uploadReadLimits: { inThread: true, ...options.readLimits },
    uploadLayout: options.layout,
    // Never the real folder: a test that is about the copy in Drive gives a fake.
    uploadArchive: options.archive ?? null,
    uploadApplyPause: options.applyPause,
    jobs: options.jobs,
    uploadToday: () => UPLOAD_TODAY,
    resolveSession: async () => ({ personId: people[who], login: who, iconUrl: null }),
  });
  const app = appAs(signedInAs);
  /** The Excel file for editing specimens, as the staff member asked for it. */
  const file = async () => new Uint8Array(await (await app.request("/specimens.xlsx?scope=all")).arrayBuffer());
  /**
   * Every column of the CSV, in a workbook whose tab is the specimens file's, with the values the app writes: an
   * older download. The comparison still holds rules for a sample's dates, place and coordinates, which no file reads
   * today; the tests of those rules read this file with every such column named as read (`allRead`).
   */
  const download = async () => {
    const page = await listSpecimens(db, { ...EMPTY_QUERY, scope: ALL }, 0, STAFF_READER, {
      limit: 10_000,
      offset: 0,
      withTotal: false,
      hostNames: await hostNamesOnce(db)(),
    });
    return writeXlsx({ sheetName: "specimens", header: SPECIMEN_CSV_HEADER }, page.rows.map((r) => specimenCsvRow(r, page).map(textCell)));
  };
  return { instance, conn, db, app, appAs, paths, staffer, volunteer, delegate, ids, download, file };
}

/**
 * One store for every test in the file that only reads it (planning writes nothing), made on first use: the schema
 * takes 0.4 s to build, which a test that changes nothing need not pay for itself. A test that changes the store, or
 * wants the unprinted sample, makes its own with `uploadFixture`. Each test file has its own, since a file's modules
 * are its own under Vitest. The two downloads are kept, which is safe because nothing changes the store they read.
 */
let shared: Promise<UploadFixture> | undefined;
export function sharedUploadFixture(): Promise<UploadFixture> {
  shared ??= uploadFixture().then((f) => {
    const once = <T>(make: () => Promise<T>) => {
      let kept: Promise<T> | undefined;
      return () => (kept ??= make());
    };
    return { ...f, download: once(f.download), file: once(f.file) };
  });
  return shared;
}

export type UploadFixture = Awaited<ReturnType<typeof uploadFixture>>;

/** A file's cells as text, header first; an absent cell is "". */
export function matrixOf(workbook: Uint8Array): string[][] {
  const read = readXlsxHere(workbook);
  if (!read.ok) throw new Error(`not readable: ${read.refusal}`);
  const width = Math.max(...read.sheet.rows.flatMap((r) => [...r.cells.keys()])) + 1;
  return read.sheet.rows.map((r) => Array.from({ length: width }, (_, at) => r.cells.get(at)?.text ?? ""));
}

/**
 * An edited copy of the download: each entry sets cells of the row whose
 * `specimenId` it names, to text or to any kind of cell a spreadsheet can
 * make of it. `dropColumns` leaves columns out, `renameColumns` changes a
 * heading, `addColumns` adds a column with a value in every row, `dropRows`
 * leaves specimens out.
 */
export function edited(
  download: Uint8Array,
  edits: Array<{ id: number; set: Record<string, TestCell> }> = [],
  options: {
    dropColumns?: string[];
    renameColumns?: Record<string, string>;
    addColumns?: Record<string, string>;
    dropRows?: number[];
    /** The column that names a row, which an edit's `id` is in: `sampleId` for the samples file. */
    idColumn?: string;
    /** Rows added after the last, each by heading; a heading it does not give is left blank. */
    addRows?: Array<Record<string, TestCell>>;
    /** The sheet's name, and other sheets of the workbook (see buildWorkbook). */
    sheets?: { name?: string; others?: string[]; before?: boolean; date1904?: boolean };
  } = {},
): Uint8Array {
  const records = matrixOf(download);
  // The tab keeps the name the download gave it, which says which file it is.
  const tab = readXlsxHere(download);
  const tabName = tab.ok ? tab.sheet.name : "specimens";
  const head = records[0]!;
  const idAt = head.indexOf(options.idColumn ?? "specimenId");
  const drop = new Set((options.dropColumns ?? []).map((c) => head.indexOf(c)));
  const rows: TestCell[][] = records
    .filter((r, i) => i === 0 || !(options.dropRows ?? []).includes(Number(r[idAt])))
    .map((r, i): TestCell[] => {
      let cells: TestCell[] = [...r];
      if (i > 0) {
        const edit = edits.filter((e) => String(e.id) === r[idAt]);
        cells = cells.map((cell, at) => {
          let value: TestCell = cell;
          for (const e of edit) if (head[at]! in e.set) value = e.set[head[at]!]!;
          return value === "" ? null : value;
        });
      } else cells = cells.map((cell, at) => options.renameColumns?.[head[at]!] ?? cell);
      cells = cells.filter((_, at) => !drop.has(at));
      for (const [name, value] of Object.entries(options.addColumns ?? {})) cells.push(i === 0 ? name : value);
      return cells;
    });
  for (const added of options.addRows ?? []) {
    rows.push(head.filter((_, at) => !drop.has(at)).map((h) => added[h] ?? null));
  }
  return buildWorkbook(rows, { name: tabName, ...options.sheets });
}

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * The value of the box that confirms changes to programs the person does not lead (beeline-kgyd.13), naming every
 * program, for tests that are not about it: the box carries the programs the page named, and this covers any.
 */
export async function everyProgramConfirmed(f: UploadFixture): Promise<string> {
  const rows = await (await f.conn.run(`SELECT code FROM program`)).getRows();
  return rows.map((r) => String(r[0])).join(";");
}
