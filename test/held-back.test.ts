import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { en } from "../src/app/messages/en.js";
import { createApp } from "../src/app/server.js";
import type { InatClient } from "../src/app/auth.js";
import { heldBackRecords, type HeldBack } from "../src/app/held-back.js";
import { HeldBackPage } from "../src/app/views/held-back.js";
import { AT_LARGE, NO_STATE_WRITTEN } from "../src/legacy-program.js";
import { compareLegacyExport, DEFAULT_RULINGS, dropComparisonTables } from "../src/compare-legacy-export.js";
import { legacyExportPath, writeLegacyExport } from "../src/legacy-export.js";
import { changesDir, writeChanges } from "../src/legacy-changes.js";
import { readRulings } from "../src/legacy-export-rulings.js";
import { LegacyChangesPage } from "../src/app/views/legacy-changes.js";
import { createKysely } from "../src/db.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { repairSkippedLegacyRecords } from "../src/repair-legacy-skipped.js";
import { createMemoryDb, FIXTURE_INPUTS, insertCleanSample, scratchPaths } from "./helpers.js";

/**
 * The page of old-Beeline records new Beeline held back (beeline-cel0), over
 * the records test/repair-legacy-skipped.test.ts describes one by one, after
 * promotion and the repair have run on them as they did on production. Two
 * records with nothing but a field number are added, as the old system's
 * empty labels 25100000 onward are on production, and one with only a month.
 */
const FIXTURE = new URL("./fixtures/legacy-skipped.jsonl", import.meta.url).pathname;

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

let conn: DuckDBConnection;
let app: ReturnType<typeof createApp>;
let signedIn: { personId: number; login: string };
let staff: number;
let volunteer: number;
let held: HeldBack;
let db: ReturnType<typeof createKysely>;

const byField = (n: string) => held.records.find((r) => r.fieldNumber === n);

beforeAll(async () => {
  const created = await createMemoryDb();
  conn = created.conn;
  // The fixture, two empty labels sharing one field number, and one with a month.
  const lines = (await readFile(FIXTURE, "utf8")).split("\n").filter((l) => l.trim() !== "");
  const blank = Object.fromEntries(Object.keys(JSON.parse(lines[0]!)).map((k) => [k, ""]));
  const bare = ["bare1", "bare2"].map((id) => JSON.stringify({ ...blank, _id: id, fieldNumber: "25100000" }));
  // Synthetic: nothing but a month, which is not nothing.
  bare.push(JSON.stringify({ ...blank, _id: "partial", fieldNumber: "25100099", month: "6" }));
  const staged = join(await mkdtemp(join(tmpdir(), "beeline-held-back-")), "legacy.jsonl");
  await writeFile(staged, [...lines, ...bare].join("\n") + "\n");
  await loadLegacyStaging(conn, staged);
  await promoteLegacy(conn, FIXTURE_INPUTS);
  // As in the repair's own test: the samples the nightly sync made from observations.
  for (const [number, observation, count] of [["'02viii20.1'", "56359335", null], ["'3'", "56370000", "1"]] as const) {
    await insertCleanSample(conn, {
      sample_number: number,
      inat_observation_id: observation,
      ...(count === null ? {} : { specimen_count: count }),
      collector_id: "(SELECT entity_id FROM person WHERE display_name = 'Cleo Cortez')",
    });
  }
  await conn.run(
    `INSERT INTO observation_field (inat_id, collection_method_raw, specimen_count_raw)
     VALUES (56390000, 'pan trap', '1'), (56391000, 'net', '1'), (56392000, 'pan trap', '2'), (56393000, 'pan trap', '2')`,
  );
  await repairSkippedLegacyRecords(conn);

  const [[s]] = (await (await conn.run(`INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)).getRows()) as [[number]];
  staff = s;
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);
  volunteer = ((await (await conn.run(`SELECT entity_id FROM person WHERE display_name = 'Cleo Cortez'`)).getRows()) as [[number]])[0][0];
  signedIn = { personId: staff, login: "staff" };
  db = createKysely(created.instance);
  app = createApp({
    ...(await scratchPaths()),
    db,
    config: { environment: "sandbox" as const, origin: "http://localhost:3054", exportsDir: await mkdtemp(join(tmpdir(), "beeline-exports-")) },
    inat: unusedInat,
    resolveSession: async () => ({ ...signedIn, iconUrl: null }),
  });
  held = (await heldBackRecords(db))!;
});

describe("the old records new Beeline held back", () => {
  test("lists what promotion refused and the repair left out, and nothing Beeline holds", () => {
    // Left out by the repair, each for its own reason.
    expect(byField("2127399")?.rules).toEqual(["bad_specimen_number"]);
    expect(byField("2050001")?.rules).toEqual(["bad_specimen_number"]);
    // Its observation is a sample in Beeline that counts one bee and holds none,
    // which is the case worth a taxonomist's time.
    expect(byField("2050001")?.sample).toMatchObject({ counts: 1, holds: 0 });
    expect(byField("2127399")?.sample).toBeNull();
    // A pair the repair would not tie: the set-aside record, with the kept specimen's remark.
    expect(byField("2127010")).toMatchObject({
      rules: ["duplicate_specimen"],
      collector: "Cleo Cortez",
      sampleNumber: "7",
      date: "2021-6-10",
      expert: "Bombus vosnesenskii",
      related: { fieldNumber: "2127325", remark: expect.stringContaining("11.1 km apart") },
    });
    // A refused record the repair matched to a specimen but would not tie;
    // its remark names it with a comma after the number.
    expect(byField("Cleo_Cortez:20.008.002")?.related).toMatchObject({
      fieldNumber: "Cleo_Cortez:18.008.002",
      remark: expect.stringContaining("field number Cleo_Cortez:20.008.002, a record with details missing"),
    });
    // Kept, tied as a second print, placed, or tied as a second entry: none is held back.
    for (const n of ["2127319", "2127004", "Cleo_Cortez:18.008.004", "Cleo_Cortez:19.008.001", "2037759"]) expect(byField(n)).toBeUndefined();
  });

  test("counts the bare records rather than listing them, and counts the reasons by program", () => {
    expect(held.bare).toEqual({ records: 2, fieldNumbers: 1, first: "25100000", last: "25100000" });
    // The two blank records rank against each other in promotion, but neither
    // was kept, so neither is called a second print of the other.
    expect(held.records.every((r) => r.rules.length > 0)).toBe(true);
    expect(held.records.some((r) => r.fieldNumber === "25100000")).toBe(false);
    // A record that wrote any part of a date is listed, with what it wrote.
    expect(byField("25100099")).toMatchObject({ date: "?-6-?" });
    const duplicates = held.reasons.find((r) => r.rule === "duplicate_specimen")!;
    expect(Object.values(duplicates.records).reduce((t, x) => t + x, 0)).toBe(held.records.filter((r) => r.rules.includes("duplicate_specimen")).length);
    // Each program with a listed record, and the records in field-number order under each.
    expect(held.programs).toEqual([...new Set(held.records.map((r) => r.program))].sort((a, b) => held.programs.indexOf(a) - held.programs.indexOf(b)));
    for (const p of held.programs) {
      const numbers = held.records.filter((r) => r.program === p).map((r) => r.fieldNumber);
      expect(numbers).toEqual([...numbers].sort());
    }
  });

  test("shows staff the page and the download, linked from Exports", async () => {
    const exportsPage = await (await app.request("/exports")).text();
    expect(exportsPage).toContain(`href="/exports/held-back"`);
    const page = await (await app.request("/exports/held-back")).text();
    expect(page).toContain(en.heldBack.heading);
    expect(page).toContain(en.heldBack.reason.duplicate_specimen);
    expect(page).toContain("2127010");
    expect(page).toContain(`href="https://www.inaturalist.org/observations/`);
    expect(page).toContain(en.heldBack.bare(1, "25100000", "25100000", 2).replaceAll("'", "&#39;"));
    expect(page).toContain(en.heldBack.sampleCounts(1, 0));

    const res = await app.request("/exports/held-back.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const lines = (await res.text()).replace(/^﻿/, "").trim().split("\n");
    expect(lines[0]!.startsWith("_id,")).toBe(true);
    expect(lines[0]!.endsWith(",held_back_because,beeline_note_specimen,beeline_note,beeline_sample_id,beeline_sample_counts,beeline_sample_holds,beeline_program")).toBe(true);
    // Every listed record and both bare ones.
    expect(lines.length - 1).toBe(held.records.length + 2);
    // Reasons in the page's words, with the note on the kept specimen.
    const pair = lines.find((l) => l.includes(",2127010,"))!;
    // Quoted, since the sentence has commas in it.
    expect(pair).toContain(`,"${en.heldBack.reason.duplicate_specimen}",2127325,`);
    expect(pair).toContain("11.1 km apart");
    const blank = lines.filter((l) => l.includes(",25100000,"));
    expect(blank).toHaveLength(2);
    for (const l of blank) expect(l).not.toContain(en.heldBack.reason.duplicate_specimen);
    expect(lines.find((l) => l.includes(",2050001,"))).toMatch(/,1,0,[A-Za-z ]+$/);
  });

  test("is refused to a volunteer", async () => {
    signedIn = { personId: volunteer, login: "cleocortez" };
    try {
      expect((await app.request("/exports/held-back")).status).toBe(403);
      expect((await app.request("/exports/held-back.csv")).status).toBe(403);
    } finally {
      signedIn = { personId: staff, login: "staff" };
    }
  });
});

describe("the program each record belongs to (beeline-z0pi)", () => {
  const one = async (sqlText: string) => ((await (await conn.run(sqlText)).getRows()) as unknown[][])[0]?.[0];
  const program = async (code: string) => Number(await one(`SELECT entity_id FROM program WHERE code = '${code}'`));
  const fileUnder = async (sampleId: number, code: string | null) => {
    await conn.run(`DELETE FROM sample_atlas WHERE sample_id = ${sampleId}`);
    await conn.run(`INSERT INTO sample_atlas (sample_id, atlas_id, assigned_by) VALUES (${sampleId}, ${code === null ? "NULL" : await program(code)}, ${code === null ? staff : "NULL"})`);
  };

  /** Synthetic: a held-back record, cloned from the one that wrote only a month, with the state and observation given. */
  async function programOf(state: string, observation: number | null): Promise<string> {
    await conn.run(`INSERT INTO legacy_occurrence SELECT * REPLACE ('program-probe' AS _id, '29990001' AS "fieldNumber", '${state}' AS "stateProvince",
                      '${observation === null ? "" : `https://www.inaturalist.org/observations/${observation}`}' AS url)
                    FROM legacy_occurrence WHERE _id = 'partial'`);
    try {
      return (await heldBackRecords(db))!.records.find((r) => r.fieldNumber === "29990001")!.program;
    } finally {
      await conn.run(`DELETE FROM legacy_occurrence WHERE _id = 'program-probe'`);
    }
  }

  test("takes the atlas of the state a record wrote where its observation is in no sample", async () => {
    expect(await programOf("OR", null)).toBe("OBA");
    // Washington's abbreviation is WABA, not its code WaBA.
    expect(await programOf("WA", null)).toBe("WABA");
    expect(await programOf("wa ", null)).toBe("WABA");
  });

  test("calls a record At large where its state belongs to no atlas, or is none", async () => {
    expect(await programOf("CA", null)).toBe(AT_LARGE);
    expect(await programOf("ZZ", null)).toBe(AT_LARGE);
    expect(AT_LARGE).toBe(en.listings.scope.outside);
  });

  test("gives a record that wrote no state and has no sample a group of its own, not At large", async () => {
    expect(await programOf("", null)).toBe(NO_STATE_WRITTEN);
    expect(await programOf("  ", 12345)).toBe(NO_STATE_WRITTEN);
  });

  test("takes the atlas of the sample its observation is in Beeline before the state it wrote", async () => {
    const sample = Number(await one(`SELECT entity_id FROM sample WHERE inat_observation_id = 56359335`));
    const before = await one(`SELECT atlas_id FROM sample_atlas WHERE sample_id = ${sample}`);
    try {
      await fileUnder(sample, "WaBA");
      expect(await programOf("OR", 56359335)).toBe("WABA");
      // A sample under no atlas is At large, whatever state the record wrote or leaves blank.
      await fileUnder(sample, null);
      expect(await programOf("OR", 56359335)).toBe(AT_LARGE);
      expect(await programOf("", 56359335)).toBe(AT_LARGE);
    } finally {
      await conn.run(`DELETE FROM sample_atlas WHERE sample_id = ${sample}`);
      if (before !== undefined && before !== null) await conn.run(`INSERT INTO sample_atlas (sample_id, atlas_id) VALUES (${sample}, ${before})`);
    }
  });

  test("lists each program's records under it, programs in the program table's order, then At large, then no state", async () => {
    for (const [i, [number, state]] of [["29990010", ""], ["29990011", "CA"], ["29990012", "WA"], ["29990013", "OR"]].entries()) {
      await conn.run(`INSERT INTO legacy_occurrence SELECT * REPLACE ('probe-${i}' AS _id, '${number}' AS "fieldNumber", '${state}' AS "stateProvince", '' AS url)
                      FROM legacy_occurrence WHERE _id = 'partial'`);
    }
    try {
      const h = (await heldBackRecords(db))!;
      expect(h.programs).toEqual(["OBA", "WABA", AT_LARGE, NO_STATE_WRITTEN].filter((p) => h.programs.includes(p)));
      expect(h.programs.slice(-2)).toEqual([AT_LARGE, NO_STATE_WRITTEN]);
      // The records come grouped in that order.
      expect(h.records.map((r) => r.program)).toEqual([...h.records.map((r) => r.program)].sort((a, b) => h.programs.indexOf(a) - h.programs.indexOf(b)));
      const page = String(HeldBackPage({ m: en as never, heldBack: h }));
      for (const p of h.programs) expect(page).toContain(`<h3>${p}</h3>`);
      expect(h.reasons.every((r) => Object.keys(r.records).every((p) => h.programs.includes(p)))).toBe(true);
      expect(page).not.toMatch(/Active seasons|Settled seasons/);
    } finally {
      await conn.run(`DELETE FROM legacy_occurrence WHERE starts_with(_id, 'probe-')`);
    }
  });

  test("puts a carried-over record under its specimen's atlas, and a second record under the specimen it is tied to", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "held-back-program-")), "occurrences.csv");
    await writeLegacyExport(conn, path);
    const tied = (await (await conn.run(`
      SELECT o."fieldNumber", sp.field_number, sp.sample_id FROM legacy_duplicate_record r
      JOIN legacy_occurrence o ON o._id = r._id JOIN specimen sp ON sp.entity_id = r.specimen_id LIMIT 1`)).getRows()) as [string, string, number][];
    const [secondRecord, specimenNumber, sampleOfBoth] = [tied[0]![0], tied[0]![1], Number(tied[0]![2])];
    // A carried pair in another sample, to file under no atlas.
    const other = (await (await conn.run(`
      SELECT field_number, sample_id FROM specimen sp WHERE sample_id <> ${sampleOfBoth} AND field_number IN (SELECT "fieldNumber" FROM legacy_occurrence)
      ORDER BY field_number LIMIT 1`)).getRows()) as [string, number][];
    const [otherNumber, otherSample] = [other[0]![0], Number(other[0]![1])];
    const before = [sampleOfBoth, otherSample].map(async (id) => [id, await one(`SELECT atlas_id FROM sample_atlas WHERE sample_id = ${id}`)] as const);
    const saved = await Promise.all(before);
    try {
      await fileUnder(sampleOfBoth, "WaBA");
      await fileUnder(otherSample, null);
      await compareLegacyExport(conn, path);
      const programOfPair = async (n: string) => (await (await conn.run(`SELECT program FROM cmp_pairs WHERE "e_fieldNumber" = '${n}'`)).getRows()) as [string][];
      expect(await programOfPair(specimenNumber)).toEqual([["WABA"]]);
      expect(await programOfPair(otherNumber)).toEqual([[AT_LARGE]]);
      // The second record is only old Beeline's, and in the program of the specimen it is tied to.
      expect(await one(`SELECT program FROM cmp_difference WHERE field_number = '${secondRecord}' AND "column" = '(record)'`)).toBe("WABA");
    } finally {
      await dropComparisonTables(conn);
      for (const [id, atlas] of saved) {
        await conn.run(`DELETE FROM sample_atlas WHERE sample_id = ${id}`);
        if (atlas !== undefined && atlas !== null) await conn.run(`INSERT INTO sample_atlas (sample_id, atlas_id) VALUES (${id}, ${atlas})`);
      }
    }
  });
});

describe("the comparison of the old records with the export (beeline-eznn)", () => {
  // A second print the repair tied to a specimen is carried over, though
  // promotion's blocking finding still stands on it: the comparison had been
  // counting all 235 on the backup of 15 November 2026 as held back.
  test("calls a record the repair tied to a specimen a second record, and only the rest held back", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "held-back-compare-")), "occurrences.csv");
    await writeLegacyExport(conn, path);
    await compareLegacyExport(conn, path);
    try {
      const rows = (await (await conn.run(`
        SELECT d.field_number, d.kind, EXISTS (SELECT 1 FROM legacy_duplicate_record r JOIN legacy_occurrence o ON o._id = r._id
                                               WHERE o."fieldNumber" = d.field_number) AS tied
        FROM cmp_difference d WHERE d."column" = '(record)' AND d.legacy = 'present'`)).getRows()) as [string, string, boolean][];
      const tied = rows.filter(([, , t]) => t);
      expect(tied.length).toBeGreaterThan(0);
      expect(tied.every(([, kind]) => kind === "tied_second_record")).toBe(true);
      // Every other is one the page lists, or the field number of the bare
      // records, which the comparison names once for each of the two.
      const listed = new Set([...held.records.map((r) => r.fieldNumber), "25100000"]);
      expect([...new Set(rows.filter(([, , t]) => !t).map(([n]) => n))].sort()).toEqual([...listed].sort());
    } finally {
      await dropComparisonTables(conn);
    }
  });
});

describe("the second records of a pin, on What new Beeline changed", () => {
  // A list of corrections may name one of these field numbers, so the line's
  // download says which specimen each is tied to.
  test("gives the specimen each record is tied to, in its download and its examples", async () => {
    const exportsDir = await mkdtemp(join(tmpdir(), "held-back-changes-"));
    await writeLegacyExport(conn, legacyExportPath(exportsDir));
    const summary = await writeChanges(conn, legacyExportPath(exportsDir), await readRulings(DEFAULT_RULINGS), changesDir(exportsDir));
    const line = summary.lines.find((l) => l.line === "second_record")!;
    const tied = new Map(
      ((await (await conn.run(`
        SELECT o."fieldNumber", sp.field_number FROM legacy_duplicate_record r
        JOIN legacy_occurrence o ON o._id = r._id JOIN specimen sp ON sp.entity_id = r.specimen_id`)).getRows()) as [string, string][]),
    );
    expect(tied.size).toBeGreaterThan(0);
    const csv = (await readFile(join(changesDir(exportsDir), summary.generation, line.file!), "utf8")).replace(/^﻿/, "");
    const [header, ...rows] = csv.trim().split("\n");
    expect(header).toBe("old_field_number,program,tied_to_field_number,specimen_identified_from_a_second_record");
    expect(rows.map((r) => r.split(",").slice(0, 3)).map(([old, , to]) => [old, to])).toEqual(
      [...tied.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    for (const e of line.examples) {
      expect(e.values).toEqual([{ column: "(record)", kind: "tied_second_record", old: "present", new: tied.get(e.fieldNumber) }]);
    }
    const page = String(await LegacyChangesPage({ m: en as never, summary }));
    expect(page).toContain(en.legacyChanges.record.tiedTo(tied.get(line.examples[0]!.fieldNumber)!));
    expect(page).toContain("Download the specimen each record is tied to (CSV,");
  });
});

describe("a store without the old Beeline's records", () => {
  test("says it cannot tell, rather than failing", async () => {
    const { instance, conn: bare } = await createMemoryDb();
    const [[id]] = (await (await bare.run(`INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)).getRows()) as [[number]];
    await bare.run(`INSERT INTO person_admin (person_id) VALUES (${id})`);
    const empty = createApp({
      ...(await scratchPaths()),
      db: createKysely(instance),
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId: id, login: "staff", iconUrl: null }),
    });
    expect(await (await empty.request("/exports/held-back")).text()).toContain(en.heldBack.noStaging.replaceAll("'", "&#39;"));
    expect((await empty.request("/exports/held-back.csv")).status).toBe(404);
  });
});
