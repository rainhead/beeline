import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { HELD_COLUMNS, loadDeterminationSheet } from "../src/load-determination-sheet.js";
import type { ReceivedFile } from "../src/received-files.js";
import { CURRENT_SEASON, createMemoryDb, currentSeasonDate, insertCleanSample, rows } from "./helpers.js";

/**
 * An expert's own sheet of determinations onto specimens (beeline-t8zv). The
 * columns and their values are the Idaho Bee Atlas's sheet of November 2026:
 * its headers, its determiners as it spells them (S.Burrows, A.S.Jackson),
 * its misspelling of Lasioglossum sisymbrii, its `spp`, and its dates, which
 * are Excel day numbers except where a collector wrote a Roman-numeral
 * month (VIII/25/2024). The people, numbers and samples are made up.
 */

let conn: DuckDBConnection;
let dir: string;

const COLUMNS = ["fieldNumber", "family", "genus", "specificEpithet", "sex", "identifiedBy", "lastName", "verbatimEventDate", "url"] as const;
type Row = Partial<Record<(typeof COLUMNS)[number], string | number>>;

/** 14 July of the current season as Excel numbers it, the way a date cell reads as text. */
const JULY_14 = (Date.UTC(CURRENT_SEASON, 6, 14) - Date.UTC(1899, 11, 30)) / 86_400_000;
const ROMAN_JULY_14 = `VII/14/${CURRENT_SEASON}`;

const FILE: ReceivedFile = {
  id: "1aIdahoSheetDriveId",
  name: "Idaho Bee Atlas determinations.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  modifiedTime: "2026-11-09T18:16:00.000Z",
  from: "Karleen Davis",
  description: null,
};

/** The received directory: the sheet, on a tab named as Idaho's is, and file.json beside it. */
async function received(rs: Row[], tab = "Determinations"): Promise<void> {
  // A column is numeric where every value in it is a number, as a date
  // column of day numbers is; one that mixes in text is written as text,
  // which is how the loader reads every cell anyway.
  const numeric = new Set(COLUMNS.filter((c) => rs.every((r) => r[c] === undefined || typeof r[c] === "number")));
  const cell = (c: (typeof COLUMNS)[number], v: string | number | undefined) =>
    v === undefined ? (numeric.has(c) ? "NULL::INTEGER" : "NULL::VARCHAR")
    : numeric.has(c) ? `${v}::INTEGER`
    : `'${String(v).replaceAll("'", "''")}'`;
  const values = rs.map((r) => `(${COLUMNS.map((c) => cell(c, r[c])).join(", ")})`).join(", ");
  await conn.run("INSTALL excel; LOAD excel");
  await conn.run(
    `COPY (SELECT ${COLUMNS.map((c, i) => `col${i} AS "${c}"`).join(", ")} FROM (VALUES ${values}) t(${COLUMNS.map((_, i) => `col${i}`).join(", ")}))
     TO '${join(dir, FILE.name)}' (FORMAT xlsx, HEADER true, SHEET '${tab}')`,
  );
  await writeFile(join(dir, "file.json"), JSON.stringify(FILE));
}

const row = (fieldNumber: string, more: Row = {}): Row => ({
  fieldNumber,
  family: "Halictidae",
  genus: "Lasioglossum",
  specificEpithet: "sisymbrii",
  sex: "female",
  identifiedBy: "S.Burrows",
  lastName: "Collector",
  verbatimEventDate: JULY_14,
  url: "https://www.inaturalist.org/observations/1",
  ...more,
});

const NOW = new Date("2026-11-10T12:00:00Z");
const load = (dryRun = false) => loadDeterminationSheet(conn, { dir, now: NOW, dryRun });

const determinations = () =>
  rows(
    conn,
    `SELECT sp.field_number, an.rank, an.scientific_name, d.verbatim_identification, d.sex, p.display_name, d.determiner_name,
            d.is_expert, d.channel, w.file_id, w.sheet, w.row_number
     FROM determination d JOIN specimen sp ON sp.entity_id = d.specimen_id JOIN animal an ON an.entity_id = d.animal_id
     LEFT JOIN person p ON p.entity_id = d.determiner_id
     LEFT JOIN worksheet_determination w ON w.determination_id = d.entity_id
     WHERE d.channel = 'worksheet_import' ORDER BY sp.field_number, d.recorded_at`,
  );

const heldRows = async () => {
  const [header, ...lines] = (await readFile(join(dir, "held.csv"), "utf8")).trim().split("\n");
  expect(header).toBe(HELD_COLUMNS.join(","));
  return lines.map((l) => l.split(",").slice(0, 3));
};

async function node(rank: string, name: string, parent: string | null): Promise<void> {
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id)
     SELECT '${rank}', '${name}', ${parent === null ? "NULL" : `(SELECT entity_id FROM animal WHERE scientific_name = '${parent}')`}`,
  );
}

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  dir = await mkdtemp(join(tmpdir(), "determination-sheet-"));
  await conn.run(`INSERT INTO person (display_name, given_name, family_name) VALUES ('Ada Collector', 'Ada', 'Collector')`);
  await node("family", "Halictidae", null);
  await node("genus", "Lasioglossum", "Halictidae");
  await node("species", "Lasioglossum sisymbrii", "Lasioglossum");
  await node("family", "Andrenidae", null);
  await node("genus", "Andrena", "Andrenidae");
  const sample = await insertCleanSample(conn);
  for (let n = 1; n <= 9; n++) {
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, ${n}, '2600000${n}')`);
  }
});

describe("loading an expert's sheet", () => {
  test("a row becomes an expert determination with the file, tab and row it came from", async () => {
    await received([row("26000001")]);
    const result = await load();
    expect(result).toMatchObject({ sheet: "Determinations", rows: 1, recorded: 1, createdPeople: ["Skyler Burrows"] });
    expect(await determinations()).toEqual([
      ["26000001", "species", "Lasioglossum sisymbrii", "Lasioglossum sisymbrii", "female", "Skyler Burrows", "S.Burrows", true, "worksheet_import", FILE.id, "Determinations", 2],
    ]);
  });

  test("a misspelt epithet resolves through the spelling aliases and is kept as written; spp is a genus", async () => {
    await received([
      row("26000001", { specificEpithet: "sisymbri" }),
      row("26000002", { family: "Andrenidae", genus: "Andrena", specificEpithet: "spp" }),
    ]);
    await load();
    expect((await determinations()).map((r) => r.slice(0, 4))).toEqual([
      ["26000001", "species", "Lasioglossum sisymbrii", "Lasioglossum sisymbri"],
      ["26000002", "genus", "Andrena", "Andrena spp"],
    ]);
  });

  test("a blank determiner is recorded with none, still expert", async () => {
    await received([row("26000001", { identifiedBy: undefined })]);
    await load();
    expect((await determinations()).map((r) => [r[5], r[6], r[7]])).toEqual([[null, null, true]]);
  });

  test("the collector, the date (as a day number or a Roman month) and the family confirm the number, or the row is held; an impossible date is held too", async () => {
    await received([
      row("26000001", { verbatimEventDate: ROMAN_JULY_14 }),
      row("26000002", { lastName: "Someone" }),
      row("26000003", { verbatimEventDate: JULY_14 + 1 }),
      row("26000004", { family: "Andrenidae" }),
      row("26000005", { verbatimEventDate: "sometime" }),
      row("26000006", { verbatimEventDate: `IX/31/${CURRENT_SEASON}` }),
      row("26000007", { verbatimEventDate: `XIII/14/${CURRENT_SEASON}` }),
    ]);
    const result = await load();
    expect(result.recorded).toBe(1);
    expect(await heldRows()).toEqual([
      ["3", "26000002", "collector_disagrees"],
      ["4", "26000003", "date_disagrees"],
      ["5", "26000004", "family_disagrees"],
      ["6", "26000005", "date_unreadable"],
      ["7", "26000006", "date_unreadable"],
      ["8", "26000007", "date_unreadable"],
    ]);
    expect(result.heldBySeason).toEqual({ active: 6, settled: 0, noSpecimen: 0 });
  });

  test("a number no specimen carries, a number twice in the sheet, a name nobody has and a determiner nobody named are held", async () => {
    await received([
      row("26000099"),
      row("26000001"),
      row("26000001", { sex: "male" }),
      row("26000002", { specificEpithet: "nonexistens" }),
      row("26000003", { identifiedBy: "Q.Nobody" }),
      row("26000004", { sex: "worker" }),
    ]);
    const result = await load();
    expect(result.recorded).toBe(0);
    expect(await heldRows()).toEqual([
      ["2", "26000099", "no_specimen"],
      ["3", "26000001", "repeated_number"],
      ["4", "26000001", "repeated_number"],
      ["5", "26000002", "name_unknown"],
      ["6", "26000003", "determiner_unknown"],
      ["7", "26000004", "sex_unreadable"],
    ]);
    expect(result.createdPeople).toEqual([]);
  });

  test("what the specimen already says is skipped; a different expert determination is superseded and listed", async () => {
    await conn.run(`INSERT INTO person (display_name) VALUES ('August Jackson')`);
    const [[sisymbrii], [andrena], [jackson]] = (await rows(
      conn,
      `SELECT entity_id FROM animal WHERE scientific_name = 'Lasioglossum sisymbrii'
       UNION ALL SELECT entity_id FROM animal WHERE scientific_name = 'Andrena'
       UNION ALL SELECT entity_id FROM person WHERE display_name = 'August Jackson'`,
    )) as [[number], [number], [number]];
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, sex, determiner_id, determiner_name, is_expert, channel, recorded_at)
       SELECT entity_id, ${sisymbrii}, 'female', ${jackson}, 'A.S.Jackson', true, 'legacy_import', TIMESTAMPTZ '2026-01-01 00:00:00+00'
       FROM specimen WHERE field_number IN ('26000001', '26000002')`,
    );
    await received([
      row("26000001", { identifiedBy: "A.S.Jackson" }),
      row("26000002", { family: "Andrenidae", genus: "Andrena", specificEpithet: undefined }),
    ]);
    const result = await load();
    expect(result).toMatchObject({ recorded: 1, alreadyRecorded: 1 });
    expect(result.supersededExpert).toEqual([
      { fieldNumber: "26000002", was: "Lasioglossum sisymbrii", wasBy: "A.S.Jackson", now: "Andrena", nowBy: "S.Burrows" },
    ]);
    const ofRecord = await rows(
      conn,
      `SELECT sp.field_number, d.animal_id FROM determination_of_record d JOIN specimen sp ON sp.entity_id = d.specimen_id ORDER BY 1`,
    );
    expect(ofRecord).toEqual([["26000001", sisymbrii], ["26000002", andrena]]);
  });

  test("loading the file again records nothing; a dry run records nothing at all", async () => {
    await received([row("26000001"), row("26000002")]);
    expect((await load(true)).recorded).toBe(2);
    expect(await determinations()).toEqual([]);
    expect(await rows(conn, `SELECT count(*) FROM person WHERE display_name = 'Skyler Burrows'`)).toEqual([[0n]]);
    expect((await load()).recorded).toBe(2);
    expect(await load()).toMatchObject({ recorded: 0, alreadyLoaded: 2, createdPeople: [] });
    expect(await determinations()).toHaveLength(2);
  });

  test("the tab is the workbook's first unless one is named", async () => {
    // The workbook stores the name escaped as XML (Bees &amp; Wasps), and read_xlsx wants it decoded.
    await received([row("26000001")], "Bees & Wasps");
    expect((await load()).sheet).toBe("Bees & Wasps");
    // JULY_14 is the clean sample's date; were the fixture to move, every date check above would hold for the wrong reason.
    expect(currentSeasonDate(7, 14)).toBe(`${CURRENT_SEASON}-07-14`);
  });
});
