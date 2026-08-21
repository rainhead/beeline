import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, rows } from "./helpers.js";
import { backfillInatAccounts } from "../src/backfill-inat-accounts.js";

let conn: DuckDBConnection;

/** Minimal shadows of the legacy staging tables the candidate query reads. */
async function stageLegacy(
  people: Array<{ fn: string; ln: string; login: string | null; account?: number }>,
): Promise<void> {
  await conn.run("CREATE TABLE legacy_occurrence (firstName TEXT, lastName TEXT, userLogin TEXT)");
  await conn.run("CREATE TABLE legacy_person_map (fn TEXT, ln TEXT, person_id INTEGER)");
  for (const p of people) {
    const [[personId]] = (await (
      await conn.run(
        `INSERT INTO person (display_name) VALUES ('${p.fn} ${p.ln}') RETURNING entity_id`,
      )
    ).getRows()) as [[number]];
    await conn.run(
      `INSERT INTO legacy_person_map VALUES ('${p.fn}', '${p.ln}', ${personId})`,
    );
    await conn.run(
      `INSERT INTO legacy_occurrence VALUES ('${p.fn}', '${p.ln}', ${p.login === null ? "NULL" : `'${p.login}'`})`,
    );
    if (p.account !== undefined) {
      await conn.run(
        `INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${personId}, ${p.account}, '${p.login}')`,
      );
    }
  }
}

function fakeUsersApi(users: Record<string, { id: number; login: string; name?: string }>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const login = decodeURIComponent(String(url).split("/").pop()!);
    const user = users[login.toLowerCase()];
    if (!user) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ results: [{ name: null, ...user }] }), { status: 200 });
  }) as typeof fetch;
}

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
});

describe("inat account backfill", () => {
  test("fills unambiguous logins from the API; refuses shared, claimed, and vanished ones", async () => {
    await stageLegacy([
      { fn: "Roger", ln: "Dormaier", login: "rogerdormaier" },
      // shared login: two people on one account
      { fn: "Julie", ln: "Biddle", login: "tom_julie" },
      { fn: "Tom", ln: "Robertson", login: "tom_julie" },
      // login already claimed by an existing account holder
      { fn: "Rob", ln: "Caulfield", login: "beesofcanada" },
      { fn: "Lincoln", ln: "Best", login: "beesofcanada", account: 760776 },
      // login no longer resolvable upstream
      { fn: "Trinity", ln: "Harvey", login: "vanished" },
    ]);
    const result = await backfillInatAccounts(conn, {
      delayMs: 0,
      fetchImpl: fakeUsersApi({
        rogerdormaier: { id: 4242, login: "rogerdormaier", name: "Roger Dormaier" },
        tom_julie: { id: 5555, login: "tom_julie" },
      }),
    });
    expect(result.filled).toEqual([
      { person: "Roger Dormaier", login: "rogerdormaier", userId: 4242, apiName: "Roger Dormaier" },
    ]);
    expect(result.skipped.map((s) => s.login).sort()).toEqual([
      "beesofcanada", "tom_julie", "tom_julie", "vanished",
    ]);
    const accounts = await rows(
      conn,
      "SELECT login FROM inat_account ORDER BY login",
    );
    expect(accounts).toEqual([["beesofcanada"], ["rogerdormaier"]]);

    // Idempotent: filled people leave the candidate set.
    const again = await backfillInatAccounts(conn, { delayMs: 0, fetchImpl: fakeUsersApi({}) });
    expect(again.filled).toHaveLength(0);
  });

  test("a renamed login (API returns a different login) is not trusted", async () => {
    await stageLegacy([{ fn: "Amy", ln: "Leonard", login: "oldlogin" }]);
    const result = await backfillInatAccounts(conn, {
      delayMs: 0,
      fetchImpl: fakeUsersApi({ oldlogin: { id: 99, login: "somebodyelse" } }),
    });
    expect(result.filled).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/not an exact match/);
  });
});
