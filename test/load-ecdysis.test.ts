import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { loadEcdysis } from "../src/load-ecdysis.js";

/**
 * Determinations from Ecdysis (beeline-9ut). The fixture is the shape of a
 * Symbiota Darwin Core archive as Washington's collection exports it —
 * catalog numbers under WSDA_, an identification history with one current
 * row per occurrence, "s.d." and bare years for dates, a placeholder
 * 'undetermined' row, a qualifier written as 'cf. <epithet>' — with fictional
 * people. The flat files are the occurrence-only export staff download today.
 */

const FIXTURES = new URL("./fixtures/ecdysis/", import.meta.url).pathname;
const ALIASES = `${FIXTURES}determiner-aliases.csv`;

let conn: DuckDBConnection;
let a: number;
let b: number;
let c: number;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector'), ('Sam Staff')`);
  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('genus', 'Bombus'), ('genus', 'Andrena'), ('genus', 'Lasioglossum')`);
  for (const [genus, species] of [["Bombus", "Bombus vosnesenskii"], ["Andrena", "Andrena sladeni"], ["Lasioglossum", "Lasioglossum cooleyi"]]) {
    await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) SELECT 'species', '${species}', entity_id FROM animal WHERE scientific_name = '${genus}'`);
  }
  const sample = await insertCleanSample(conn, { specimen_count: "3" });
  const specimen = async (n: number, fieldNumber: string) => {
    const [[id]] = (await rows(
      conn,
      `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, ${n}, '${fieldNumber}') RETURNING entity_id`,
    )) as [[number]];
    return Number(id);
  };
  a = await specimen(1, "2303966");
  b = await specimen(2, "2303967");
  c = await specimen(3, "2303968");
});

const one = async (sql: string) => (await rows(conn, sql))[0];
const record = (specimenId: number) =>
  one(`SELECT an.scientific_name, r.qualifier, coalesce(p.display_name, r.determiner_name), CAST(r.determined_on AS VARCHAR), r.determined_on_precision, r.notes, r.channel
       FROM determination_of_record r JOIN animal an ON an.entity_id = r.animal_id LEFT JOIN person p ON p.entity_id = r.determiner_id
       WHERE r.specimen_id = ${specimenId}`);

describe("an unpacked Darwin Core archive", () => {
  test("records the history, and the identification Ecdysis calls current is the record", async () => {
    const result = await loadEcdysis(conn, { path: `${FIXTURES}archive`, catalogPrefix: "WSDA_", determinerAliases: ALIASES });
    expect(result).toMatchObject({
      input: "archive",
      occurrences: 5,
      matched: 3,
      unmatched: 2,
      unmatchedSample: ["OTHER_2303966", "WSDA_9999999"],
      identifications: 6,
      placeholders: 1,
      alreadyLoaded: 0,
      unresolvedNames: [{ name: "Nomada", rows: 1 }],
      loaded: 4,
    });
    expect(result.determiners).toEqual([
      { name: "Ellen Expert", rows: 2, resolved: false },
      { name: "Sam A. Staff", rows: 2, resolved: true },
    ]);

    // Specimen A: the placeholder is skipped, the genus-level entry is
    // history, and the species-level one Ecdysis flags current is the
    // record — by recorded_at order, since dateIdentified ("2025") says
    // nothing finer than the year, and that is what the precision says.
    expect(await record(a)).toEqual(["Andrena sladeni", null, "Sam Staff", "2025-01-01", "year", null, "ecdysis_import"]);
    expect(await one(`SELECT count(*) FROM determination WHERE specimen_id = ${a}`)).toEqual([2n]);
    expect(
      await rows(conn, `SELECT an.scientific_name FROM determination d JOIN animal an ON an.entity_id = d.animal_id WHERE d.specimen_id = ${a} ORDER BY d.recorded_at`),
    ).toEqual([["Andrena"], ["Andrena sladeni"]]);

    // Specimen B: a real date, a qualifier the store admits, the remarks
    // kept as notes, a determiner the store has no person for.
    expect(await record(b)).toEqual(["Lasioglossum cooleyi", "cf.", "Ellen Expert", "2025-04-28", null, "Dialictus", "ecdysis_import"]);

    // Specimen C: the current identification names a taxon the store does
    // not carry (Nomada) and is reported rather than minted; the older
    // genus-level row loads with nothing said about its date or determiner.
    expect(await record(c)).toEqual(["Bombus", null, null, null, null, null, "ecdysis_import"]);

    // Every loaded determination is keyed to its Symbiota identification.
    expect(await rows(conn, `SELECT record_id, occurrence_id, CAST(entered_at AS VARCHAR) FROM ecdysis_identification ORDER BY record_id`)).toEqual([
      ["id-a2", "occ-a", "2025-09-23 14:13:48"],
      ["id-a3", "occ-a", "2025-03-01 10:00:00"],
      ["id-b1", "occ-b", "2025-05-02 09:00:00"],
      ["id-c2", "occ-c", "2025-01-01 00:00:00"],
    ]);
  });

  test("is idempotent: the same archive again records nothing", async () => {
    await loadEcdysis(conn, { path: `${FIXTURES}archive`, catalogPrefix: "WSDA_", determinerAliases: ALIASES });
    const again = await loadEcdysis(conn, { path: `${FIXTURES}archive`, catalogPrefix: "WSDA_", determinerAliases: ALIASES });
    expect(again).toMatchObject({ loaded: 0, alreadyLoaded: 4, unresolvedNames: [{ name: "Nomada", rows: 1 }] });
    expect(await one(`SELECT count(*) FROM determination`)).toEqual([4n]);
  });

  test("a wrong prefix matches nothing and says so", async () => {
    const result = await loadEcdysis(conn, { path: `${FIXTURES}archive`, catalogPrefix: "OSAC_", determinerAliases: ALIASES });
    expect(result).toMatchObject({ matched: 0, unmatched: 5, loaded: 0 });
  });
});

describe("a flat occurrence export", () => {
  test("re-stating the archive's current identification records nothing; a revised one supersedes it", async () => {
    await loadEcdysis(conn, { path: `${FIXTURES}archive`, catalogPrefix: "WSDA_", determinerAliases: ALIASES });
    const same = await loadEcdysis(conn, { path: `${FIXTURES}flat-same.csv`, catalogPrefix: "WSDA_", determinerAliases: ALIASES });
    expect(same).toMatchObject({ input: "flat", occurrences: 1, matched: 1, identifications: 1, alreadyLoaded: 1, loaded: 0 });

    // A revision, loaded later, supersedes: a current identification is
    // recorded when it crosses into Beeline, like any event.
    const revised = await loadEcdysis(conn, { path: `${FIXTURES}flat-revised.csv`, catalogPrefix: "WSDA_", determinerAliases: ALIASES });
    expect(revised).toMatchObject({ loaded: 1, alreadyLoaded: 0 });
    expect(await record(a)).toEqual(["Bombus vosnesenskii", null, "Ellen Expert", "2026-01-01", "year", "revised after dissection", "ecdysis_import"]);
    // The earlier events stay: a correction is a newer event, never an edit.
    expect(await one(`SELECT count(*) FROM determination WHERE specimen_id = ${a}`)).toEqual([3n]);
    // And loading the revision again is a no-op, through the derived key.
    const again = await loadEcdysis(conn, { path: `${FIXTURES}flat-revised.csv`, catalogPrefix: "WSDA_", determinerAliases: ALIASES });
    expect(again).toMatchObject({ loaded: 0, alreadyLoaded: 1 });
  });

  test("an export older than one already loaded is refused, since it would supersede the revisions", async () => {
    await loadEcdysis(conn, { path: `${FIXTURES}flat-revised.csv`, catalogPrefix: "WSDA_", determinerAliases: ALIASES });
    await expect(
      loadEcdysis(conn, { path: `${FIXTURES}flat-same.csv`, catalogPrefix: "WSDA_", determinerAliases: ALIASES }),
    ).rejects.toThrow(/load exports in the order they were taken/);
    expect(await one(`SELECT count(*) FROM determination`)).toEqual([1n]);
    // Forced, it loads as a current identification and so becomes the
    // record — which is exactly the damage the guard exists to refuse.
    const forced = await loadEcdysis(conn, { path: `${FIXTURES}flat-same.csv`, catalogPrefix: "WSDA_", determinerAliases: ALIASES, force: true });
    expect(forced.loaded).toBe(1);
    expect((await record(a))![0]).toBe("Andrena sladeni");
  });

  test("an archive loaded after a flat export records its history and restates nothing", async () => {
    await loadEcdysis(conn, { path: `${FIXTURES}flat-same.csv`, catalogPrefix: "WSDA_", determinerAliases: ALIASES });
    expect(await one(`SELECT count(*) FROM determination`)).toEqual([1n]);
    const archive = await loadEcdysis(conn, { path: `${FIXTURES}archive`, catalogPrefix: "WSDA_", determinerAliases: ALIASES });
    // The archive's current row for specimen A restates the flat load; its
    // older genus-level row is new history and lands before it in time.
    expect(archive).toMatchObject({ alreadyLoaded: 1, loaded: 3 });
    expect((await record(a))![0]).toBe("Andrena sladeni");
    // The history row carries the moment Ecdysis entered it; the current
    // one, loaded first by the flat export, the moment it crossed.
    const events = await rows(conn, `SELECT an.scientific_name, CAST(d.recorded_at AS VARCHAR) FROM determination d JOIN animal an ON an.entity_id = d.animal_id WHERE d.specimen_id = ${a} ORDER BY d.recorded_at`);
    expect(events.map((e) => e[0])).toEqual(["Andrena", "Andrena sladeni"]);
    expect(String(events[0]![1])).toMatch(/^2025-03-01/);
  });

  test("the current identification supersedes the legacy import's copy of it, and so gains its date", async () => {
    // What the legacy dump holds for Washington is the old system's copy of
    // Ecdysis's determinations, undated. The Ecdysis event is the same
    // assertion with more said about it, and it becomes the record.
    await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_name, recorded_at)
                    SELECT ${a}, entity_id, true, 'legacy_import', 'Sam A. Staff', TIMESTAMPTZ '2026-08-20 22:20:40Z' FROM animal WHERE scientific_name = 'Andrena sladeni'`);
    await loadEcdysis(conn, { path: `${FIXTURES}archive`, catalogPrefix: "WSDA_", determinerAliases: ALIASES });
    expect(await record(a)).toEqual(["Andrena sladeni", null, "Sam Staff", "2025-01-01", "year", null, "ecdysis_import"]);
  });
});
