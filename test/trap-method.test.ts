import { describe, expect, test } from "vitest";
import { methodNamesTrapSql, nearTrapSql, plantRelationship } from "../src/trap-method.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

describe("a sample near a trap is one whose method is a trap (beeline-ni5m.15)", () => {
  test("the relationship names a plant near a trap, or a flower visited", () => {
    expect(plantRelationship(true)).toBe("near");
    expect(plantRelationship(false)).toBe("visits flowers of");
  });

  // Method as written, the kind recorded, and whether the plant is near a trap. Kind and method disagree on some.
  const cases: [string | null, "net" | "trap", boolean][] = [
    ["pan traps", "trap", true],
    ["pan traps", "net", true],
    ["6 Vane Traps", "net", true],
    ["trap nest", "net", true],
    ["white bottle trap", "trap", true],
    ["aerial net", "trap", false],
    ["net", "net", false],
    ["vacuum", "net", false],
    // No method at all: not near a trap, whatever the kind says.
    [null, "trap", false],
  ];

  test.each(cases)("%j recorded as %s: near a trap is %s", async (protocol, kind, expected) => {
    const { conn } = await createMemoryDb();
    await conn.run(`INSERT INTO person (display_name, given_name, family_name) VALUES ('Ada Ash', 'Ada', 'Ash')`);
    const id = await insertCleanSample(conn, { kind: `'${kind}'`, protocol: protocol === null ? "NULL" : `'${protocol}'` });
    const [[near]] = (await rows(conn, `SELECT ${nearTrapSql(String(id))}`)) as [[boolean]];
    expect(near).toBe(expected);
  });
});

describe("the legacy export still reads the old row's own text", () => {
  test("methodNamesTrapSql matches the word trap in any case, and nothing for empty or missing", async () => {
    const { conn } = await createMemoryDb();
    const texts: [string | null, boolean][] = [["pan traps", true], ["Pan trap", true], ["trap nest", true], ["aerial net", false], ["", false], [null, false]];
    for (const [text, expected] of texts) {
      const [[v]] = (await rows(conn, `SELECT ${methodNamesTrapSql(text === null ? "CAST(NULL AS TEXT)" : `'${text}'`)}`)) as [[boolean]];
      expect(v, String(text)).toBe(expected);
    }
  });
});
