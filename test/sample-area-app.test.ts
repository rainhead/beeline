import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { deriveAreas } from "../src/derive-area.js";
import { buildTestGazetteer, createMemoryDb, insertCleanSample, scratchPaths } from "./helpers.js";

/**
 * A sample collected inside a federal wilderness (beeline-zdfz): the sample
 * and specimen pages say so, and the place filter finds it by the
 * wilderness's name, except for a reader who may not see where it is.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "beeline-sample-area-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function person(conn: DuckDBConnection, name: string, login: string, userId: number): Promise<number> {
  const [[id]] = (await (
    await conn.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)
  ).getRows()) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${userId}, '${login}')`);
  return Number(id);
}

/** Alice's sample inside the test gazetteer's Alsea Wilderness, and Bob, who did not collect it. */
async function setup(geoprivacy: "NULL" | "'obscured'") {
  const { instance, conn } = await createMemoryDb();
  const ids = { alice: await person(conn, "Alice Adams", "alice", 1), bob: await person(conn, "Bob Barnes", "bob", 2) };
  const sampleId = await insertCleanSample(
    conn,
    { collector_id: String(ids.alice), locality: "'Alsea Falls'", geoprivacy },
    { latitude: "44.50", longitude: "-123.60" },
  );
  await insertCleanSample(conn, { collector_id: String(ids.alice), sample_number: "'2'" }, { latitude: "44.41", longitude: "-123.30" });
  await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${sampleId}, 1)`);
  const [[specimenId]] = (await (
    await conn.run(`SELECT entity_id FROM specimen WHERE sample_id = ${sampleId}`)
  ).getRows()) as [[number]];
  const gazetteer = join(dir, `g-${Math.random().toString(36).slice(2)}.duckdb`);
  await buildTestGazetteer(gazetteer, "build-1");
  await deriveAreas(conn, gazetteer);
  const base = await scratchPaths();
  const appFor = (who: "alice" | "bob") =>
    createApp({
      ...base,
      db: createKysely(instance),
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId: ids[who], login: who, iconUrl: null }),
      conn,
    });
  return { appFor, sampleId, specimenId: Number(specimenId) };
}

const note = en.record.sample.inWilderness("Alsea Wilderness");
const escaped = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const placeSearch = (place: string) => `/samples?scope=all&place=${encodeURIComponent(place)}`;

describe("a sample inside a wilderness", () => {
  it("is noted on its sample page and its specimen's", async () => {
    const { appFor, sampleId, specimenId } = await setup("NULL");
    const bob = appFor("bob");
    expect(await (await bob.request(`/samples/${sampleId}`)).text()).toContain(escaped(note));
    expect(await (await bob.request(`/specimens/${specimenId}`)).text()).toContain(escaped(note));
  });

  it("is found by the wilderness's name, and only it", async () => {
    const { appFor } = await setup("NULL");
    const html = await (await appFor("bob").request(placeSearch("alsea wilderness"))).text();
    expect(html).toContain("Alsea Falls");
    expect(html).not.toContain("Corvallis");
  });

  it("keeps the wilderness to those who may see where the sample is", async () => {
    const { appFor, sampleId } = await setup("'obscured'");
    // Bob may not see where Alice's obscured sample is: no note, and no
    // finding it by the wilderness either.
    const bob = appFor("bob");
    expect(await (await bob.request(`/samples/${sampleId}`)).text()).not.toContain(escaped(note));
    expect(await (await bob.request(placeSearch("alsea wilderness"))).text()).not.toContain(`/samples/${sampleId}"`);
    // Alice collected it, so she sees both.
    const alice = appFor("alice");
    expect(await (await alice.request(`/samples/${sampleId}`)).text()).toContain(escaped(note));
    expect(await (await alice.request(placeSearch("alsea wilderness"))).text()).toContain(`/samples/${sampleId}"`);
  });
});
