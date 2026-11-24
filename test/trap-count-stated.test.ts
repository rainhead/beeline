import { describe, expect, it } from "vitest";
import { trapCountOf, trapEffort } from "../src/trap-sample.js";
import { createMemoryDb, rows } from "./helpers.js";

/**
 * The trap count an effort states is parsed in two places that must agree: the macro `trap_count_stated` (schema/031),
 * which the view, the migration and the fixture read, and `trapCountOf`, which the forms read. The texts include what
 * `trapEffort` writes and what it does not (beeline-ni5m.15).
 */
const TEXTS: (string | null)[] = [
  trapEffort(6, "vane trap"), trapEffort(1, "vane trap"), trapEffort(16, "pan trap"), trapEffort(3, "trap nest"),
  trapEffort(12, "pan and vane traps"), trapEffort(999999, "bottle trap"), trapEffort(2, "malaise trap"),
  "6 Vane Traps", "10 PAN TRAPS", "8 6 vane traps",
  "45 minutes", "20 min of netting", "6", "6 ", " 6 vane traps", "06 vane traps", "0 vane traps", "1234567 vane traps",
  "six vane traps", "6 vane traps and a net", "6\nvane traps", "", null, "vane traps", "7 aerial nets",
];

describe("the trap count an effort states", () => {
  it("is read the same by the macro and by trapCountOf", async () => {
    const { conn } = await createMemoryDb();
    for (const text of TEXTS) {
      const literal = text === null ? "NULL" : `'${text.replaceAll("'", "''").replaceAll("\n", "' || chr(10) || '")}'`;
      const [[sql]] = (await rows(conn, `SELECT trap_count_stated(${literal})`)) as [[number | null]];
      expect(trapCountOf(text), JSON.stringify(text)).toBe(sql);
    }
  });

  it("reads what trapEffort writes back, and no other leading number", () => {
    expect(trapCountOf(trapEffort(6, "vane trap"))).toBe(6);
    expect(trapCountOf(trapEffort(1, "trap nest"))).toBe(1);
    expect(trapCountOf("45 minutes")).toBeNull();
    expect(trapCountOf("6 vane traps and a net")).toBeNull();
  });
});
