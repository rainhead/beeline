import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDb, rows } from "./helpers.js";
import { backfillAndRecord, backfillInatAccounts } from "../src/backfill-inat-accounts.js";
import { duckdbReader, readChanges, recordPersonChanges } from "../src/person-change.js";

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

  test("a binding is recorded under the backfill's own name, not found at startup (beeline-aa7)", async () => {
    // Through the CLI's own path, so the test fails if the CLI stops
    // recording, bypasses the gate, or swallows the source. A roster history
    // reads "an iNaturalist login lookup" where it used to read "found at
    // startup" about the same rows.
    await stageLegacy([{ fn: "Trinity", ln: "Harvey", login: "trinityharvey" }]);
    const path = join(await mkdtemp(join(tmpdir(), "backfill-")), "person-change.csv");
    await recordPersonChanges(duckdbReader(conn), path, { source: "legacy_promotion" });
    const env = { BEELINE_DB: "beeline.duckdb", BEELINE_PERSON_CHANGES: path };
    const warnings: string[] = [];
    const result = await backfillAndRecord(
      conn,
      "./beeline.duckdb",
      env,
      { delayMs: 0, fetchImpl: fakeUsersApi({ trinityharvey: { id: 8386998, login: "trinityharvey" } }) },
      (m) => warnings.push(m),
    );
    expect(result.filled).toHaveLength(1);
    expect(result.personChangesRecorded).toBe(2);
    expect(warnings).toEqual([]);
    const entries = (await readChanges(path)).filter((c) => c.source === "inat_backfill");
    expect(entries.map((c) => [c.field, c.new_value, c.author])).toEqual([
      ["inat_user_id", "8386998", ""],
      ["login", "trinityharvey", ""],
    ]);
  });

  test("a scratch copy is backfilled but not recorded against the deployed store's history", async () => {
    await stageLegacy([{ fn: "Trinity", ln: "Harvey", login: "trinityharvey" }]);
    const path = join(await mkdtemp(join(tmpdir(), "backfill-")), "person-change.csv");
    const warnings: string[] = [];
    const result = await backfillAndRecord(
      conn,
      "scratch.duckdb",
      { BEELINE_DB: "beeline.duckdb", BEELINE_PERSON_CHANGES: path },
      { delayMs: 0, fetchImpl: fakeUsersApi({ trinityharvey: { id: 8386998, login: "trinityharvey" } }) },
      (m) => warnings.push(m),
    );
    expect(result.filled).toHaveLength(1);
    expect(result.personChangesRecorded).toBeNull();
    expect(warnings).toEqual([expect.stringMatching(/not recording person history: scratch\.duckdb/)]);
  });

  test("a history-write failure is warned about, and the bindings it could not record still stand", async () => {
    await stageLegacy([{ fn: "Trinity", ln: "Harvey", login: "trinityharvey" }]);
    // A directory where the log file should be: every write to it fails.
    const path = await mkdtemp(join(tmpdir(), "backfill-"));
    const warnings: string[] = [];
    const result = await backfillAndRecord(
      conn,
      "beeline.duckdb",
      { BEELINE_DB: "beeline.duckdb", BEELINE_PERSON_CHANGES: path },
      { delayMs: 0, fetchImpl: fakeUsersApi({ trinityharvey: { id: 8386998, login: "trinityharvey" } }) },
      (m) => warnings.push(m),
    );
    expect(result.filled).toHaveLength(1);
    expect(result.personChangesRecorded).toBeNull();
    expect(warnings).toEqual([expect.stringMatching(/could not record person history/)]);
    expect(await rows(conn, "SELECT login FROM inat_account")).toEqual([["trinityharvey"]]);
  });

  test("a login whose profile names a different known person is misattributed, not linked", async () => {
    // Emily's records carry a login whose iNat profile says it is Andony's
    // account — the structural guards can't see that, the profile name can.
    await stageLegacy([
      { fn: "Emily", ln: "Carlson", login: "amelathopoulos" },
      { fn: "Andony", ln: "Melathopoulos", login: "andonymelathopoulos", account: 1542612 },
    ]);
    const result = await backfillInatAccounts(conn, {
      delayMs: 0,
      fetchImpl: fakeUsersApi({
        amelathopoulos: { id: 429964, login: "amelathopoulos", name: "Andony Melathopoulos" },
      }),
    });
    expect(result.filled).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/misattributed/);
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
