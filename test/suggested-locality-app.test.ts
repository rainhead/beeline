import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { readSampleOverlay } from "../src/sample-overlay.js";
import { duckdbReader } from "../src/person-change.js";
import { recordSampleChanges } from "../src/sample-change.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * "Use this locality" (beeline-7i6): a collector makes the locality Beeline
 * named from the coordinates the sample's own, in one click, through the
 * staff locality's write, and may take back one they adopted.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

async function person(conn: DuckDBConnection, name: string, login: string, userId: number): Promise<number> {
  const [[id]] = (await (
    await conn.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)
  ).getRows()) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${userId}, '${login}')`);
  return Number(id);
}

type Who = "alice" | "bob" | "sam";
const LOGINS: Record<Who, string> = { alice: "alice", bob: "bob", sam: "samstaff" };

/** Alice's iNat-linked sample, with a street address for a locality and a suggestion beside it. */
async function setup() {
  const { instance, conn } = await createMemoryDb();
  const ids = {
    alice: await person(conn, "Alice Adams", "alice", 1),
    bob: await person(conn, "Bob Barnes", "bob", 2),
    sam: await person(conn, "Sam Staff", "samstaff", 3),
  };
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${ids.sam})`);
  const sampleId = await insertCleanSample(conn, {
    collector_id: String(ids.alice),
    sample_number: "'A-1'",
    inat_observation_id: "998877",
    locality: "'26208 Finley Refuge Rd'",
  });
  await conn.run(
    `INSERT INTO sample_locality_candidate (sample_id, rank, locality, basis, latitude, longitude, gazetteer_build, derived_at)
     SELECT sample_id, 1, 'Finley NWR', 'refuge', latitude, longitude, 'test', current_timestamp
     FROM sample_location WHERE sample_id = ${sampleId}`,
  );
  const dir = await mkdtemp(join(tmpdir(), "beeline-suggested-"));
  const paths = {
    sampleOverlayPath: join(dir, "sample-overlay.csv"),
    correctionsPath: join(dir, "corrections.csv"),
    sampleChangesPath: join(dir, "sample-change.csv"),
    sampleStatePath: join(dir, "sample-state.csv"),
  };
  const base = await scratchPaths();
  const appFor = (who: Who) =>
    createApp({
      ...base,
      db: createKysely(instance),
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId: ids[who], login: LOGINS[who], iconUrl: null }),
      conn,
      ...paths,
    });
  return { appFor, conn, sampleId, ...paths };
}

const post = (app: ReturnType<Awaited<ReturnType<typeof setup>>["appFor"]>, path: string, body: Record<string, string>) =>
  app.request(path, { method: "POST", body: new URLSearchParams(body) });

const localityOf = async (conn: DuckDBConnection, id: number) =>
  ((await rows(conn, `SELECT locality FROM sample WHERE entity_id = ${id}`)) as string[][])[0]![0];

describe("Use this locality", () => {
  it("makes the suggestion the sample's locality, credited to the collector, and clears the flag", async () => {
    const { appFor, conn, sampleId, sampleOverlayPath } = await setup();
    const alice = appFor("alice");
    expect(await (await alice.request(`/samples/${sampleId}`)).text()).toContain(en.suggestedLocality.use);
    const res = await post(alice, `/samples/${sampleId}/suggested-locality`, { locality: "Finley NWR", return: "home" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(await localityOf(conn, sampleId)).toBe("Finley NWR");
    const [row] = await readSampleOverlay(sampleOverlayPath);
    expect(row).toMatchObject({ sample_ref: "inat:998877", field: "locality", value: "Finley NWR", author: "alice" });
    expect(row!.reason).toBe(en.suggestedLocality.reason(en.suggestedLocality.basis.refuge));
    expect(await rows(conn, `SELECT 1 FROM qc_rule_locality_format WHERE sample_id = ${sampleId}`)).toEqual([]);
    // And the page now says it is in use, and offers to take it back.
    const body = await (await alice.request(`/samples/${sampleId}`)).text();
    expect(body).toContain(en.suggestedLocality.inUse.replaceAll("'", "&#39;"));
    expect(body).toContain(en.suggestedLocality.undo.replaceAll("'", "&#39;"));
  });

  it("offers the alternatives too, and makes the one chosen the sample's locality (beeline-4hxe)", async () => {
    const { appFor, conn, sampleId, sampleOverlayPath } = await setup();
    await conn.run(
      `INSERT INTO sample_locality_candidate (sample_id, rank, locality, basis, latitude, longitude, gazetteer_build, derived_at)
       SELECT sample_id, 2, 'Muddy Creek CG', 'campground', latitude, longitude, 'test', current_timestamp
       FROM sample_location WHERE sample_id = ${sampleId}`,
    );
    const alice = appFor("alice");
    const page = await (await alice.request(`/samples/${sampleId}`)).text();
    expect(page).toContain("Muddy Creek CG");
    expect(page).toContain(en.suggestedLocality.basis.campground);
    const res = await post(alice, `/samples/${sampleId}/suggested-locality`, { locality: "Muddy Creek CG" });
    expect(res.status).toBe(302);
    expect(await localityOf(conn, sampleId)).toBe("Muddy Creek CG");
    const [row] = await readSampleOverlay(sampleOverlayPath);
    expect(row!.reason).toBe(en.suggestedLocality.reason(en.suggestedLocality.basis.campground));
  });

  it("refuses a name other than the one the store suggests now", async () => {
    const { appFor, conn, sampleId } = await setup();
    const res = await post(appFor("alice"), `/samples/${sampleId}/suggested-locality`, { locality: "Somewhere Else" });
    expect(res.status).toBe(409);
    expect(await localityOf(conn, sampleId)).toBe("26208 Finley Refuge Rd");
  });

  it("is not another volunteer's to use, nor anyone's once labels print", async () => {
    const { appFor, conn, sampleId } = await setup();
    expect((await post(appFor("bob"), `/samples/${sampleId}/suggested-locality`, { locality: "Finley NWR" })).status).toBe(404);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${sampleId}, 1)`);
    expect((await post(appFor("alice"), `/samples/${sampleId}/suggested-locality`, { locality: "Finley NWR" })).status).toBe(409);
    expect(await localityOf(conn, sampleId)).toBe("26208 Finley Refuge Rd");
  });

  it("lets the volunteer who adopted it go back, with the reason in the sample's history", async () => {
    const { appFor, conn, sampleId, sampleOverlayPath, sampleChangesPath, sampleStatePath } = await setup();
    // The history's baseline, as a running deployment has one: the first pass only writes it.
    await recordSampleChanges(duckdbReader(conn), { log: sampleChangesPath, state: sampleStatePath }, { source: "observation_promotion" });
    const alice = appFor("alice");
    await post(alice, `/samples/${sampleId}/suggested-locality`, { locality: "Finley NWR" });
    expect(await readFile(sampleChangesPath, "utf8")).toContain(en.suggestedLocality.reason(en.suggestedLocality.basis.refuge));
    expect((await post(alice, `/samples/${sampleId}/suggested-locality`, { undo: "1" })).status).toBe(302);
    const [row] = await readSampleOverlay(sampleOverlayPath);
    expect(row).toMatchObject({ field: "locality", value: "", author: "alice" });
  });

  it("leaves a locality somebody else set alone: no replacing it, no taking it back (Fable's review)", async () => {
    const { appFor, conn, sampleId, sampleOverlayPath } = await setup();
    // Staff set a locality of their own on the sample.
    const staffSet = await post(appFor("sam"), `/samples/${sampleId}/locality`, { locality: "Finley NWR N unit", note: "north unit" });
    expect(staffSet.status).toBe(302);
    const alice = appFor("alice");
    const page = await (await alice.request(`/samples/${sampleId}`)).text();
    expect(page).not.toContain(en.suggestedLocality.use);
    expect(page).not.toContain(en.suggestedLocality.undo.replaceAll("'", "&#39;"));
    expect((await post(alice, `/samples/${sampleId}/suggested-locality`, { locality: "Finley NWR" })).status).toBe(403);
    expect((await post(alice, `/samples/${sampleId}/suggested-locality`, { undo: "1" })).status).toBe(403);
    expect(await localityOf(conn, sampleId)).toBe("Finley NWR N unit");
    const [row] = await readSampleOverlay(sampleOverlayPath);
    expect(row).toMatchObject({ value: "Finley NWR N unit", author: "samstaff", reason: "north unit" });
    // Staff may still replace it with the suggestion.
    expect((await post(appFor("sam"), `/samples/${sampleId}/suggested-locality`, { locality: "Finley NWR" })).status).toBe(302);
    expect(await localityOf(conn, sampleId)).toBe("Finley NWR");
  });
});
