import { afterEach, describe, expect, it } from "vitest";
import { createKysely, openMemoryDuckDb } from "../src/db.js";

/**
 * A TIMESTAMP in the store means UTC in every process (src/db.ts). CI runs in
 * UTC, where storing and reading local time cannot be told apart from storing
 * and reading UTC, so this test moves Node to Pacific time for its duration —
 * a workstation's zone, and the one beeline-j0aj was found in.
 */
describe("the store's time zone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it("is UTC whatever zone the process is in, so SQL's clock and JavaScript's instants agree", async () => {
    process.env.TZ = "America/Los_Angeles";
    // Not vacuous: Node honours the change, so a reader that used local time would now be off.
    expect(new Date(2025, 4, 1, 12).toISOString()).toBe("2025-05-01T19:00:00.000Z");

    const instance = await openMemoryDuckDb();
    const conn = await instance.connect();
    expect((await (await conn.run("SELECT current_setting('TimeZone')")).getRows())[0]![0]).toBe("UTC");

    await conn.run("CREATE TABLE t (k TEXT, ts TIMESTAMP)");
    const now = new Date();
    await conn.run("INSERT INTO t VALUES ('literal', TIMESTAMP '2025-05-01 12:00:00'), ('clock', current_timestamp)");
    await conn.run("INSERT INTO t VALUES ('javascript', $1)", [now.toISOString()]);

    const db = createKysely(instance);
    const read = Object.fromEntries(
      (await db.selectFrom("t" as never).selectAll().execute()).map((r) => {
        const row = r as { k: string; ts: Date };
        return [row.k, row.ts];
      }),
    );
    expect(read.literal).toEqual(new Date("2025-05-01T12:00:00Z"));
    expect(read.javascript).toEqual(now);
    expect(Math.abs(read.clock!.getTime() - now.getTime())).toBeLessThan(60_000);
    await db.destroy();
  });
});
