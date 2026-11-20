import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import { LOOKALIKE_METRES, findLookalikes, lookalikesAmong, readLookalikeCandidates, readSeriesHolders, readTrapNumbers, seriesNumberHolder, numberTaken, type LookalikeFacts } from "../src/trap-sample.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

let conn: DuckDBConnection;
let ann: number;
let bo: number;
const LAT = 44.5;
const LON = -123.2;
/** A point this many metres due north of the base point (a degree of latitude is 111,195 m on the sphere the rule uses). */
const north = (metres: number) => LAT + (metres / 6_371_000) * (180 / Math.PI);

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  const ids = await rows(conn, `INSERT INTO person (display_name) VALUES ('Ann'), ('Bo') RETURNING entity_id`);
  [ann, bo] = ids.map((r) => r[0] as number) as [number, number];
});

const sample = (number: string, collector: number, start: string, end: string, lat: number | null, extra: Record<string, string> = {}) =>
  insertCleanSample(conn, { kind: "'trap'", sample_number: `'${number}'`, collector_id: String(collector), date_start: `DATE '${start}'`, date_end: `DATE '${end}'`, ...extra }, lat === null ? null : { latitude: String(lat), longitude: String(LON) });

describe("the look-alike rule, asked of the store and of candidates read once", () => {
  it("answers the same in both, at the edges of the rule", async () => {
    await sample("N-inside", ann, "2026-06-10", "2026-06-20", north(LOOKALIKE_METRES - 0.1));
    await sample("N-outside", ann, "2026-06-10", "2026-06-20", north(LOOKALIKE_METRES + 0.1));
    await sample("N-touching", ann, "2026-06-20", "2026-06-25", LAT);
    await sample("N-just-after", ann, "2026-06-21", "2026-06-25", LAT);
    await sample("N-before", ann, "2026-06-01", "2026-06-09", LAT);
    await sample("N-bo", bo, "2026-06-10", "2026-06-20", LAT);
    await sample("N-nopoint", ann, "2026-06-10", "2026-06-20", null);
    const two = await sample("N-two-heads", ann, "2026-06-10", "2026-06-20", LAT);
    await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${two}, ${bo}, 1)`);
    const second = await sample("N-second", bo, "2026-06-10", "2026-06-20", LAT);
    await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${second}, ${ann}, 2)`);

    const candidates = await readLookalikeCandidates(conn, [ann, bo]);
    const cases: Array<[string, LookalikeFacts, { sampleId?: number }?]> = [
      ["the base point, four days", { firstCollectorId: ann, dateStart: "2026-06-12", dateEnd: "2026-06-15", latitude: LAT, longitude: LON }],
      ["the base point, between a sample just inside 100 m and one just outside", { firstCollectorId: ann, dateStart: "2026-06-12", dateEnd: "2026-06-12", latitude: north(0), longitude: LON }],
      ["a point 100.5 m from the nearer", { firstCollectorId: ann, dateStart: "2026-06-12", dateEnd: "2026-06-12", latitude: north(-0.6), longitude: LON }],
      ["a point 99.5 m from the nearer and 99.7 from the other", { firstCollectorId: ann, dateStart: "2026-06-12", dateEnd: "2026-06-12", latitude: north(0.4), longitude: LON }],
      ["days that touch the end of one", { firstCollectorId: ann, dateStart: "2026-06-20", dateEnd: "2026-06-20", latitude: LAT, longitude: LON }],
      ["a day after every one ends", { firstCollectorId: ann, dateStart: "2026-07-01", dateEnd: "2026-07-02", latitude: LAT, longitude: LON }],
      ["the other collector", { firstCollectorId: bo, dateStart: "2026-06-12", dateEnd: "2026-06-12", latitude: LAT, longitude: LON }],
      ["a collector nobody has", { firstCollectorId: 999_999, dateStart: "2026-06-12", dateEnd: "2026-06-12", latitude: LAT, longitude: LON }],
      ["the base point, with the first sample left out", { firstCollectorId: ann, dateStart: "2026-06-12", dateEnd: "2026-06-12", latitude: LAT, longitude: LON }, { sampleId: two }],
    ];
    const names = (found: Array<{ sampleNumber: string }>) => found.map((l) => l.sampleNumber);
    for (const [label, facts, excluding] of cases) {
      const fromStore = names(await findLookalikes(conn, facts, excluding));
      expect(names(lookalikesAmong(candidates, facts, excluding)), label).toEqual(fromStore);
    }
    // And the answers are the ones the rule gives, not two empty lists agreeing.
    const at = async (f: LookalikeFacts) => names(await findLookalikes(conn, f));
    // N-inside is 99.9 m north of the base point and N-outside 100.1 m: only the first is within 100 m of it.
    expect(await at(cases[0]![1])).toEqual(["N-inside"]);
    expect(await at(cases[1]![1])).toEqual(["N-inside"]);
    expect(await at(cases[2]![1])).toEqual([]);
    expect(await at(cases[3]![1])).toEqual(["N-inside", "N-outside"]);
    expect(await at(cases[4]![1])).toEqual(["N-inside", "N-touching"]);
    expect(await at(cases[5]![1])).toEqual([]);
    expect(await at(cases[6]![1])).toEqual(["N-bo", "N-second"]);
  });
});

describe("series numbers read for a whole file", () => {
  it("answer as seriesNumberHolder does, for any spelling", async () => {
    const a = await sample("OBAS 00700", ann, "2026-06-10", "2026-06-20", LAT);
    await sample("obas-00700", ann, "2026-06-10", "2026-06-20", LAT);
    await sample("WBAS-00012", ann, "2026-06-10", "2026-06-20", LAT, { kind: "'net'" });
    await sample("12", ann, "2026-06-10", "2026-06-20", LAT);
    const asked = ["OBAS-00700", "OBAS00700", "OBAS-00701", "WBAS-00012", "wbas-00012", "12", "OBAS 00700"];
    const holderOf = await readSeriesHolders(conn, asked);
    for (const n of asked) expect(holderOf(n), n).toEqual(await seriesNumberHolder(conn, n));
    expect(holderOf("OBAS-00700")).toEqual({ sampleId: a, kind: "trap" });
    expect(holderOf("WBAS-00012")?.kind).toBe("net");
    expect(holderOf("OBAS-00701")).toBeNull();
    // Every holder of the program's series, for numbers not named yet.
    const all = await readSeriesHolders(conn, [], { allProgramSeries: true });
    expect(all("OBAS-00700")).toEqual({ sampleId: a, kind: "trap" });
    expect(all("OBAS-00701")).toBeNull();
  });

  it("find the trap numbers taken as numberTaken does", async () => {
    await sample("UP-1", ann, "2026-06-10", "2026-06-20", LAT);
    await sample("UP-2", ann, "2026-06-10", "2026-06-20", LAT, { kind: "'net'" });
    const taken = await readTrapNumbers(conn, ["UP-1", "UP-2", "UP-3"]);
    for (const n of ["UP-1", "UP-2", "UP-3"]) expect(taken.has(n), n).toBe(await numberTaken(conn, n, null));
    expect([...taken]).toEqual(["UP-1"]);
  });
});
