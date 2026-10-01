import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import {
  MANIFEST_COLUMNS,
  formatManifest,
  labelNumber,
  loadWorksheets,
  readSheetRows,
  type ManifestRow,
  type WorksheetFile,
} from "../src/load-worksheets.js";

/**
 * Volunteer determination worksheets (beeline-pbk). Each fixture sheet is
 * written as .xlsx in the template's shape — the 'USE THIS SHEET' tab, its
 * five headings, label numbers as number cells, names from the template's
 * dropdowns including its 'Epimelissodes (Svastra)' — with fictional people
 * and numbers. The values in the cells are ones the 2026-10-01 export holds:
 * 'queen', 'worker' on a sweat bee, 'flavifrons/centralis', a genus-only row
 * later refined to a species in a newer copy.
 */

let conn: DuckDBConnection;
let dir: string;
let manifest: string;
let ada: number;
let ben: number;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSTALL excel; LOAD excel");
  dir = await mkdtemp(join(tmpdir(), "worksheets-"));
  manifest = join(dir, "worksheet-files.csv");
  await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector'), ('Ben Helper')`);
  [[ada], [ben]] = (await rows(conn, `SELECT entity_id FROM person ORDER BY display_name`)) as [[number], [number]];
  const tree: Array<[string, string, string | null]> = [
    ["family", "Halictidae", null],
    ["genus", "Bombus", "Apidae"],
    ["genus", "Halictus", "Halictidae"],
    ["genus", "Lasioglossum", "Halictidae"],
    ["genus", "Epimelissodes", "Apidae"],
    ["subgenus", "Epimelissodes (Svastra)", "Epimelissodes"],
    ["species", "Bombus vosnesenskii", "Bombus"],
    ["species", "Halictus confusus", "Halictus"],
    ["species", "Epimelissodes obliquus", "Epimelissodes"],
  ];
  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Apidae')`);
  for (const [rank, name, parent] of tree) {
    await conn.run(
      `INSERT INTO animal (rank, scientific_name, parent_id) VALUES ('${rank}', '${name}', (SELECT entity_id FROM animal WHERE scientific_name = ${parent === null ? "NULL" : `'${parent}'`}))`,
    );
  }
  const adaSample = await insertCleanSample(conn, { specimen_count: "8", collector_id: String(ada) });
  const benSample = await insertCleanSample(conn, { specimen_count: "1", collector_id: String(ben), sample_number: "'2'" });
  for (let n = 1; n <= 8; n++) {
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${adaSample}, ${n}, '2600000${n}')`);
  }
  await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${benSample}, 1, '26000099')`);
});

type Row = [number | null, string | null, string | null, string | null, string | null];

/** One worksheet: a .xlsx with the template's tab and headings. */
async function sheet(id: string, rs: Row[], tab = "USE THIS SHEET"): Promise<string> {
  const values = rs
    .map((r) => `(${r.map((v) => (v === null ? "NULL" : typeof v === "number" ? `${v}::DOUBLE` : `'${v}'`)).join(", ")})`)
    .join(", ");
  const file = `${id}.xlsx`;
  await conn.run(
    `COPY (SELECT col0::DOUBLE AS "OBA Number", col1 AS "Sex/Caste", col2 AS "Family", col3 AS "Genus", col4 AS "Species"
           FROM (VALUES ${values}) t(col0, col1, col2, col3, col4))
     TO '${join(dir, file)}' (FORMAT xlsx, HEADER true, SHEET '${tab}')`,
  );
  return file;
}

async function exportOf(files: Array<{ id: string; name: string; modified: string; rows: Row[]; tab?: string }>): Promise<void> {
  const listed: WorksheetFile[] = [];
  for (const f of files) {
    listed.push({ id: f.id, name: f.name, mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: f.modified, file: await sheet(f.id, f.rows, f.tab) });
  }
  await writeFile(join(dir, "files.json"), JSON.stringify(listed));
}

async function decide(decisions: Record<string, Partial<ManifestRow>>): Promise<void> {
  const blank = Object.fromEntries(MANIFEST_COLUMNS.map((c) => [c, ""])) as ManifestRow;
  await writeFile(manifest, formatManifest(Object.entries(decisions).map(([file_id, d]) => ({ ...blank, file_id, ...d }))));
}

const load = (dryRun = false) => loadWorksheets(conn, { dir, manifestPath: manifest, now: new Date("2026-10-01T12:00:00Z"), dryRun });

const determinations = () =>
  rows(
    conn,
    `SELECT sp.field_number, an.scientific_name, d.verbatim_identification, d.sex, d.caste, d.notes, p.display_name, d.channel, d.is_expert
     FROM determination d JOIN specimen sp ON sp.entity_id = d.specimen_id JOIN animal an ON an.entity_id = d.animal_id
     LEFT JOIN person p ON p.entity_id = d.determiner_id
     ORDER BY sp.field_number, d.recorded_at`,
  );

const ADA_2025: Row[] = [
  [26000001, "queen", "Apidae", "Bombus", "vosnesenskii"],
  [26000002, "worker", "Halictidae", "Lasioglossum", null],
  [26000003, "female", "Apidae", "Epimelissodes (Svastra)", null],
  [26000004, "male", "Apidae", "Epimelissodes (Svastra)", "obliquus"],
  [26000005, "female", "Halictidae", null, null],
  [26000006, "female", "Apidae", "Bombus", "flavifrons/centralis"],
  [26000007, null, null, null, null],
  [26000099, "female", "Halictidae", "Halictus", null],
  [26000098, "female", "Halictidae", "Halictus", null],
];

describe("a file nobody has decided about", () => {
  test("loads nothing and is proposed for the collector of most of its specimens", async () => {
    await exportOf([{ id: "f1", name: "Collector 2025", modified: "2026-02-01T10:00:00Z", rows: ADA_2025 }]);
    const result = await load();
    expect(result).toMatchObject({ files: 1, undecided: 1, recorded: 0, rows: 0 });
    // Held whole, so the held list is everything that did not load.
    expect(result.statuses).toEqual([
      { status: "undecided", season: "none", rows: 1 },
      { status: "undecided", season: "open", rows: 7 },
    ]);
    expect(await determinations()).toEqual([]);
    const written = (await readFile(manifest, "utf8")).split("\n");
    expect(written[0]).toBe(MANIFEST_COLUMNS.join(","));
    // Six of the seven determined rows that reach a specimen are Ada's.
    expect(written[1]).toBe("f1,Collector 2025,2026-02-01T10:00:00Z,8,name:Ada Collector,86%,,,,");
  });
});

describe("a decided file", () => {
  test("records each row the determiner made of their own specimens", async () => {
    await exportOf([{ id: "f1", name: "Collector 2025", modified: "2026-02-01T10:00:00Z", rows: ADA_2025 }]);
    await decide({ f1: { determiner: "name:Ada Collector" } });
    const result = await load();
    expect(await determinations()).toEqual([
      // A queen is a female gyne, where the taxon has castes.
      ["26000001", "Bombus vosnesenskii", "Bombus vosnesenskii", "female", "gyne", null, "Ada Collector", "worksheet_import", false],
      // A sweat bee has no castes here: the sex is kept, the word goes to the notes.
      ["26000002", "Lasioglossum", "Lasioglossum", "female", null, "the worksheet says worker", "Ada Collector", "worksheet_import", false],
      // The template's genus cell carries a subgenus: alone it is that node,
      ["26000003", "Epimelissodes (Svastra)", "Epimelissodes (Svastra)", "female", null, null, "Ada Collector", "worksheet_import", false],
      // under an epithet it is spelled the way the tree spells species.
      ["26000004", "Epimelissodes obliquus", "Epimelissodes (Svastra) obliquus", "male", null, null, "Ada Collector", "worksheet_import", false],
      ["26000005", "Halictidae", "Halictidae", "female", null, null, "Ada Collector", "worksheet_import", false],
    ]);
    expect(result).toMatchObject({ undecided: 0, rows: 8, undetermined: 1, recorded: 5, held: 3 });
    expect(result.unresolvedNames).toEqual([{ name: "Bombus flavifrons/centralis", rows: 1 }]);
    expect(result.statuses).toEqual([
      { status: "no_specimen", season: "none", rows: 1 },
      { status: "not_theirs", season: "open", rows: 1 },
      { status: "recorded", season: "open", rows: 5 },
      { status: "unresolved_name", season: "open", rows: 1 },
    ]);
    // Held rows, with the numbers either side of them in the sheet.
    expect((await readFile(join(dir, "held.csv"), "utf8")).split("\n")).toEqual([
      "file,sheet,row,number,reason,name,sex_caste,neighbours,other_copies",
      "Collector 2025,USE THIS SHEET,7,26000006,unresolved_name,Bombus flavifrons/centralis,female,26000004 26000005 26000007 26000099,",
      "Collector 2025,USE THIS SHEET,9,26000099,not_theirs,Halictus,female,26000006 26000007 26000098,",
      "Collector 2025,USE THIS SHEET,10,26000098,no_specimen,Halictus,female,26000007 26000099,",
      "",
    ]);
  });

  test("a file marked as determining for others records them too", async () => {
    await exportOf([{ id: "f1", name: "Helper's set", modified: "2026-02-01T10:00:00Z", rows: [[26000099, "female", "Halictidae", "Halictus", null]] }]);
    await decide({ f1: { determiner: "name:Ada Collector", for_others: "yes" } });
    await load();
    expect(await determinations()).toEqual([["26000099", "Halictus", "Halictus", "female", null, null, "Ada Collector", "worksheet_import", false]]);
  });

  test("a row that names a taxon but has no label number is held, with what the cell held", async () => {
    // From the export: a volunteer's own code in the number column, and a blank.
    await exportOf([{ id: "f1", name: "Collector 2025", modified: "2026-02-01T10:00:00Z", rows: [[26000001, "female", "Apidae", "Bombus", null], [null, "male", "Apidae", "Bombus", null]] }]);
    await decide({ f1: { determiner: "name:Ada Collector" } });
    const result = await load();
    expect(result.recorded).toBe(1);
    expect(result.statuses.find((s) => s.status === "no_number")).toEqual({ status: "no_number", season: "none", rows: 1 });
    expect((await readFile(join(dir, "held.csv"), "utf8")).split("\n")[1]).toBe("Collector 2025,USE THIS SHEET,3,,no_number,Bombus,male,26000001,");
  });

  test("a held cell that would read as a formula is guarded", async () => {
    // Synthetic: nothing in the export starts with =, but a volunteer's cell could.
    await exportOf([{ id: "f1", name: "Collector 2025", modified: "2026-02-01T10:00:00Z", rows: [[null, "female", "Apidae", "=HYPERLINK(1)", null]] }]);
    await decide({ f1: { determiner: "name:Ada Collector" } });
    await load();
    expect((await readFile(join(dir, "held.csv"), "utf8")).split("\n")[1]).toBe("Collector 2025,USE THIS SHEET,2,,no_number,'=HYPERLINK(1),female,,");
  });

  test("a renamed tab is named in the manifest", async () => {
    // Four files in the export keep their rows on a tab called something else.
    await exportOf([{ id: "f1", name: "Collector 2025", modified: "2026-02-01T10:00:00Z", rows: [[26000001, "female", "Apidae", "Bombus", null]], tab: "2025" }]);
    await decide({ f1: { determiner: "name:Ada Collector" } });
    expect((await load()).unreadable).toEqual([
      { file: "Collector 2025", problem: "no tab named 'USE THIS SHEET': name the tab in the manifest's sheet column" },
    ]);
    await decide({ f1: { determiner: "name:Ada Collector", sheet: "2025" } });
    expect((await load()).recorded).toBe(1);
    expect(await rows(conn, `SELECT sheet, row_number FROM worksheet_determination`)).toEqual([["2025", 2]]);
  });

  test("skip loads nothing; a reference to nobody is reported", async () => {
    await exportOf([
      { id: "f1", name: "trash copy", modified: "2026-02-01T10:00:00Z", rows: ADA_2025 },
      { id: "f2", name: "Someone 2025", modified: "2026-02-01T10:00:00Z", rows: ADA_2025 },
    ]);
    await decide({ f1: { determiner: "skip" }, f2: { determiner: "name:Nobody Here" } });
    const result = await load();
    expect(result).toMatchObject({ skipped: 1, recorded: 0, unresolvedDeterminers: [{ file: "Someone 2025", determiner: "name:Nobody Here", problem: "no person named 'Nobody Here'" }] });
    // The skipped file holds nothing back; the one naming nobody holds everything.
    const held = (await readFile(join(dir, "held.csv"), "utf8")).split("\n").filter((l) => l.includes(",undecided,"));
    expect(held.every((l) => l.startsWith("Someone 2025,"))).toBe(true);
    expect(held).toHaveLength(8);
  });
});

describe("copies of one person's worksheet", () => {
  // The export's own case: an old copy touched later reads as the newest
  // file, and its Lasioglossum stands against the revised copy's species.
  const COPIES = [
    { id: "old", name: "Collector", modified: "2026-01-28T04:13:44Z", rows: [[26000001, "female", "Halictidae", "Lasioglossum", null], [26000002, "female", "Apidae", "Bombus", null], [26000003, "male", "Apidae", "Bombus", null]] as Row[] },
    { id: "new", name: "Collector 2025", modified: "2025-11-21T16:00:00Z", rows: [[26000001, "female", "Halictidae", "Halictus", "confusus"], [26000002, "female", "Apidae", "Bombus", null]] as Row[] },
  ];

  test("copies that disagree are held, naming each other; copies that agree are one entry", async () => {
    await exportOf(COPIES);
    await decide({ old: { determiner: "name:Ada Collector" }, new: { determiner: "name:Ada Collector" } });
    const result = await load();
    expect(await determinations()).toEqual([
      ["26000002", "Bombus", "Bombus", "female", null, null, "Ada Collector", "worksheet_import", false],
      ["26000003", "Bombus", "Bombus", "male", null, null, "Ada Collector", "worksheet_import", false],
    ]);
    expect(result.statuses.find((s) => s.status === "versions_disagree")).toEqual({ status: "versions_disagree", season: "open", rows: 2 });
    expect((await readFile(join(dir, "held.csv"), "utf8")).split("\n").slice(1, 3)).toEqual([
      "Collector,USE THIS SHEET,2,26000001,versions_disagree,Lasioglossum,female,26000002 26000003,Collector 2025: Halictus confusus female",
      "Collector 2025,USE THIS SHEET,2,26000001,versions_disagree,Halictus confusus,female,26000002,Collector: Lasioglossum female",
    ]);
  });

  test("marking the stale copy skip settles it", async () => {
    await exportOf(COPIES);
    await decide({ old: { determiner: "skip" }, new: { determiner: "name:Ada Collector" } });
    await load();
    expect((await determinations()).map((r) => [r[0], r[1]])).toEqual([
      ["26000001", "Halictus confusus"],
      ["26000002", "Bombus"],
    ]);
  });

  test("rows in one file that disagree about a specimen are held; rows that agree are one", async () => {
    await exportOf([
      {
        id: "f1",
        name: "Collector 2025",
        modified: "2026-02-01T10:00:00Z",
        rows: [
          [26000001, "female", "Apidae", "Bombus", null],
          [26000001, "male", "Apidae", "Bombus", null],
          [26000002, "female", "Apidae", "Bombus", null],
          [26000002, "female", "Apidae", "Bombus", null],
        ],
      },
    ]);
    await decide({ f1: { determiner: "name:Ada Collector" } });
    const result = await load();
    expect(await determinations()).toEqual([["26000002", "Bombus", "Bombus", "female", null, null, "Ada Collector", "worksheet_import", false]]);
    expect(result.statuses.find((s) => s.status === "conflicting_rows")?.rows).toBe(2);
  });
});

describe("loading again", () => {
  test("records nothing it already recorded; a copy that changes it is held until settled", async () => {
    const first = { id: "f1", name: "Collector 2025", modified: "2026-02-01T10:00:00Z", rows: [[26000001, "female", "Apidae", "Bombus", null]] as Row[] };
    await exportOf([first]);
    await decide({ f1: { determiner: "name:Ada Collector" } });
    expect((await load()).recorded).toBe(1);
    expect((await load()).recorded).toBe(0);
    expect((await load()).statuses).toEqual([{ status: "already_loaded", season: "open", rows: 1 }]);

    await exportOf([first, { id: "f2", name: "Collector 2025 (2)", modified: "2026-03-01T10:00:00Z", rows: [[26000001, "female", "Apidae", "Bombus", "vosnesenskii"]] }]);
    await decide({ f1: { determiner: "name:Ada Collector" }, f2: { determiner: "name:Ada Collector" } });
    expect((await load()).recorded).toBe(0);
    await decide({ f1: { determiner: "skip" }, f2: { determiner: "name:Ada Collector" } });
    expect((await load()).recorded).toBe(1);
    expect((await determinations()).map((r) => r[1])).toEqual(["Bombus", "Bombus vosnesenskii"]);
  });

  test("an entry already transcribed is not recorded twice; one changed in Beeline since is left alone", async () => {
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, sex, determiner_id, is_expert, channel)
       SELECT sp.entity_id, (SELECT entity_id FROM animal WHERE scientific_name = 'Bombus'), 'female', ${ada}, false, 'legacy_import'
       FROM specimen sp WHERE field_number = '26000001'`,
    );
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, verbatim_identification, sex, determiner_id, is_expert, channel, recorded_at)
       SELECT sp.entity_id, (SELECT entity_id FROM animal WHERE scientific_name = 'Halictus'), 'Halictus', 'female', ${ada}, false, 'in_app', TIMESTAMPTZ '2026-05-01 00:00:00Z'
       FROM specimen sp WHERE field_number = '26000002'`,
    );
    await exportOf([
      {
        id: "f1",
        name: "Collector 2025",
        modified: "2026-02-01T10:00:00Z",
        rows: [[26000001, "female", "Apidae", "Bombus", null], [26000002, "female", "Halictidae", "Lasioglossum", null]],
      },
    ]);
    await decide({ f1: { determiner: "name:Ada Collector" } });
    const result = await load();
    expect(result.recorded).toBe(0);
    expect(result.statuses).toEqual([
      { status: "already_recorded", season: "open", rows: 1 },
      { status: "newer_in_beeline", season: "open", rows: 1 },
    ]);
  });

  test("a dry run reports and records nothing", async () => {
    await exportOf([{ id: "f1", name: "Collector 2025", modified: "2026-02-01T10:00:00Z", rows: ADA_2025 }]);
    await decide({ f1: { determiner: "name:Ada Collector" } });
    const result = await load(true);
    expect(result).toMatchObject({ recorded: 0, held: 3 });
    expect(result.statuses.find((s) => s.status === "recorded")?.rows).toBe(5);
    expect(await determinations()).toEqual([]);
  });
});

describe("reading a sheet", () => {
  test("a label number is whatever the cell held, as long as it is a whole number", () => {
    // Google's export of a number cell, read as text; a cell typed as text;
    // and values the export holds in the number column that are not numbers.
    expect(labelNumber("2.5000001E7")).toBe("25000001");
    expect(labelNumber("25000001")).toBe("25000001");
    expect(labelNumber("2402835.0")).toBe("2402835");
    expect(labelNumber("2026-08-20 00:00:00")).toBeNull();
    expect(labelNumber("EXTRA LABEL")).toBeNull();
    expect(labelNumber(null)).toBeNull();
  });

  test("columns are found by heading below a stray title row, and read in the template's order where there is none", () => {
    const titled = readSheetRows([
      ["COLLECTOR, A 2025", null, null],
      ["OBA Number", "Species", "Genus", "Sex/Caste"],
      ["2.5000001E7", "vosnesenskii", "Bombus", "Queen"],
    ]);
    expect(titled).toEqual([{ rowNumber: 3, number: "25000001", sex: "queen", family: null, genus: "Bombus", species: "vosnesenskii", numberText: null }]);
    // The export's own case: '250' typed over the Genus heading.
    expect(readSheetRows([["OBA Number", "Sex/Caste", "Family", "250.0", "Species"], ["2.5035356E7", "female", "Halictidae", "Halictus", "rubicundus"]])).toEqual([
      { rowNumber: 2, number: "25035356", sex: "female", family: "Halictidae", genus: "Halictus", species: "rubicundus", numberText: null },
    ]);
    expect(readSheetRows([["2.5000001E7", "female", "Halictidae", "Halictus"]])).toEqual([
      { rowNumber: 1, number: "25000001", sex: "female", family: "Halictidae", genus: "Halictus", species: null, numberText: null },
    ]);
  });
});
