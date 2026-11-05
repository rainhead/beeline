import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importTrapRegistry, parseMethod, parseMonth, readCollectorMap, registryDate } from "../src/import-trap-registry.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

// The method and month strings are lifted from Lincoln Best's registry
// (Wet_Sample_Inventory.xlsx, 2026-10-30), as the registry writes them.
describe("reading the registry's columns", () => {
  it("reads a month as a word, a number or a Roman numeral", () => {
    expect(["june", "June ", "6", "6.0", "VI", "vi", "jun"].map(parseMonth)).toEqual([6, 6, 6, 6, 6, 6, 6]);
    expect([null, "", "13", "thirteenth"].map(parseMonth)).toEqual([null, null, null, null]);
  });

  it("reads a day from three columns, refusing one the calendar lacks", () => {
    expect(registryDate("23.0", "june", "2019.0")).toBe("2019-06-23");
    expect(registryDate("31.0", "june", "2019.0")).toBeNull();
    expect(registryDate(null, "august", "2019.0")).toBeNull();
  });

  it("reads the kind of trap and how many from the method's first sentence", () => {
    expect(parseMethod("6 vane traps. Flowers in bloom - Tiquilia nuttallii, Oenothera caespitosa")).toEqual({
      kind: "trap", protocol: "vane trap", trapCount: 6, effort: null,
    });
    expect(parseMethod("16 pan traps ")).toMatchObject({ protocol: "pan trap", trapCount: 16 });
    expect(parseMethod("12 yellow, 4 blue cups. One pan tossed. Flowers in bloom - none")).toMatchObject({ protocol: "pan trap", trapCount: 16 });
    expect(parseMethod("72 vanes")).toMatchObject({ protocol: "vane trap", trapCount: 72 });
    expect(parseMethod("Vane trap")).toMatchObject({ protocol: "vane trap", trapCount: null });
    expect(parseMethod("one trap")).toMatchObject({ protocol: "trap", trapCount: 1 });
    expect(parseMethod("Bowl Trap")).toMatchObject({ protocol: "pan trap" });
    expect(parseMethod("42 pan traps, 14 vane traps")).toEqual({
      kind: "trap", protocol: "vane and pan traps", trapCount: null, effort: "42 pan traps, 14 vane traps",
    });
    expect(parseMethod("net")).toMatchObject({ kind: "net", protocol: "aerial net" });
    expect(parseMethod(null)).toMatchObject({ kind: "trap", protocol: "trap", trapCount: null });
  });

  it("maps every collector spelling to people, in order", async () => {
    const map = await readCollectorMap();
    expect(map.get("M and D O'Loughlin")).toEqual(["Michael O'Loughlin", "Dan O'Loughlin"]);
    expect(map.get("LRB")).toEqual(["Lincoln Best"]);
    // Left for Lincoln to say who they are.
    expect(map.has("R. and G. Pederson?")).toBe(false);
  });
});

describe("importing a registry", () => {
  let conn: DuckDBConnection;
  let dir: string;
  beforeEach(async () => {
    ({ conn } = await createMemoryDb());
    dir = await mkdtemp(join(tmpdir(), "beeline-trap-import-"));
    await conn.run(`INSERT INTO person (display_name) VALUES ('Michael O''Loughlin'), ('Dan O''Loughlin'), ('Lincoln Best')`);
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) SELECT entity_id, 1, 'beesofcanada' FROM person WHERE display_name = 'Lincoln Best'`);
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  // Synthetic rows in the registry's columns and spellings.
  const registry = [
    "sampleID,Original,Bombus,Collector,sampleMethod,startDay,startMonth,startYear,endDay,endMonth,endYear,Latitude,Longitude,Country,State,County,Locality,Processing",
    "OBAS-00707,n,yes,M and D O'Loughlin,24 vane traps,20,june,2021,30,july,2021,42.564,-119.806,USA,OR,Lake,Flagstaff Lake,9:54 min",
    "OBAS-00708,y,no,Michael & Dan O'Loughlin,net,20,VI,2021,20,VI,2021,42.564,-119.806,USA,OR,Lake,Flagstaff Lake,",
    "OBAS-00709,y,,LRB,vane trap,20,6,2021,,,,,,USA,OR,Lake,Flagstaff Lake,",
    "OBAS-00710,y,,R. and G. Pederson?,trap,20,june,2021,30,june,2021,44.3,-121.2,USA,OR,,Redmond,",
    "0BAS-00598,y,,LRB,trap,20,june,2021,30,june,2021,44.3,-121.2,USA,OR,,Redmond,",
    "OBAS-00657,y,,LRB,vane trap,1,july,2020,15,july,2020,44.5646,-123.262,USA,OR,Benton,Corvallis,",
    "OBAS-00711,y,,LRB,vane trap,1,june,2021,31,june,2021,44.3,-121.2,USA,OR,,Redmond,",
  ].join("\n");

  it("enters new samples, compares known ones, and holds what it cannot place", async () => {
    const lincoln = (await rows(conn, `SELECT entity_id FROM person WHERE display_name = 'Lincoln Best'`))[0]![0] as number;
    // Already in Beeline, from the old Beeline, with another end day.
    await insertCleanSample(conn, {
      kind: "'trap'", sample_number: "'OBAS-00657'", collector_id: String(lincoln),
      date_start: "DATE '2020-07-01'", date_end: "DATE '2020-07-16'",
    });
    const file = join(dir, "registry.csv");
    await writeFile(file, registry);
    const result = await importTrapRegistry(conn, { file, by: "beesofcanada" });

    expect(result.created).toEqual({ active: 0, settled: 2 });
    expect(result.held).toEqual({ number_shape: 1, collector_unknown: 1, no_date: 1, refused: 1 });
    expect(result.differing).toBe(1);
    expect(
      await rows(conn, `SELECT s.sample_number, s.kind, s.protocol, s.sampling_effort, s.specimen_count, strftime(s.date_end, '%Y-%m-%d'),
                               (SELECT string_agg(p.display_name, '|' ORDER BY c.position) FROM sample_collector c JOIN person p ON p.entity_id = c.person_id WHERE c.sample_id = s.entity_id),
                               e.entered_by
                        FROM sample s JOIN sample_entry e ON e.sample_id = s.entity_id ORDER BY 1`),
    ).toEqual([
      ["OBAS-00707", "trap", "vane trap", "24 vane traps", 0, "2021-07-30", "Michael O'Loughlin|Dan O'Loughlin", lincoln],
      ["OBAS-00708", "net", "aerial net", null, 0, "2021-06-20", "Michael O'Loughlin|Dan O'Loughlin", lincoln],
    ]);
    const held = await readFile(`${file}.held.csv`, "utf8");
    expect(held).toContain("OBAS-00709,refused,A latitude in decimal degrees is needed.");
    expect(held).toContain("OBAS-00710,collector_unknown,R. and G. Pederson?");
    expect(held).toContain("0BAS-00598,number_shape");
    // An end day written but not a date holds the row rather than printing the start day as the end.
    expect(held).toContain("OBAS-00711,no_date,end day: 31 june 2021");
    expect(await readFile(`${file}.differences.csv`, "utf8")).toContain("OBAS-00657,end day,2020-07-15,2020-07-16");

    // Run again, and what it entered is now what it compares against.
    const again = await importTrapRegistry(conn, { file, by: "beesofcanada" });
    expect(again.created).toEqual({ active: 0, settled: 0 });
    expect(again.unchanged).toBe(2);
  });

  it("writes nothing on a dry run", async () => {
    const file = join(dir, "registry.csv");
    await writeFile(file, registry);
    const result = await importTrapRegistry(conn, { file, by: "beesofcanada", dryRun: true });
    // OBAS-00657 too, which this store does not have.
    expect(result.created.settled).toBe(3);
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM sample_entry`)).toEqual([[0]]);
  });
});
