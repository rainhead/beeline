import { describe, expect, it } from "vitest";
import { checkSampleMethods } from "../src/check-sample-methods.js";
import { createKysely } from "../src/db.js";
import type { SampleMethodOutOfStepView, SampleWithoutMethodView, SampleKindMethodMismatchView, MethodTable, SampleMethodTable, MethodTextTable } from "../src/model.js";
import { setSampleMethodRow, trapEffort } from "../src/sample-method-row.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

/**
 * The one writer of a sample's method row, trap count and old effort column (beeline-ni5m.15), and the view that asserts
 * its work: each clause of `sample_method_out_of_step` fails on a deliberately broken row, and the nightly's check names it.
 */

async function store(protocol = "'vane trap'") {
  const made = await createMemoryDb();
  await made.conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector')`);
  const id = await insertCleanSample(made.conn, { kind: "'trap'", protocol, sampling_effort: "'6 vane traps'" });
  return { ...made, id };
}
const outOfStep = async (conn: Awaited<ReturnType<typeof store>>["conn"]) => rows(conn, `SELECT clause FROM sample_method_out_of_step ORDER BY 1`);
const held = async (conn: Awaited<ReturnType<typeof store>>["conn"], id: number) =>
  rows(conn, `SELECT m.method_code, m.trap_count, s.sampling_effort FROM sample s LEFT JOIN sample_method m ON m.sample_id = s.entity_id WHERE s.entity_id = ${id}`);

describe("setSampleMethodRow", () => {
  it("writes the count, and the old effort column from it, in the form the view expects, for every method and some counts", async () => {
    const { conn, id } = await store();
    for (const [code] of await rows(conn, `SELECT code FROM method ORDER BY code`)) {
      await conn.run(`UPDATE sample SET protocol = '${code}' WHERE entity_id = ${id}`);
      for (const count of [null, 1, 2, 6, 72]) {
        await setSampleMethodRow(conn, id, code as string, count);
        const trap = (await rows(conn, `SELECT is_trap FROM method WHERE code = '${code}'`))[0]![0] as boolean;
        const kept = trap ? count : null;
        expect(await held(conn, id), `${code} ${count}`).toEqual([[code, kept, kept === null ? null : trapEffort(kept, code as string)]]);
        expect(await outOfStep(conn), `${code} ${count}`).toEqual([]);
      }
    }
  });

  it("makes the method's row where the sample has none, and drops a count the method cannot hold", async () => {
    const { conn, id } = await store();
    await conn.run(`DELETE FROM sample_method WHERE sample_id = ${id}`);
    await setSampleMethodRow(conn, id, "aerial net", 4);
    expect(await held(conn, id)).toEqual([["aerial net", null, null]]);
  });
});

describe("the view that asserts it", () => {
  it("is empty for a store the writers made, and each clause fails on a deliberately broken row", async () => {
    const { conn, id } = await store();
    expect(await outOfStep(conn)).toEqual([]);
    // method: the stored method is not the one the words give, and a row on an unlisted text or none on a listed one.
    await conn.run(`UPDATE sample_method SET method_code = 'pan trap' WHERE sample_id = ${id}`);
    expect(await outOfStep(conn)).toEqual([["method"]]);
    await conn.run(`UPDATE sample_method SET method_code = 'vane trap' WHERE sample_id = ${id}`);
    await conn.run(`UPDATE sample SET protocol = 'ground pitfall' WHERE entity_id = ${id}`);
    expect(await outOfStep(conn)).toEqual([["method"]]);
    await conn.run(`DELETE FROM sample_method WHERE sample_id = ${id}`);
    expect(await outOfStep(conn)).toEqual([["effort"]]);
    await conn.run(`UPDATE sample SET protocol = 'vane trap' WHERE entity_id = ${id}`);
    expect(await outOfStep(conn)).toEqual([["method"]]);
    // count: a trap count on a method that is not a trap.
    await conn.run(`INSERT INTO sample_method VALUES (${id}, 'aerial net', 3)`);
    await conn.run(`UPDATE sample SET protocol = 'aerial net', sampling_effort = '3 aerial nets' WHERE entity_id = ${id}`);
    expect(await outOfStep(conn)).toEqual([["count"]]);
    await conn.run(`UPDATE sample_method SET trap_count = NULL WHERE sample_id = ${id}`);
    expect(await outOfStep(conn)).toEqual([["effort"]]);
    await conn.run(`UPDATE sample SET sampling_effort = NULL WHERE entity_id = ${id}`);
    expect(await outOfStep(conn)).toEqual([]);
    // effort: the old column is not what the one writer would write for the stored count.
    await setSampleMethodRow(conn, id, "vane trap", 6);
    await conn.run(`UPDATE sample SET protocol = 'vane trap', sampling_effort = '7 vane traps' WHERE entity_id = ${id}`);
    expect(await outOfStep(conn)).toEqual([["effort"]]);
    await conn.run(`UPDATE sample SET sampling_effort = NULL WHERE entity_id = ${id}`);
    expect(await outOfStep(conn)).toEqual([["effort"]]);
  });

  it("is what the nightly's check fails on, naming how many by clause and never which sample", async () => {
    const { conn, id } = await store();
    await checkSampleMethods(conn);
    await conn.run(`UPDATE sample_method SET method_code = 'pan trap' WHERE sample_id = ${id}`);
    await expect(checkSampleMethods(conn)).rejects.toThrow("1 sample(s) have a method, trap count or effort out of step with what they say (method: 1)");
    await conn.run(`UPDATE sample_method SET method_code = 'vane trap' WHERE sample_id = ${id}`);
    await conn.run(`UPDATE sample SET sampling_effort = '9 vane traps' WHERE entity_id = ${id}`);
    await expect(checkSampleMethods(conn)).rejects.toThrow("(effort: 1)");
    await conn.run(`UPDATE sample SET sampling_effort = NULL WHERE entity_id = ${id}`);
    await conn.run(`UPDATE sample SET protocol = 'aerial net' WHERE entity_id = ${id}`);
    await conn.run(`UPDATE sample_method SET method_code = 'aerial net', trap_count = 2 WHERE sample_id = ${id}`);
    await expect(checkSampleMethods(conn)).rejects.toThrow("(count: 1)");
  });
});

describe("what Kysely selects of the new tables and views", () => {
  it("is every column of each, with the types the interfaces say", async () => {
    const { instance, conn, id } = await store();
    const db = createKysely(instance);
    // A row in each view: no method, a kind that disagrees with the method, and each way of being out of step.
    const other = await insertCleanSample(conn, { sample_number: "'2'", protocol: "'ground pitfall'" });
    await conn.run(`UPDATE sample_method SET method_code = 'pan trap' WHERE sample_id = ${id}`);
    await conn.run(`UPDATE sample SET kind = 'net' WHERE entity_id = ${id}`);
    const method: MethodTable[] = await db.selectFrom("method").selectAll().execute();
    const sampleMethod: SampleMethodTable[] = await db.selectFrom("sample_method").selectAll().execute();
    const text: MethodTextTable[] = await db.selectFrom("method_text").selectAll().execute();
    const without: SampleWithoutMethodView[] = await db.selectFrom("sample_without_method").selectAll().execute();
    const step: SampleMethodOutOfStepView[] = await db.selectFrom("sample_method_out_of_step").selectAll().execute();
    const kind: SampleKindMethodMismatchView[] = await db.selectFrom("sample_kind_method_mismatch").selectAll().execute();
    const keys = (r: object[]) => Object.keys(r[0]!).sort();
    expect(keys(method)).toEqual(["code", "is_trap", "label_word"]);
    expect(keys(sampleMethod)).toEqual(["method_code", "sample_id", "trap_count"]);
    expect(keys(text)).toEqual(["method_code", "text", "trap_count"]);
    expect(without.map((r) => r.sample_id)).toEqual([other]);
    expect(keys(without)).toEqual(["protocol", "sample_id", "sample_number"]);
    expect(step).toEqual([
      { sample_id: id, protocol: "vane trap", sampling_effort: "6 vane traps", stored_method_code: "pan trap", text_method_code: "vane trap", stored_trap_count: 6, expected_effort: "6 pan traps", clause: "method" },
    ]);
    expect(keys(step)).toEqual(["clause", "expected_effort", "protocol", "sample_id", "sampling_effort", "stored_method_code", "stored_trap_count", "text_method_code"]);
    expect(kind.map((r) => [r.sample_id, r.kind, r.method_code, r.is_trap])).toEqual([[id, "net", "pan trap", true]]);
    expect(keys(kind)).toEqual(["is_trap", "kind", "method_code", "sample_id"]);
    // The columns the LEFT joins can leave empty are read as null, not absent: a sample with no method and unlisted words.
    const bare = (await db.selectFrom("sample_method_out_of_step").selectAll().where("sample_id", "=", other).execute());
    expect(bare).toEqual([]);
    await conn.run(`UPDATE sample SET sampling_effort = '5 vane traps' WHERE entity_id = ${other}`);
    const loose: SampleMethodOutOfStepView = (await db.selectFrom("sample_method_out_of_step").selectAll().where("sample_id", "=", other).executeTakeFirstOrThrow());
    expect(loose).toEqual({ sample_id: other, protocol: "ground pitfall", sampling_effort: "5 vane traps", stored_method_code: null, text_method_code: null, stored_trap_count: null, expected_effort: null, clause: "effort" });
  });
});
