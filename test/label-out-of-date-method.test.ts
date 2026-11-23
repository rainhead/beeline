import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import { prepareRun } from "../src/print-run.js";
import { methodText } from "../src/label-text.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

/**
 * printed_label_out_of_date compares a label with its sample in the label's
 * own terms (beeline-5rqm). A label prints `net`, `trap` or `nest`, worked
 * out from the sample's kind and protocol (methodText, src/label-text.ts), so
 * a change to either is only a change to the label when it changes that word.
 */

const NOW = new Date("2026-09-21T16:00:00Z");

let conn: DuckDBConnection;
let sample: number;

const flagged = async () =>
  rows(conn, `SELECT field, on_label, now FROM printed_label_out_of_date WHERE sample_id = ${sample} ORDER BY field`);

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
  it("lists a label whose sample became a trap sample, though its dates did not change", async () => {
    await prepared();
    await conn.run(`UPDATE sample SET kind = 'trap' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([["method", "net", "trap"]]);
  });

  it("lists a label whose sample went back to a net sample", async () => {
    await prepared({ kind: "'trap'", protocol: "'pan traps'" });
    await conn.run(`UPDATE sample SET kind = 'net' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([["method", "trap", "net"]]);
  });

  it("lists a label whose protocol now says nest, in any case", async () => {
    await prepared();
    await conn.run(`UPDATE sample SET protocol = 'Ground NEST survey' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([["method", "net", "nest"]]);
  });

  it("lists a label whose protocol no longer says nest", async () => {
    await prepared({ protocol: "'ground nest'" });
    await conn.run(`UPDATE sample SET protocol = 'aerial net' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([["method", "nest", "net"]]);
  });

  it("does not list a label whose method word is unchanged", async () => {
    await prepared();
    await conn.run(`UPDATE sample SET protocol = 'aerial net' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([]);
    await conn.run(`UPDATE sample SET protocol = NULL WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([]);
  });

  it("does not list a nest label whose kind changed, since it still says nest", async () => {
    await prepared({ protocol: "'ground nest'" });
    await conn.run(`UPDATE sample SET kind = 'trap' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([]);
  });

  it("agrees with methodText for every kind and protocol the label can see", async () => {
    await prepared();
    const protocols = [null, "net", "aerial net", "vane trap", "nest", "Nest box", "NESTING", "bee hotel"];
    for (const kind of ["net", "trap"] as const) {
      for (const protocol of protocols) {
        await conn.run(
          `UPDATE sample SET kind = '${kind}', protocol = ${protocol === null ? "NULL" : `'${protocol}'`} WHERE entity_id = ${sample}`,
        );
        const [[label]] = (await rows(conn, `SELECT method_text FROM printed_label WHERE specimen_id = (SELECT min(entity_id) FROM specimen WHERE sample_id = ${sample})`)) as [[string]];
        const differs = label !== methodText({ kind, protocol });
        expect((await flagged()).some((r) => r[0] === "method"), `${kind} / ${protocol}`).toBe(differs);
      }
    }
  });
});
