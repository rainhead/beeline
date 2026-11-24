import { describe, expect, it } from "vitest";
import { METHOD_WORD_LIMIT } from "../src/label-text.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

/** The wordings production held in sample.protocol on 2026-11-23, with the method and trap count each means. */
const WORDINGS: [string, string, number | null][] = [
  ["aerial net", "aerial net", null],
  ["net", "aerial net", null],
  ["vacuum", "vacuum", null],
  ["trap nest", "trap nest", null],
  ["pan trap", "pan trap", null],
  ["pan traps", "pan trap", null],
  ["pantrap", "pan trap", null],
  ["Pan trap", "pan trap", null],
  ["pan", "pan trap", null],
  ["yellow pan trap", "pan trap", null],
  ["blue pan trap", "pan trap", null],
  ["white pan traps", "pan trap", null],
  ["16 pan traps", "pan trap", 16],
  ["25 Pan Traps", "pan trap", 25],
  ["50 Pan Traps", "pan trap", 50],
  ["vane trap", "vane trap", null],
  ["vane traps", "vane trap", null],
  ["Vane trap", "vane trap", null],
  ["blue vane trap", "vane trap", null],
  ["4 vane traps", "vane trap", 4],
  ["6 vane traps", "vane trap", 6],
  ["6 Vane Traps", "vane trap", 6],
  ["10 vane traps", "vane trap", 10],
  ["12 vane traps", "vane trap", 12],
  ["12 Vane Traps", "vane trap", 12],
  ["16 vane traps", "vane trap", 16],
  ["18 vane traps", "vane trap", 18],
  ["24 vane traps", "vane trap", 24],
  ["72 vane traps", "vane trap", 72],
  ["white bottle trap", "bottle trap", null],
  ["pan traps and vane traps", "pan and vane traps", null],
];

describe("the list of methods and the wordings that mean them (schema/031)", () => {
  it("holds the eight methods, each with its label word and whether it is a trap", async () => {
    const { conn } = await createMemoryDb();
    expect(await rows(conn, `SELECT code, label_word, is_trap FROM method ORDER BY code`)).toEqual([
      ["aerial net", "net", false],
      ["bottle trap", "trap", true],
      ["malaise trap", "trap", true],
      ["pan and vane traps", "trap", true],
      ["pan trap", "trap", true],
      ["trap nest", "nest", true],
      ["vacuum", "vacuum", false],
      ["vane trap", "trap", true],
    ]);
  });

  it("refuses a label word that is empty, too long, or has a space at either end", async () => {
    const { conn } = await createMemoryDb();
    expect(METHOD_WORD_LIMIT).toBe(6);
    for (const word of ["", " ", "x".repeat(METHOD_WORD_LIMIT + 1), " x", "x ", "   "]) {
      await expect(conn.run(`INSERT INTO method (code, label_word, is_trap) VALUES ('x', '${word}', false)`), JSON.stringify(word)).rejects.toThrow();
    }
    await conn.run(`INSERT INTO method (code, label_word, is_trap) VALUES ('x', 'sixsix', false), ('y', 'a b', false)`);
  });

  it("seeds only words of printable ASCII, which the table's own check cannot say", async () => {
    const { conn } = await createMemoryDb();
    for (const [word] of await rows(conn, `SELECT label_word FROM method`)) expect(word as string).toMatch(/^[!-~]([ -~]{0,4}[!-~])?$/);
  });

  it("maps every wording production held, and each method's own code to itself", async () => {
    const { conn } = await createMemoryDb();
    const got = new Map((await rows(conn, `SELECT text, method_code, trap_count FROM method_text`)).map((r) => [r[0] as string, [r[1], r[2]]]));
    for (const [text, code, count] of WORDINGS) expect(got.get(text), text).toEqual([code, count]);
    for (const [code] of await rows(conn, `SELECT code FROM method`)) expect(got.get(code as string), code as string).toEqual([code, null]);
    // The wordings, the codes that are not also wordings (bottle trap, malaise trap, pan and vane traps): nothing more.
    expect(got.size).toBe(WORDINGS.length + 3);
  });

  it("matches on the exact text: a stray space or another capital is not a wording", async () => {
    const { conn } = await createMemoryDb();
    expect(await rows(conn, `SELECT count(*) FROM method_text WHERE text IN (' net', 'Aerial net', 'pan  trap')`)).toEqual([[0n]]);
  });

  it("gives a fixture sample a method by the same mapping, and none for a text it does not know", async () => {
    const { conn } = await createMemoryDb();
    await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector')`);
    const known = await insertCleanSample(conn, { protocol: "'6 vane traps'" });
    const unknown = await insertCleanSample(conn, { protocol: "'pitfall'" });
    expect(await rows(conn, `SELECT sample_id, method_code, trap_count FROM sample_method ORDER BY 1`)).toEqual([[known, "vane trap", 6]]);
    expect(await rows(conn, `SELECT sample_id FROM sample_without_method`)).toEqual([[unknown]]);
  });
});
