import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import { prepareRun } from "../src/print-run.js";
import { METHOD_WORD_LIMIT, methodText } from "../src/label-text.js";
/** The trap methods the trap form once offered (it now reads them from the `method` table). */
const TRAP_METHODS = ["vane trap", "pan trap", "malaise trap", "trap nest"] as const;
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

/**
 * printed_label_out_of_date compares a label with its sample in the label's
 * own terms (beeline-5rqm). A label prints a word worked out from the sample's
 * protocol text, and from its kind only where the text is empty (methodText,
 * src/label-text.ts; beeline-lmlh), so a change to either is only a change to
 * the label when it changes that word.
 */

/**
 * Every distinct `sample.protocol` on production on 2026-11-23, with the
 * counts that made the 977 samples where kind and method disagree. They are
 * method words, not personal data.
 */
const PRODUCTION_PROTOCOLS = [
  "aerial net", "net", "trap nest", "pan traps", "vane traps", "vane trap", "vacuum", "pantrap", "pan trap",
  "blue vane trap", "yellow pan trap", "6 vane traps", "Vane trap", "white pan traps", "white bottle trap",
  "blue pan trap", "25 Pan Traps", "16 pan traps", "pan traps and vane traps", "Pan trap", "16 vane traps",
  "10 vane traps", "4 vane traps", "pan", "12 Vane Traps", "12 vane traps", "50 Pan Traps", "72 vane traps",
  "24 vane traps", "18 vane traps", "6 Vane Traps",
];

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
  it("lists a label whose method now names a trap, though its dates did not change", async () => {
    await prepared();
    await conn.run(`UPDATE sample SET protocol = 'pan traps' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([["method", "net", "trap"]]);
  });

  it("lists a label whose method went back to a net", async () => {
    await prepared({ kind: "'trap'", protocol: "'pan traps'" });
    await conn.run(`UPDATE sample SET protocol = 'aerial net' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([["method", "trap", "net"]]);
  });

  it("does not list a label whose kind changed, since the method text decides the word", async () => {
    await prepared();
    await conn.run(`UPDATE sample SET kind = 'trap' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([]);
  });

  it("follows the kind where the method is empty", async () => {
    await prepared();
    await conn.run(`UPDATE sample SET protocol = NULL WHERE entity_id = ${sample}`);
    await conn.run(`UPDATE sample SET kind = 'trap' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([["method", "net", "trap"]]);
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

  it("lists a vacuum label when its sample becomes a trap sample or its method changes, and not otherwise", async () => {
    await prepared({ protocol: "'vacuum'" });
    expect(await flagged()).toEqual([]);
    await conn.run(`UPDATE sample SET kind = 'trap' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([["method", "vacuum", "trap"]]);
    await conn.run(`UPDATE sample SET kind = 'net', protocol = 'aerial net' WHERE entity_id = ${sample}`);
    expect(await flagged()).toEqual([["method", "vacuum", "net"]]);
  });

  it("agrees with methodText for every kind and protocol the label can see", async () => {
    await prepared();
    const protocols = [
      null, "", "  ", "net", "aerial net", "vane trap", "nest", "Nest box", "NESTING", "bee hotel",
      "  Aerial NET ", " TRAP NEST ", "Net trap", "Vacuum", "sweep netting",
      ...PRODUCTION_PROTOCOLS, ...TRAP_METHODS,
      // The longest text printed as itself, and one character more, which prints the kind.
      "x".repeat(METHOD_WORD_LIMIT), "x".repeat(METHOD_WORD_LIMIT + 1), "ab cd ef gh ij", "abcdefghijk l",
      // The old limit of what fits the box and one more: both print the kind now.
      "x".repeat(12), "x".repeat(13), "abcdef", "abcdefg",
      // Whitespace that JavaScript's trim strips and SQL's trim does not: tab, line breaks, no-break space.
      "\tvacuum\n", "vacuum\u00a0", "\u00a0vacuum\r\n", "\t \n", "\u00a0", "aerial\tnet", "vacu\num",
      // Not plain ASCII: the kind, whatever the length.
      "aspiración", "ＡＢＣ", "a\u2015", "\u0130", "\u212a", "\u0130stanbul", "\u212aick", "VACUUM\u0130",
      // Unicode spaces that SQL's one-argument trim removes and the code does not: not plain ASCII, so the kind.
      "\u2003vacuum", "vacuum\u2003", "vac\u2003uum", "\u3000vacuum", "vacuum\u3000", "vac\u3000uum",
    ];
    for (const kind of ["net", "trap"] as const) {
      for (const protocol of protocols) {
        await conn.run(
          `UPDATE sample SET kind = '${kind}', protocol = ${protocol === null ? "NULL" : `'${protocol.replaceAll("'", "''")}'`} WHERE entity_id = ${sample}`,
        );
        const [[label]] = (await rows(conn, `SELECT method_text FROM printed_label WHERE specimen_id = (SELECT min(entity_id) FROM specimen WHERE sample_id = ${sample})`)) as [[string]];
        const differs = label !== methodText({ kind, protocol });
        // The view's own word, not only whether it differs from the label's.
        const [[now]] = (await rows(conn, `SELECT any_value(now) FROM printed_label_out_of_date WHERE sample_id = ${sample} AND field = 'method'`)) as [[string | null]];
        if (differs) expect(now, `${kind} / ${protocol}`).toBe(methodText({ kind, protocol }));
        expect((await flagged()).some((r) => r[0] === "method"), `${kind} / ${protocol}`).toBe(differs);
      }
    }
  });
});
