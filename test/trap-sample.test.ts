import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkTrapSample,
  createTrapSample,
  loadTrapSample,
  mayEnterTrapSamples,
  nextSampleNumber,
  updateTrapSample,
  type TrapSampleForm,
} from "../src/trap-sample.js";
import { createMemoryDb, CURRENT_SEASON, insertCleanSample, rows } from "./helpers.js";

let conn: DuckDBConnection;

// The collectors and the sample are synthetic, shaped after Lincoln Best's
// registry: OBAS-20205, 12 vane traps at Fields-Denio N, 16 June to 12 July.
const form = (over: Partial<TrapSampleForm> = {}): TrapSampleForm => ({
  sample_number: "OBAS-20300",
  collectors: ["Dan O'Loughlin", "Michael O'Loughlin"],
  date_start: `${CURRENT_SEASON}-06-16`,
  date_end: `${CURRENT_SEASON}-07-12`,
  method: "vane trap",
  trap_count: "12",
  specimen_count: "",
  latitude: "42.005",
  longitude: "-118.592",
  uncertainty: "5",
  country: "USA",
  state_province: "or",
  county: "Malheur",
  locality: "Fields-Denio N",
  ...over,
});

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run(`INSERT INTO person (display_name) VALUES ('Dan O''Loughlin'), ('Michael O''Loughlin'), ('Net Only')`);
});

const personId = async (name: string) =>
  ((await rows(conn, `SELECT entity_id FROM person WHERE display_name = '${name.replaceAll("'", "''")}'`))[0]![0] as number);

describe("checking a trap sample", () => {
  it("resolves collectors in order and writes effort from the trap count", async () => {
    const checked = await checkTrapSample(conn, form());
    if (!("sample" in checked)) throw new Error(JSON.stringify(checked.problems));
    expect(checked.sample.collector_ids).toEqual([await personId("Dan O'Loughlin"), await personId("Michael O'Loughlin")]);
    expect(checked.sample.sampling_effort).toBe("12 vane traps");
    expect(checked.sample.specimen_count).toBe(0);
    expect(checked.sample.state_province).toBe("OR");
  });

  it("matches a name however it is typed", async () => {
    const checked = await checkTrapSample(conn, form({ collectors: ["dan oloughlin", ""] }));
    expect("sample" in checked).toBe(true);
  });

  it("names each field that is wrong", async () => {
    const checked = await checkTrapSample(
      conn,
      form({ collectors: ["Nobody Known"], date_end: `${CURRENT_SEASON}-06-01`, latitude: "", trap_count: "two" }),
    );
    if (!("problems" in checked)) throw new Error("expected problems");
    expect(Object.keys(checked.problems).sort()).toEqual(["collectors", "date_end", "latitude", "trap_count"]);
    expect(checked.problems.collectors).toContain("Nobody Known");
  });

  it("refuses a number another trap sample has, but not one a net sample has", async () => {
    await insertCleanSample(conn, { sample_number: "'3'", kind: "'net'" });
    expect("sample" in (await checkTrapSample(conn, form({ sample_number: "3" })))).toBe(true);
  });

  it("refuses a number already in Beeline, but not the sample's own", async () => {
    const id = await insertCleanSample(conn, { sample_number: "'OBAS-20300'", kind: "'trap'" });
    const clash = await checkTrapSample(conn, form());
    expect("problems" in clash && clash.problems.sample_number).toContain("already");
    expect("sample" in (await checkTrapSample(conn, form(), id))).toBe(true);
  });
});

describe("entering and editing", () => {
  it("writes the sample, its collectors, its point and its atlas, and marks it entered", async () => {
    const checked = await checkTrapSample(conn, form());
    if (!("sample" in checked)) throw new Error("unexpected problems");
    const id = (await createTrapSample(conn, checked.sample, await personId("Dan O'Loughlin"))) as number;
    expect(await rows(conn, `SELECT kind, sample_number, protocol, sampling_effort, specimen_count FROM sample WHERE entity_id = ${id}`)).toEqual([
      ["trap", "OBAS-20300", "vane trap", "12 vane traps", 0],
    ]);
    expect(await rows(conn, `SELECT source FROM sample_location WHERE sample_id = ${id}`)).toEqual([["staff_entry"]]);
    expect(await rows(conn, `SELECT a.code FROM sample_atlas sa JOIN program a ON a.entity_id = sa.atlas_id WHERE sa.sample_id = ${id}`)).toEqual([["OBA"]]);
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM sample_entry WHERE sample_id = ${id}`)).toEqual([[1]]);
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM sample_primary_collector_invalid`)).toEqual([[0]]);
  });

  it("refuses the second of two saves that were both checked before either was written", async () => {
    const [a, b] = [await checkTrapSample(conn, form()), await checkTrapSample(conn, form())];
    if (!("sample" in a) || !("sample" in b)) throw new Error("unexpected problems");
    const [first, second] = await Promise.all([createTrapSample(conn, a.sample, null), createTrapSample(conn, b.sample, null)]);
    expect(typeof first).toBe("number");
    expect(second).toBe("taken");
    expect(await rows(conn, `SELECT count(*)::INTEGER FROM sample WHERE sample_number = 'OBAS-20300'`)).toEqual([[1]]);
  });

  it("edits it from the same form, collectors and point included", async () => {
    const first = await checkTrapSample(conn, form());
    if (!("sample" in first)) throw new Error("unexpected problems");
    const id = (await createTrapSample(conn, first.sample, null)) as number;
    const second = await checkTrapSample(
      conn,
      form({ collectors: ["Michael O'Loughlin"], specimen_count: "40", latitude: "42.1", state_province: "WA" }),
      id,
    );
    if (!("sample" in second)) throw new Error(JSON.stringify(second.problems));
    expect(await updateTrapSample(conn, id, second.sample)).toBe("saved");
    const loaded = await loadTrapSample(conn, id);
    expect(loaded).toMatchObject({ collectors: ["Michael O'Loughlin"], specimen_count: "40", latitude: "42.1", trap_count: "12", editable: true });
    expect(await rows(conn, `SELECT a.code FROM sample_atlas sa JOIN program a ON a.entity_id = sa.atlas_id WHERE sa.sample_id = ${id}`)).toEqual([["WaBA"]]);
  });

  it("keeps an effort the form has no single count for when the sample is edited", async () => {
    const first = await checkTrapSample(conn, form({ method: "vane and pan traps", trap_count: "" }));
    if (!("sample" in first)) throw new Error("unexpected problems");
    // As the spreadsheet import writes a sample that mixes kinds of trap.
    const id = (await createTrapSample(conn, { ...first.sample, sampling_effort: "42 pan traps, 14 vane traps" }, null)) as number;
    const loaded = await loadTrapSample(conn, id);
    expect(loaded?.trap_count).toBe("");
    const again = await checkTrapSample(conn, { ...loaded!, specimen_count: "12" }, id);
    if (!("sample" in again)) throw new Error(JSON.stringify(again.problems));
    expect(await updateTrapSample(conn, id, again.sample)).toBe("saved");
    expect(await rows(conn, `SELECT sampling_effort, specimen_count FROM sample WHERE entity_id = ${id}`)).toEqual([["42 pan traps, 14 vane traps", 12]]);
  });

  it("clears a count the form showed when it is blanked", async () => {
    const first = await checkTrapSample(conn, form());
    if (!("sample" in first)) throw new Error("unexpected problems");
    const id = (await createTrapSample(conn, first.sample, null)) as number;
    const again = await checkTrapSample(conn, { ...(await loadTrapSample(conn, id))!, trap_count: "" }, id);
    if (!("sample" in again)) throw new Error(JSON.stringify(again.problems));
    await updateTrapSample(conn, id, again.sample);
    expect(await rows(conn, `SELECT sampling_effort FROM sample WHERE entity_id = ${id}`)).toEqual([[null]]);
  });

  it("is not a trap sample form for an imported sample", async () => {
    const id = await insertCleanSample(conn, { kind: "'trap'" });
    expect(await loadTrapSample(conn, id)).toBeNull();
  });
});

describe("who may enter trap samples", () => {
  it("is staff, and anyone who has collected a trap sample", async () => {
    const trapper = await personId("Dan O'Loughlin");
    const netter = await personId("Net Only");
    await insertCleanSample(conn, { kind: "'trap'", collector_id: String(trapper) });
    await insertCleanSample(conn, { kind: "'net'", collector_id: String(netter), sample_number: "'2'" });
    expect(await mayEnterTrapSamples(conn, trapper, false)).toBe(true);
    expect(await mayEnterTrapSamples(conn, netter, false)).toBe(false);
    expect(await mayEnterTrapSamples(conn, netter, true)).toBe(true);
    expect(await mayEnterTrapSamples(conn, null, false)).toBe(false);
  });
});

describe("the next sample number", () => {
  it("counts on from the highest in the series, zero-padded", async () => {
    expect(await nextSampleNumber(conn)).toBe("OBAS-00001");
    await insertCleanSample(conn, { kind: "'trap'", sample_number: "'OBAS-00657'" });
    await insertCleanSample(conn, { kind: "'trap'", sample_number: "'OBAS-20204'" });
    await insertCleanSample(conn, { kind: "'trap'", sample_number: "'OBAS-1204'" });
    expect(await nextSampleNumber(conn)).toBe("OBAS-20205");
  });
});
