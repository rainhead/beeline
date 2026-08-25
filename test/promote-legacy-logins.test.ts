import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, FIXTURE_INPUTS, rows } from "./helpers.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";

const FIXTURE = new URL("./fixtures/legacy-logins.jsonl", import.meta.url).pathname;

/**
 * Which iNat account a legacy person is bound to (beeline-eft). A login rides
 * on a record because someone typed that record in, so the same login lands on
 * records collected by other people. The fixture is that shape: Wren files
 * three records under 'wfields', one stray row under a lookalike, and typed in
 * one of Emmy's records under their own login.
 */
let conn: DuckDBConnection;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await loadLegacyStaging(conn, FIXTURE);
  await promoteLegacy(conn, FIXTURE_INPUTS);
});

const accounts = () =>
  rows(
    conn,
    `SELECT p.display_name, a.login, a.inat_user_id
     FROM inat_account a JOIN person p ON p.entity_id = a.person_id
     ORDER BY p.display_name`,
  );

describe("binding a legacy person to an iNat account", () => {
  test("the login most of a person's records carry wins, not the rarest", async () => {
    expect(await accounts()).toContainEqual(["Wren Fields", "wfields", 111n]);
  });

  test("a lookalike login on a single stray row binds nobody", async () => {
    const seen = await accounts();
    expect(seen.map((r) => r[1])).not.toContain("wrenfields");
    expect(seen.map((r) => r[2])).not.toContain(999n);
  });

  test("sharing a login for data entry does not disqualify its owner", async () => {
    // The old rule read 'wfields' spanning two people as ambiguity and threw
    // the account away, which is how the stray won.
    expect((await accounts()).find((r) => r[0] === "Wren Fields")).toBeDefined();
  });

  test("the person who merely had a record typed in for them gets no account", async () => {
    expect((await accounts()).find((r) => r[0] === "Emmy Carlson")).toBeUndefined();
  });

  test("a tie names nobody: equal claims are a person-split to investigate", async () => {
    const seen = await accounts();
    expect(seen.map((r) => r[1])).not.toContain("shared");
    expect(seen.filter((r) => r[0] === "Robin Pike" || r[0] === "Gretchen Pike")).toEqual([]);
  });

  test("one account per person and per iNat user id", async () => {
    const [people, uids, total] = (
      await rows(
        conn,
        `SELECT count(DISTINCT person_id), count(DISTINCT inat_user_id), count(*) FROM inat_account`,
      )
    )[0]!;
    expect(people).toBe(total);
    expect(uids).toBe(total);
  });
});
