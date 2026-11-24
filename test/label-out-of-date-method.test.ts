import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import { prepareRun } from "../src/print-run.js";
import { methodText } from "../src/label-text.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

/**
 * printed_label_out_of_date compares a label with its sample in the label's
 * own terms (beeline-5rqm). A label prints the label word of the sample's
 * method, and the sample's kind only where it has no method (methodText,
 * src/label-text.ts; beeline-ni5m.15), so a change to either is only a change
 * to the label when it changes that word. The sample's method text, in
 * sample.protocol, is no longer read.
 */

const NOW = new Date("2026-09-21T16:00:00Z");

let conn: DuckDBConnection;
let sample: number;

const flagged = async () =>
  rows(conn, `SELECT field, on_label, now FROM printed_label_out_of_date WHERE sample_id = ${sample} ORDER BY field`);

/** Give the sample the method with this code, or none, as a writer does: the row of sample_method and the words as written together. */
async function setMethod(code: string | null): Promise<void> {
  await conn.run(`DELETE FROM sample_method WHERE sample_id = ${sample}`);
  if (code !== null) await conn.run(`INSERT INTO sample_method (sample_id, method_code) VALUES (${sample}, '${code}')`);
  await conn.run(`UPDATE sample SET protocol = ${code === null ? "NULL" : `'${code}'`} WHERE entity_id = ${sample}`);
}

async function prepared(overrides: Record<string, string> = {}): Promise<void> {
  const [[ada]] = (await rows(
    conn,
    `INSERT INTO person (display_name, given_name, family_name) VALUES ('Ada Ash', 'Ada', 'Ash') RETURNING entity_id`,
  )) as [[number]];
  sample = await insertCleanSample(conn, { collector_id: String(ada), specimen_count: "1", ...overrides });
  await prepareRun(conn, { atlasId: null, personId: ada, now: NOW });
}

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
});

describe("labels out of date for their method", () => {
  it("lists a label whose method is now a trap, though its dates did not change", async () => {
    await prepared();
    await setMethod("pan trap");
    expect(await flagged()).toEqual([["method", "net", "trap"]]);
  });

  it("lists a label whose method went back to a net", async () => {
    await prepared({ kind: "'trap'", protocol: "'pan traps'" });
    await setMethod("aerial net");
    expect(await flagged()).toEqual([["method", "trap", "net"]]);
  });

  it("does not list a label whose kind changed, since the method decides the word", async () => {
    await prepared();
    await conn.run(`UPDATE sample SET kind = 'trap' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([]);
  });

  it("does not list a label whose words as written changed, since only the method is read", async () => {
    await prepared();
    await conn.run(`UPDATE sample SET protocol = 'pan traps' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([]);
    await conn.run(`UPDATE sample SET protocol = NULL WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([]);
  });

  it("follows the kind where the sample has no method", async () => {
    await prepared();
    await setMethod(null);
    expect(await flagged()).toEqual([]);
    await conn.run(`UPDATE sample SET kind = 'trap' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([["method", "net", "trap"]]);
  });

  it("lists a label whose method is now a trap nest, and one whose method no longer is", async () => {
    await prepared();
    await setMethod("trap nest");
    expect(await flagged()).toEqual([["method", "net", "nest"]]);
    await setMethod("aerial net");
    expect(await flagged()).toEqual([]);
  });

  it("does not list a nest label whose kind changed, since it still says nest", async () => {
    await prepared({ protocol: "'trap nest'" });
    await conn.run(`UPDATE sample SET kind = 'trap' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([]);
  });

  it("lists a vacuum label when its method changes, and not when its kind does", async () => {
    await prepared({ protocol: "'vacuum'" });
    expect(await flagged()).toEqual([]);
    await conn.run(`UPDATE sample SET kind = 'trap' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([]);
    await setMethod("aerial net");
    expect(await flagged()).toEqual([["method", "vacuum", "net"]]);
  });

  it("prints the method's label word for a trap sample recorded as a net, and the reverse", async () => {
    await prepared({ kind: "'net'", protocol: "'vane trap'" });
    const [[label]] = (await rows(conn, `SELECT method_text FROM printed_label WHERE specimen_id = (SELECT min(entity_id) FROM specimen WHERE sample_id = ${sample})`)) as [[string]];
    expect(label).toBe("trap");
    expect(await flagged()).toEqual([]);
  });

  it("lists nothing when the method changes to another with the same label word", async () => {
    await prepared({ protocol: "'pan trap'" });
    await setMethod("vane trap");
    expect(await flagged()).toEqual([]);
    await setMethod("pan and vane traps");
    expect(await flagged()).toEqual([]);
  });

  it("prints each label word through the print run's join (a sample with no method cannot be prepared: the missing method blocks printing)", async () => {
    for (const [code, word] of [["aerial net", "net"], ["pan trap", "trap"], ["trap nest", "nest"], ["vacuum", "vacuum"]] as const) {
      ({ conn } = await createMemoryDb());
      // The kind is the opposite of what the word suggests, so only the method can give the word.
      await prepared({ kind: word === "net" || word === "vacuum" ? "'trap'" : "'net'", protocol: `'${code}'` });
      const [[label]] = (await rows(conn, `SELECT method_text FROM printed_label WHERE specimen_id = (SELECT min(entity_id) FROM specimen WHERE sample_id = ${sample})`)) as [[string]];
      expect(label, code).toBe(word);
      expect(await flagged(), code).toEqual([]);
    }
  });

  it("agrees with methodText for every method and kind, and for none", async () => {
    await prepared();
    const methods = await rows(conn, "SELECT code, label_word FROM method");
    expect(methods.length).toBeGreaterThanOrEqual(8);
    for (const kind of ["net", "trap"] as const) {
      for (const [code, labelWord] of [...methods, [null, null]] as [string | null, string | null][]) {
        await setMethod(code);
        await conn.run(`UPDATE sample SET kind = '${kind}' WHERE entity_id = ${sample}`);
        const [[label]] = (await rows(conn, `SELECT method_text FROM printed_label WHERE specimen_id = (SELECT min(entity_id) FROM specimen WHERE sample_id = ${sample})`)) as [[string]];
        const want = methodText({ kind, method_label_word: labelWord });
        const differs = label !== want;
        const [[now]] = (await rows(conn, `SELECT any_value(now) FROM printed_label_out_of_date WHERE sample_id = ${sample} AND field = 'method'`)) as [[string | null]];
        if (differs) expect(now, `${kind} / ${code}`).toBe(want);
        expect((await flagged()).some((r) => r[0] === "method"), `${kind} / ${code}`).toBe(differs);
      }
    }
  });
});
