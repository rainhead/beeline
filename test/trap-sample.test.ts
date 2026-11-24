import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkTrapSample,
  createTrapSample,
  deleteTrapSample,
  loadTrapSample,
  methodCodes,
  mayEnterTrapSamples,
  nextSampleNumber,
  updateTrapSample,
  type TrapSampleForm,
} from "../src/trap-sample.js";
import { createMemoryDb, CURRENT_SEASON, insertCleanSample, rows, SETTLED_SEASON } from "./helpers.js";

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
  it("resolves collectors in order and takes the trap count", async () => {
    const checked = await checkTrapSample(conn, form());
    if (!("sample" in checked)) throw new Error(JSON.stringify(checked.problems));
    expect(checked.sample.collector_ids).toEqual([await personId("Dan O'Loughlin"), await personId("Michael O'Loughlin")]);
    expect(checked.sample.trap_count).toBe(12);
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

  it("writes a release when staff enter a sample, in any season, and not when a trapper does", async () => {
    const staff = await personId("Dan O'Loughlin");
    const settled = { date_start: `${SETTLED_SEASON}-06-01`, date_end: `${SETTLED_SEASON}-06-20` };
    const make = async (number: string, dates: Record<string, string>, by?: { personId: number }) => {
      const checked = await checkTrapSample(conn, form({ sample_number: number, ...dates }));
      if (!("sample" in checked)) throw new Error("unexpected problems");
      return (await createTrapSample(conn, checked.sample, staff, undefined, { staff: by })) as number;
    };
    const byStaff = await make("OBAS-20301", settled, { personId: staff });
    const byTrapper = await make("OBAS-20302", settled);
    // An active season's sample prints without a release, but one is written for it all
    // the same, so it still prints if it settles on 1 March before a run takes it.
    const active = await make("OBAS-20303", { date_start: `${CURRENT_SEASON}-06-01`, date_end: `${CURRENT_SEASON}-06-20` }, { personId: staff });
    expect(await rows(conn, `SELECT sample_id, action, person_id FROM sample_print_release_event ORDER BY sample_id`)).toEqual([
      [byStaff, "release", staff],
      [active, "release", staff],
    ]);
    expect(await rows(conn, `SELECT count(*) FROM sample_print_release WHERE sample_id = ${byTrapper}`)).toEqual([[0n]]);
  });

  it("releases a settled season's sample when staff change its count in an edit, and only then", async () => {
    const staff = await personId("Dan O'Loughlin");
    const settled = { date_start: `${SETTLED_SEASON}-06-01`, date_end: `${SETTLED_SEASON}-06-20` };
    const checked = await checkTrapSample(conn, form({ sample_number: "OBAS-20311", specimen_count: "4", ...settled }));
    if (!("sample" in checked)) throw new Error("unexpected problems");
    const id = (await createTrapSample(conn, checked.sample, staff)) as number;
    const edit = async (over: Record<string, string>, by?: { personId: number }) => {
      const again = await checkTrapSample(conn, form({ sample_number: "OBAS-20311", specimen_count: "4", ...settled, ...over }), id);
      if (!("sample" in again)) throw new Error("unexpected problems");
      return updateTrapSample(conn, id, again.sample, by);
    };
    const events = async () => rows(conn, `SELECT count(*) FROM sample_print_release_event WHERE sample_id = ${id}`);
    // A save that leaves the count alone releases nothing, staff or not; a trapper changing it releases nothing.
    expect(await edit({ locality: "Elsewhere" }, { personId: staff })).toBe("saved");
    expect(await edit({ specimen_count: "6" })).toBe("saved");
    expect(await events()).toEqual([[0n]]);
    // Staff changing it release the sample, once.
    expect(await edit({ specimen_count: "9" }, { personId: staff })).toBe("saved");
    expect(await events()).toEqual([[1n]]);
    expect(await edit({ specimen_count: "10" }, { personId: staff })).toBe("saved");
    expect(await events()).toEqual([[1n]]);
  });

  it("forgets that the nightly's stamp looked at a released sample when a save rewrites its place", async () => {
    const staff = await personId("Dan O'Loughlin");
    const settled = { date_start: `${SETTLED_SEASON}-06-01`, date_end: `${SETTLED_SEASON}-06-20` };
    const first = await checkTrapSample(conn, form({ sample_number: "OBAS-20321", specimen_count: "4", ...settled }));
    if (!("sample" in first)) throw new Error("unexpected problems");
    const id = (await createTrapSample(conn, first.sample, staff, undefined, { staff: { personId: staff } })) as number;
    const pending = async () => rows(conn, `SELECT sample_id FROM pending_print_sample WHERE sample_id = ${id}`);
    // The nightly looked at it at its present point after the release: it is pending.
    await conn.run(`INSERT INTO sample_place_stamped (sample_id, latitude, longitude, stamped_at)
                    SELECT sample_id, latitude, longitude, current_timestamp + INTERVAL 1 MINUTE FROM sample_location WHERE sample_id = ${id}`);
    expect(await pending()).toEqual([[id]]);
    // Retyping the county leaves the point where it was, so the stamp's record would still match it.
    const again = await checkTrapSample(conn, form({ sample_number: "OBAS-20321", specimen_count: "4", county: "Harney", ...settled }), id);
    if (!("sample" in again)) throw new Error("unexpected problems");
    expect(await updateTrapSample(conn, id, again.sample)).toBe("saved");
    expect(await rows(conn, `SELECT count(*) FROM sample_place_stamped WHERE sample_id = ${id}`)).toEqual([[0n]]);
    expect(await pending()).toEqual([]);
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

  it("is not a trap sample form for an imported sample", async () => {
    const id = await insertCleanSample(conn, { kind: "'trap'" });
    expect(await loadTrapSample(conn, id)).toBeNull();
  });
});

describe("who may enter trap samples", () => {
  it("is staff, and anyone who has collected a sample whose method is a trap", async () => {
    const trapper = await personId("Dan O'Loughlin");
    const netter = await personId("Net Only");
    await insertCleanSample(conn, { kind: "'trap'", protocol: "'vane trap'", collector_id: String(trapper) });
    await insertCleanSample(conn, { kind: "'net'", collector_id: String(netter), sample_number: "'2'" });
    expect(await mayEnterTrapSamples(conn, trapper, false)).toBe(true);
    expect(await mayEnterTrapSamples(conn, netter, false)).toBe(false);
    expect(await mayEnterTrapSamples(conn, netter, true)).toBe(true);
    expect(await mayEnterTrapSamples(conn, null, false)).toBe(false);
  });

  it("reads the method, not kind: a netted sample stored as a trap gives nothing, a trap nest stored as a net does", async () => {
    const netter = await personId("Net Only");
    const nester = await personId("Michael O'Loughlin");
    await insertCleanSample(conn, { kind: "'trap'", protocol: "'aerial net'", collector_id: String(netter) });
    await insertCleanSample(conn, { kind: "'net'", protocol: "'trap nest'", collector_id: String(nester), sample_number: "'2'" });
    expect(await mayEnterTrapSamples(conn, netter, false)).toBe(false);
    expect(await mayEnterTrapSamples(conn, nester, false)).toBe(true);
  });

  it("is anyone who leads a program, whatever they have collected", async () => {
    const lead = await personId("Net Only");
    await conn.run(`INSERT INTO program_lead (program_id, person_id) SELECT entity_id, ${lead} FROM program WHERE code = 'WaBA'`);
    expect(await mayEnterTrapSamples(conn, lead, false)).toBe(true);
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

describe("the method of an entered sample (beeline-ni5m.15)", () => {
  const made = async (over: Partial<TrapSampleForm> = {}) => {
    const checked = await checkTrapSample(conn, form(over));
    if (!("sample" in checked)) throw new Error(JSON.stringify(checked.problems));
    return (await createTrapSample(conn, checked.sample, null)) as number;
  };
  const methodOf = async (id: number) =>
    (await rows(conn, `SELECT s.protocol, m.method_code, m.trap_count FROM sample s LEFT JOIN sample_method m ON m.sample_id = s.entity_id WHERE s.entity_id = ${id}`))[0];
  const mismatches = async () => (await rows(conn, `SELECT count(*) FROM sample_method_out_of_step`))[0]![0];

  it("offers the methods that are traps, read from the table", async () => {
    expect(await methodCodes(conn, { trapOnly: true })).toEqual(["bottle trap", "malaise trap", "pan and vane traps", "pan trap", "trap nest", "vane trap"]);
    expect(await methodCodes(conn)).toEqual(["aerial net", "bottle trap", "malaise trap", "pan and vane traps", "pan trap", "trap nest", "vacuum", "vane trap"]);
  });

  it("writes the code as the method as written, and the method and the count beside it", async () => {
    const id = await made();
    expect(await methodOf(id)).toEqual(["vane trap", "vane trap", 12]);
    expect(await mismatches()).toBe(0n);
  });

  it("writes no count when none is given", async () => {
    expect(await methodOf(await made({ trap_count: "", method: "malaise trap" }))).toEqual(["malaise trap", "malaise trap", null]);
  });

  it("refuses a method that is not listed, naming the methods that are", async () => {
    for (const method of ["six vane traps", "Vane trap", "aerial net"]) {
      const checked = await checkTrapSample(conn, form({ method }));
      if (!("problems" in checked)) throw new Error(`expected a refusal of "${method}"`);
      expect(Object.keys(checked.problems)).toEqual(["method"]);
      expect(checked.problems.method).toContain("bottle trap, malaise trap, pan and vane traps, pan trap, trap nest, vane trap");
    }
    for (const method of ["", "  "]) expect(await checkTrapSample(conn, form({ method }))).toEqual({ problems: { method: "Say what kind of trap." } });
    expect(await checkTrapSample(conn, form({ method: "unlisted" }))).toEqual({
      problems: { method: "Choose one of the listed methods: bottle trap, malaise trap, pan and vane traps, pan trap, trap nest, vane trap." },
    });
  });

  it("follows an edit of the method and the count, and keeps the two in step", async () => {
    const id = await made();
    const edited = await checkTrapSample(conn, form({ method: "pan trap", trap_count: "" }), id);
    if (!("sample" in edited)) throw new Error("unexpected problems");
    expect(await updateTrapSample(conn, id, edited.sample)).toBe("saved");
    expect(await methodOf(id)).toEqual(["pan trap", "pan trap", null]);
    expect(await rows(conn, `SELECT sampling_effort FROM sample WHERE entity_id = ${id}`)).toEqual([[null]]);
    expect(await mismatches()).toBe(0n);
    expect(await rows(conn, `SELECT count(*) FROM sample_method WHERE sample_id = ${id}`)).toEqual([[1n]]);
  });

  it("shows the method as the list has it when the form is opened on a sample with an old wording", async () => {
    const id = await made();
    await conn.run(`UPDATE sample SET protocol = 'Vane trap' WHERE entity_id = ${id}`);
    expect(await loadTrapSample(conn, id)).toMatchObject({ method: "vane trap" });
  });

  it("loads the stored count for a sample whose words state one and whose effort column is empty, and keeps it through an unrelated edit", async () => {
    const id = await insertCleanSample(conn, { kind: "'trap'", protocol: "'6 vane traps'", sample_number: "'OBAS-20400'" });
    await conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${id})`);
    // The effort column is never read: emptied, the form still shows the count the sample holds.
    await conn.run(`UPDATE sample SET sampling_effort = NULL WHERE entity_id = ${id}`);
    expect(await loadTrapSample(conn, id)).toMatchObject({ method: "vane trap", trap_count: "6" });
    const checked = await checkTrapSample(conn, form({ sample_number: "OBAS-20400", method: "vane trap", trap_count: "6", locality: "Elsewhere" }), id);
    if (!("sample" in checked)) throw new Error(JSON.stringify(checked.problems));
    expect(await updateTrapSample(conn, id, checked.sample)).toBe("saved");
    expect(await methodOf(id)).toEqual(["vane trap", "vane trap", 6]);
    expect(await rows(conn, `SELECT sampling_effort FROM sample WHERE entity_id = ${id}`)).toEqual([["6 vane traps"]]);
    expect(await mismatches()).toBe(0n);
  });

  it("never gives a count to a method that is not a trap, however the form is filled", async () => {
    const id = await made();
    const edited = await checkTrapSample(conn, form({ method: "malaise trap", trap_count: "3" }), id);
    if (!("sample" in edited)) throw new Error("unexpected problems");
    // A hand-made request cannot name a method that is not a trap; the row writer would drop the count if one were let through.
    const { setSampleMethodRow } = await import("../src/sample-method-row.js");
    await setSampleMethodRow(conn, id, "aerial net", 3);
    expect(await rows(conn, `SELECT method_code, trap_count FROM sample_method WHERE sample_id = ${id}`)).toEqual([["aerial net", null]]);
  });

  it("is deleted with the sample", async () => {
    const id = await made();
    const staff = await personId("Dan O'Loughlin");
    expect(await deleteTrapSample(conn, id, staff)).toEqual({ deleted: "OBAS-20300" });
    expect(await rows(conn, `SELECT count(*) FROM sample_method`)).toEqual([[0n]]);
  });
});
