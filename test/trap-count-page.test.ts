import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * Staff correcting a trap sample's trap count from a pencil on the Method row
 * of its page (beeline-kgyd.4.1): who is offered the pencil, what the form
 * saves, and what it says when it refuses.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const t = en.record.sample.trapCount;

async function person(conn: DuckDBConnection, name: string, login: string, userId: number): Promise<number> {
  const [[id]] = (await (await conn.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)).getRows()) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${userId}, '${login}')`);
  return Number(id);
}

async function setup() {
  const { instance, conn } = await createMemoryDb();
  const alice = await person(conn, "Alice Adams", "alice", 1);
  const sam = await person(conn, "Sam Staff", "samstaff", 3);
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${sam})`);
  const trap = await insertCleanSample(conn, {
    collector_id: String(alice),
    sample_number: "'T-1'",
    kind: "'trap'",
    protocol: "'vane trap'",
    sampling_effort: "'6 vane traps'",
  });
  const net = await insertCleanSample(conn, { collector_id: String(alice), sample_number: "'N-1'" });
  const base = await scratchPaths();
  const appFor = (personId: number, login: string) =>
    createApp({
      ...base,
      db: createKysely(instance),
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId, login, iconUrl: null }),
      conn,
    });
  return { conn, trap, net, staff: appFor(sam, "samstaff"), collector: appFor(alice, "alice") };
}

const post = (app: ReturnType<typeof createApp>, id: number, body: Record<string, string>) =>
  app.request(`/samples/${id}/trap-count`, { method: "POST", body: new URLSearchParams(body) });
const effort = async (conn: DuckDBConnection, id: number) =>
  ((await rows(conn, `SELECT sampling_effort FROM sample WHERE entity_id = ${id}`)) as (string | null)[][])[0]![0];

describe("the trap count pencil on the Method row", () => {
  it("is offered to staff on a trap sample, showing the count, and not to the collector or on a net sample", async () => {
    const s = await setup();
    const page = await (await s.staff.request(`/samples/${s.trap}`)).text();
    expect(page).toContain(`/samples/${s.trap}/trap-count`);
    expect(page).toContain(t.open);
    expect(page).toMatch(/name="count"[^>]*value="6"|value="6"[^>]*name="count"/);
    expect(await (await s.staff.request(`/samples/${s.net}`)).text()).not.toContain(`/trap-count`);
    expect(await (await s.collector.request(`/samples/${s.trap}`)).text()).not.toContain(`/trap-count`);
  });

  it("saves a count and takes it away, and refuses the rest in the catalogue's words", async () => {
    const s = await setup();
    const saved = await post(s.staff, s.trap, { count: "9", note: "recount" });
    expect(saved.status).toBe(302);
    expect(saved.headers.get("location")).toBe(`/samples/${s.trap}`);
    expect(await effort(s.conn, s.trap)).toBe("9 vane traps");
    expect((await post(s.staff, s.trap, { count: "", note: "" })).status).toBe(302);
    expect(await effort(s.conn, s.trap)).toBeNull();
    const bad = await post(s.staff, s.trap, { count: "many", note: "" });
    expect([bad.status, await bad.text()]).toEqual([400, t.problems.count]);
    const net = await post(s.staff, s.net, { count: "2", note: "" });
    expect([net.status, await net.text()]).toEqual([400, t.problems.net]);
    expect((await post(s.collector, s.trap, { count: "2", note: "" })).status).toBe(403);
    expect(await effort(s.conn, s.trap)).toBeNull();
  });
});
