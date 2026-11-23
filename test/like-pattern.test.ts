import { sql, type RawBuilder } from "kysely";
import { describe, expect, it } from "vitest";
import { likeContains, likePrefix } from "../src/app/like-pattern.js";
import { createKysely, openMemoryDuckDb } from "../src/db.js";

/** Which of `values` the condition selects, asked of DuckDB itself through Kysely. */
async function matching(condition: RawBuilder<boolean>, values: string[]): Promise<string[]> {
  const instance = await openMemoryDuckDb();
  const db = createKysely(instance);
  try {
    const rows = sql.join(values.map((v) => sql`(${v})`));
    const found = await sql<{ v: string }>`SELECT v FROM (VALUES ${rows}) t(v) WHERE ${condition} ORDER BY v`.execute(db);
    return found.rows.map((r) => r.v);
  } finally {
    await db.destroy();
    instance.closeSync();
  }
}

const NAMES = ["Snake_plant", "snakeXplant", "50% off", "500 off", "back\\slash", "backXslash", "Plain"];

describe("likeContains and likePrefix (beeline-2k2s)", () => {
  it("matches in part and in either case", async () => {
    expect(await matching(likeContains(sql`lower(v)`, "PLAIN"), NAMES)).toEqual(["Plain"]);
    expect(await matching(likeContains(sql`lower(v)`, "ake_p"), NAMES)).toEqual(["Snake_plant"]);
  });
  it("reads _ as an underscore, not any one character", async () => {
    expect(await matching(likeContains(sql`lower(v)`, "_"), NAMES)).toEqual(["Snake_plant"]);
  });
  it("reads % as a percent sign, not anything at all", async () => {
    expect(await matching(likeContains(sql`lower(v)`, "%"), NAMES)).toEqual(["50% off"]);
    expect(await matching(likeContains(sql`lower(v)`, "0%"), NAMES)).toEqual(["50% off"]);
  });
  it("reads a backslash as a backslash", async () => {
    expect(await matching(likeContains(sql`lower(v)`, "\\"), NAMES)).toEqual(["back\\slash"]);
  });
  it("matches a prefix only at the start, with the same escaping", async () => {
    expect(await matching(likePrefix(sql`lower(v)`, "snake_"), NAMES)).toEqual(["Snake_plant"]);
    expect(await matching(likePrefix(sql`lower(v)`, "nake"), NAMES)).toEqual([]);
    expect(await matching(likePrefix(sql`lower(v)`, "_"), NAMES)).toEqual([]);
  });
});
