import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { en } from "../src/app/messages/en.js";
import { createApp } from "../src/app/server.js";
import { createKysely, openMemoryDuckDb } from "../src/db.js";
import { DEFAULT_RULINGS } from "../src/compare-legacy-export.js";
import {
  changesDir,
  LINE_SQL,
  LINES,
  readChangesSummary,
  writeChanges,
  type ChangesSummary,
} from "../src/legacy-changes.js";
import { readRulings, RECORD_COLUMN } from "../src/legacy-export-rulings.js";
import { legacyExportPath, writeLegacyExport } from "../src/legacy-export.js";
import { scratchPaths } from "./helpers.js";
import { promotedStore } from "./promoted-store.js";

/** The line each (kind, column, outcome) goes to, by LINE_SQL itself. */
async function linesOf(rows: [kind: string, column: string, outcome?: string][]): Promise<string[]> {
  const conn = await (await openMemoryDuckDb()).connect();
  const reader = await conn.runAndReadAll(
    `SELECT ${LINE_SQL} FROM (VALUES ${rows.map(([k, c, o], i) => `('${k}', '${c}', '${o ?? "expected"}', ${i})`).join(", ")}) t(kind, "column", outcome, i) ORDER BY i`,
  );
  conn.closeSync();
  return (reader.getRows() as [string][]).map(([l]) => l);
}

describe("the line each difference is on", () => {
  // Every kind with every column it was found in, comparing the production
  // backup of 15 November 2026 (03:00 Pacific) with its own export: each must
  // be on a line that says what it is, never `other`.
  const production: [string, string[]][] = [
    ["authorship", ["scientificName"]],
    ["case", ["userLogin", "lastName", "recordedBy", "firstName", "scientificName", "genusVolDet", "specificEpithet"]],
    ["changed", ["userLogin", "firstNameInitial", "taxonRank", "firstName", "order", "scientificName", "userId", "recordedBy", "familyVolDet"]],
    ["coarser_determination", ["specificEpithet", "subgenus", "taxonRank", "family", "genus", "scientificName"]],
    ["collector_added", ["firstNameInitial", "recordedBy", "lastName", "firstName"]],
    ["collector_alias", ["lastName", "recordedBy", "firstName"]],
    ["collector_list_form", ["firstName", "lastName", "firstNameInitial"]],
    ["collector_order_contradicted", ["recordedBy"]],
    ["country_code", ["country"]],
    ["date_form", ["month", "month2", "verbatimEventDate"]],
    ["filled", [
      "coordinateSource", "specificEpithet", "userId", "taxonRank", "class", "verbatimElevation", "phylum", "decimalLatitude",
      "startDayofYear", "taxon_geoprivacy", "family", "geoprivacy", "coordinateUncertaintyInMeters", "decimalLongitude", "county",
      "locality", "url", "endDayofYear", "order", "userLogin", "scientificName", "occurrenceRemarks",
    ]],
    ["initial_form", ["firstNameInitial"]],
    ["initial_from_surname", ["firstNameInitial"]],
    ["label_name", ["firstNameInitial"]],
    ["login_renamed", ["userLogin"]],
    ["morphospecies", ["scientificName"]],
    ["name_spelling", ["firstName", "recordedBy"]],
    ["newer_determination", ["sex", "scientificName", "specificEpithet", "genus", "identifiedBy", "family", "subgenus", "taxonRank", "caste"]],
    ["newer_volunteer_determination", ["genusVolDet", "casteVolDet", "familyVolDet", "sexVolDet", "speciesVolDet"]],
    ["one_day_range", ["year2", "startDayofYear", "month2", "day2", "endDayofYear"]],
    ["repair_placed", [
      "decimalLatitude", "startDayofYear", "day2", "verbatimElevation", "verbatimEventDate", "endDayofYear", "sampleId", "url",
      "coordinateSource", "coordinateUncertaintyInMeters", "decimalLongitude", "year2", "month2", "day", "occurrenceRemarks", "month",
    ]],
    ["reprinted", ["dateLabelPrint"]],
    ["second_print", ["genus", "genusVolDet", "casteVolDet", "identifiedBy", "specificEpithet", "taxonRank", "caste", "scientificName", "family", "sexVolDet", "sex", "familyVolDet"]],
    ["sex_caste_vocabulary", ["sex", "sexVolDet"]],
    ["staff_correction", ["endDayofYear", "samplingProtocol", "verbatimEventDate", "year2", "month2", "startDayofYear", "county", "locality", "day2"]],
    ["standin_replaced", ["decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters", "verbatimElevation", "coordinateSource"]],
    ["subgenus_dropped", ["subgenus"]],
    ["subgenus_form", ["genus", "scientificName", "genusVolDet"]],
    ["taxon_alias", ["speciesVolDet", "genusVolDet"]],
    ["unidentified_sex_dropped", ["sex"]],
    ["whitespace", ["speciesVolDet"]],
    ...["bad_date", "bad_specimen_number", "missing_sample_number", "missing_person", "duplicate_specimen", "tied_second_record", "minted_by_beeline"].map(
      (k): [string, string[]] => [k, [RECORD_COLUMN]],
    ),
  ];

  test("puts every kind found on production on a line that describes it", async () => {
    const rows = production.flatMap(([kind, columns]) => columns.map((c): [string, string] => [kind, c]));
    const lines = await linesOf(rows);
    const other = rows.filter((_, i) => lines[i] === "other");
    expect(other).toEqual([]);
  });

  test("puts every kind a checked-in ruling names on a line, in the column it names", async () => {
    const rows = (await readRulings(DEFAULT_RULINGS))
      .filter((r) => r.kind !== "" && r.column !== "")
      .map((r): [string, string] => [r.kind, r.column]);
    const lines = await linesOf(rows);
    expect(rows.filter((_, i) => lines[i] === "other")).toEqual([]);
  });

  test("tells a newer expert's sex from the rest of the newer identification, and the account from the collector", async () => {
    expect(
      await linesOf([
        ["newer_determination", "sex"],
        ["newer_determination", "genus"],
        ["changed", "userId"],
        ["changed", "firstName"],
        ["changed", "firstNameInitial"],
        ["changed", "scientificName"],
        ["filled", "specificEpithet"],
        ["filled", "phylum"],
      ]),
    ).toEqual(["newer_expert_sex", "newer_expert", "account", "collector_contradicted", "initials", "contradicted_name", "epithet_column", "classification"]);
  });

  test("puts a difference no ruling explains on a line of its own, whatever its kind", async () => {
    expect(await linesOf([["newer_determination", "genus", "unexplained"], ["changed", "url"]])).toEqual(["unexplained", "other"]);
  });

  test("no two lines take the same kind in the same column, so the order of the lines decides nothing", () => {
    const matches = LINES.flatMap((l) => l.match.map((m) => ({ line: l.id, ...m })));
    const clashes: string[] = [];
    for (const [i, a] of matches.entries()) {
      for (const b of matches.slice(i + 1)) {
        if (a.line === b.line) continue;
        const kinds = a.kinds.filter((k) => b.kinds.includes(k));
        const columnsMeet = a.columns === undefined || b.columns === undefined || a.columns.some((c) => b.columns!.includes(c));
        if (kinds.length > 0 && columnsMeet) clashes.push(`${a.line} and ${b.line}: ${kinds.join(", ")}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  test("every line has words, and ids the page can use as anchors and file names", () => {
    for (const l of LINES) {
      expect(l.id).toMatch(/^[a-z_]+$/);
      expect(l.title.length).toBeGreaterThan(0);
      expect(l.did.length).toBeGreaterThan(0);
    }
    expect(new Set(LINES.map((l) => l.id)).size).toBe(LINES.length);
  });
});

describe("writing the changes", () => {
  let instance: DuckDBInstance;
  let conn: DuckDBConnection;
  let exportsDir: string;
  let summary: ChangesSummary;
  /** The second run's night, which the third keeps (set by the test of keeping nights). */
  let nightBefore = "";
  /** A night's folder from long before, named as the job names one. */
  const OLDER_NIGHT = "2026-01-01T00-00-00-000Z";

  // Synthetic, in the shapes the production store showed on 2026-11-15: an
  // Ecdysis identification giving a sex the old record had otherwise
  // (2310599), and a difference no ruling explains.
  beforeAll(async () => {
    ({ instance, conn } = await promotedStore("occurrences"));
    await conn.run(`INSERT INTO determination (specimen_id, animal_id, verbatim_identification, sex, is_expert, channel)
      SELECT sp.entity_id, a.entity_id, 'Bombus vosnesenskii', 'female', true, 'ecdysis_import'
      FROM specimen sp, animal a WHERE sp.field_number = '25000005' AND a.scientific_name = 'Bombus vosnesenskii'`);
    exportsDir = await mkdtemp(join(tmpdir(), "legacy-changes-"));
    await writeLegacyExport(conn, legacyExportPath(exportsDir));
    await conn.run(`UPDATE legacy_occurrence SET sex = 'male' WHERE "fieldNumber" = '25000005'`);
    await conn.run(`UPDATE legacy_occurrence SET "taxonomicNotes" = 'planted' WHERE "fieldNumber" = '25000001'`);
    // An earlier night's folder that no summary names any more, and a folder
    // this did not write, as --out pointed at the exports folder would hold.
    const dir = changesDir(exportsDir);
    await mkdir(join(dir, OLDER_NIGHT), { recursive: true });
    await writeFile(join(dir, OLDER_NIGHT, "coarser.csv"), "stale");
    await mkdir(join(dir, "dwca"), { recursive: true });
    await conn.run("SET threads = 3");
    summary = await writeChanges(conn, legacyExportPath(exportsDir), await readRulings(DEFAULT_RULINGS), dir);
  });

  test("counts the records on each line by season, with a record to look at and what changed on it", () => {
    const sex = summary.lines.find((l) => l.line === "newer_expert_sex")!;
    expect(sex.active + sex.settled).toBe(1);
    expect(sex.outcomes).toEqual([{ outcome: "expected", active: 0, settled: 1 }]);
    const [example] = sex.examples;
    expect(example).toMatchObject({ fieldNumber: "25000005", values: [{ column: "sex", kind: "newer_determination", old: "male", new: "female" }] });
    expect(example!.specimenId).toEqual(expect.any(Number));
  });

  test("puts what no ruling explains on its own line rather than leaving it off", () => {
    // The fixture has a few of its own, among them on this record.
    const unexplained = summary.lines.find((l) => l.line === "unexplained")!;
    const record = unexplained.examples.find((e) => e.fieldNumber === "25000001");
    expect(record?.values).toContainEqual({ column: "taxonomicNotes", kind: "blanked", old: "planted", new: "" });
    expect(unexplained.outcomes.map((o) => o.outcome)).toEqual(["unexplained"]);
  });

  test("writes each line's every value to its own file, in a folder of the night's own", async () => {
    const dir = join(changesDir(exportsDir), summary.generation);
    const sex = summary.lines.find((l) => l.line === "newer_expert_sex")!;
    const bytes = await readFile(join(dir, sex.file));
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const [header, ...rows] = bytes.subarray(3).toString("utf8").trim().split("\n");
    expect(header).toBe("field_number,season,column,old_beeline,new_beeline,what_new_beeline_did,outcome,why");
    expect(rows).toHaveLength(sex.values);
    expect(rows[0]).toContain("25000005,settled,sex,male,female,Sex or caste from a newer expert identification,Not a fault in either,");
    expect(sex.bytes).toBe((await stat(join(dir, sex.file))).size);
    expect(await readChangesSummary(exportsDir)).toEqual(summary);
    // The older night's folder, which no summary named, is gone; the folder it did not write is not.
    await expect(stat(join(changesDir(exportsDir), OLDER_NIGHT))).rejects.toThrow();
    await stat(join(changesDir(exportsDir), "dwca"));
  });

  test("keeps the night before's folder, which a reader may still be downloading from, and nothing older", async () => {
    const root = changesDir(exportsDir);
    const second = await writeChanges(conn, legacyExportPath(exportsDir), await readRulings(DEFAULT_RULINGS), root);
    expect(second.generation).not.toBe(summary.generation);
    await stat(join(root, summary.generation, "newer_expert_sex.csv"));
    const third = await writeChanges(conn, legacyExportPath(exportsDir), await readRulings(DEFAULT_RULINGS), root);
    await expect(stat(join(root, summary.generation))).rejects.toThrow();
    expect((await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()).toEqual(
      [second.generation, third.generation, "dwca"].sort(),
    );
    nightBefore = second.generation;
  });

  test("leaves no temporary table behind and puts the thread count back", async () => {
    const [[left]] = (await (await conn.run(`
      SELECT count(*) FROM (SELECT table_name AS n FROM duckdb_tables() WHERE temporary
                            UNION ALL SELECT view_name FROM duckdb_views() WHERE temporary)
      WHERE starts_with(n, 'cmp_') OR starts_with(n, 'chg_')`)).getRows()) as [[bigint]];
    expect(Number(left)).toBe(0);
    const [[threads]] = (await (await conn.run(`SELECT current_setting('threads')`)).getRows()) as [[bigint]];
    expect(Number(threads)).toBe(3);
  });

  test("the page shows each line, and serves only the files the summary names, to admins only", async () => {
    const unusedInat: InatClient = {
      authorizeUrl: () => "unused",
      exchangeCode: () => Promise.reject(new Error("not under test")),
      identity: () => Promise.reject(new Error("not under test")),
    };
    const [[staff]] = (await (await conn.run(`INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)).getRows()) as [[number]];
    await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);
    const [[volunteer]] = (await (await conn.run(`INSERT INTO person (display_name) VALUES ('Val Volunteer') RETURNING entity_id`)).getRows()) as [[number]];
    let who = Number(staff);
    const app = createApp({
      ...(await scratchPaths()),
      db: createKysely(instance),
      config: { environment: "sandbox" as const, origin: "http://localhost:3054", exportsDir },
      inat: unusedInat,
      resolveSession: async () => ({ personId: who, login: "someone", iconUrl: null }),
    });
    expect(await (await app.request("/exports")).text()).toContain(`href="/exports/changes"`);
    const page = await (await app.request("/exports/changes")).text();
    expect(page).toContain(en.legacyChanges.heading.replaceAll("'", "&#39;"));
    expect(page).toContain("Sex or caste from a newer expert identification");
    expect(page).toContain(`href="#newer_expert_sex"`);
    expect(page).toContain("Not yet explained");
    // The page links to the night it shows, and the night before stays downloadable.
    const shown = (await readChangesSummary(exportsDir))!.generation;
    expect(page).toContain(`href="/exports/changes/${shown}/newer_expert_sex.csv"`);
    for (const night of [shown, nightBefore]) {
      const res = await app.request(`/exports/changes/${night}/newer_expert_sex.csv`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
    }
    // A night removed, a line with nothing on it, a folder that is no night, a file that is no line's.
    expect((await app.request(`/exports/changes/${summary.generation}/newer_expert_sex.csv`)).status).toBe(404);
    expect((await app.request(`/exports/changes/${shown}/coarser.csv`)).status).toBe(404);
    expect((await app.request("/exports/changes/dwca/newer_expert_sex.csv")).status).toBe(404);
    expect((await app.request(`/exports/changes/${shown}/summary.csv`)).status).toBe(404);

    who = Number(volunteer);
    expect((await app.request("/exports/changes")).status).toBe(403);
    expect((await app.request(`/exports/changes/${shown}/newer_expert_sex.csv`)).status).toBe(403);
  });

  test("says when nothing has been worked out yet", async () => {
    const { LegacyChangesPage } = await import("../src/app/views/legacy-changes.js");
    expect(String(await LegacyChangesPage({ m: en as never, summary: null }))).toContain(en.legacyChanges.missing);
  });
});

describe("the legacy-changes job", () => {
  test("refuses to run before there is an export, then writes the summary from it", async () => {
    const { buildJobs } = await import("../src/app/jobs/registry.js");
    const { runJob } = await import("../src/app/jobs/framework.js");
    const { instance, conn } = await promotedStore("occurrences");
    const dir = await mkdtemp(join(tmpdir(), "legacy-changes-job-"));
    const job = buildJobs({
      syncProjects: [],
      sweepDays: 365,
      personChangesPath: "unused",
      sampleChangesPath: "unused",
      sampleStatePath: "unused",
      exportsDir: dir,
    }).find((j) => j.name === "legacy-changes")!;
    const db = createKysely(instance);
    const last = () => db.selectFrom("job_run").select(["outcome", "detail"]).orderBy("entity_id", "desc").executeTakeFirstOrThrow();
    await runJob({ db, conn }, job);
    expect(await last()).toMatchObject({ outcome: "failed", detail: expect.stringMatching(/run legacy-export first/) });
    await writeLegacyExport(conn, legacyExportPath(dir));
    await runJob({ db, conn }, job);
    expect(await last()).toMatchObject({ outcome: "succeeded", detail: expect.stringMatching(/differing values on \d+ lines; records \(active \/ settled\) not yet explained \d+ \/ \d+, unsorted 0 \/ 0/) });
    expect((await readChangesSummary(dir))?.matched.settled).toBeGreaterThan(0);
  });
});
