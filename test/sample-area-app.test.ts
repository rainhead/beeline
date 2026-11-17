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
import { SETTLED_SEASON, buildTestGazetteer, createMemoryDb, insertCleanSample, scratchPaths } from "./helpers.js";
import { areaDisplayName } from "../src/area-name.js";
import { listAreas } from "../src/app/areas.js";

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
  return { appFor, sampleId, specimenId: Number(specimenId), conn, ids, gazetteer, db: createKysely(instance) };
}

const ecoNote = en.record.sample.inEcoregion("Coast Range");
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

describe("a sample in an ecoregion (beeline-l5so)", () => {
  it("says so on its sample page and its specimen's, and is found by the ecoregion's name", async () => {
    const { appFor, sampleId, specimenId } = await setup("NULL");
    const bob = appFor("bob");
    expect(await (await bob.request(`/samples/${sampleId}`)).text()).toContain(escaped(ecoNote));
    expect(await (await bob.request(`/specimens/${specimenId}`)).text()).toContain(escaped(ecoNote));
    expect(await (await bob.request(placeSearch("coast range"))).text()).toContain(`/samples/${sampleId}"`);
  });

  it("keeps the ecoregion to those who may see where the sample is", async () => {
    const { appFor, sampleId } = await setup("'obscured'");
    const bob = appFor("bob");
    expect(await (await bob.request(`/samples/${sampleId}`)).text()).not.toContain(escaped(ecoNote));
    expect(await (await bob.request(placeSearch("coast range"))).text()).not.toContain(`/samples/${sampleId}"`);
    expect(await (await appFor("alice").request(`/samples/${sampleId}`)).text()).toContain(escaped(ecoNote));
  });

  it("says nothing for a sample in no ecoregion", async () => {
    const { appFor, sampleId, conn } = await setup("NULL");
    await conn.run(`DELETE FROM sample_area WHERE sample_id = ${sampleId} AND area_source = 'epa-cec'`);
    const html = await (await appFor("bob").request(`/samples/${sampleId}`)).text();
    expect(html).not.toContain("ecoregion");
  });
});

describe("a sample whose recorded state is not its point's (beeline-rax1)", () => {
  // The sample is in Oregon by its point; the record is changed to say WA
  // after the areas were found, as a printed sample's labels might.
  const line = escaped(en.record.sample.placeDisagrees("OR, USA", "WA, USA", true));

  async function disagreeing() {
    const made = await setup("NULL");
    await made.conn.run(`UPDATE sample SET state_province = 'WA' WHERE entity_id = ${made.sampleId}`);
    await made.conn.run(`INSERT INTO person_admin (person_id) SELECT entity_id FROM person WHERE display_name = 'Bob Barnes'`);
    return made;
  }

  it("is said to staff on the sample page", async () => {
    const { appFor, sampleId } = await disagreeing();
    expect(await (await appFor("bob").request(`/samples/${sampleId}`)).text()).toContain(line);
  });

  it("is not said to the collector, who does not correct a printed place", async () => {
    const { appFor, sampleId } = await disagreeing();
    expect(await (await appFor("alice").request(`/samples/${sampleId}`)).text()).not.toContain(line);
  });

  it("is not said where the point agrees", async () => {
    const { appFor, sampleId, conn } = await disagreeing();
    await conn.run(`UPDATE sample SET state_province = 'OR' WHERE entity_id = ${sampleId}`);
    expect(await (await appFor("bob").request(`/samples/${sampleId}`)).text()).not.toContain("These coordinates are");
  });
});

describe("the Areas page (beeline-9jd4)", () => {
  // The test gazetteer's refuge is keyed usfws 99001; setup's second sample
  // lies inside it, in an active season, and this adds a settled one.
  const REFUGE_KEY = "usfws:99001";
  const areaSearch = (path: string, key: string) => `${path}?scope=all&area=${encodeURIComponent(key)}`;

  async function withSettledRefugeSample() {
    const made = await setup("NULL");
    const settledId = await insertCleanSample(
      made.conn,
      {
        collector_id: String(made.ids.alice),
        sample_number: "'3'",
        locality: "'Muddy Creek'",
        date_start: `DATE '${SETTLED_SEASON}-07-14'`,
        date_end: `DATE '${SETTLED_SEASON}-07-14'`,
      },
      { latitude: "44.42", longitude: "-123.31" },
    );
    await deriveAreas(made.conn, made.gazetteer);
    await made.conn.run(`INSERT INTO person_admin (person_id) VALUES (${made.ids.bob})`);
    return { ...made, settledId };
  }

  it("lists the areas a sample lies inside as districts, properties and ecoregions, with their samples split by season", async () => {
    const { db } = await withSettledRefugeSample();
    // A district is under the state its samples' points say it is in.
    expect(await listAreas(db, "districts")).toEqual([
      {
        grouping: { by: "state", state: "OR", country: "USA" },
        areas: [{ key: "census:41003", name: "Benton County", active: 2, settled: 1 }],
      },
    ]);
    expect(await listAreas(db, "properties")).toEqual([
      {
        grouping: { by: "kind", kind: "refuge" },
        areas: [{ key: REFUGE_KEY, name: "William L. Finley National Wildlife Refuge", active: 1, settled: 1 }],
      },
    ]);
    const ecoregions = await listAreas(db, "ecoregions");
    expect(ecoregions.map((g) => g.grouping)).toEqual([{ by: "kind", kind: "ecoregion" }]);
    expect(ecoregions[0]!.areas.map((a) => a.name)).toEqual(["Coast Range", "Willamette Valley"]);
  });

  it("is staff's alone, on every tab", async () => {
    const { appFor } = await withSettledRefugeSample();
    for (const path of ["/areas", "/areas/districts", "/areas/properties", "/areas/ecoregions"]) {
      expect((await appFor("alice").request(path)).status).toBe(403);
    }
    const first = await appFor("bob").request("/areas");
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/areas/districts");
    expect((await appFor("bob").request("/areas/islands")).status).toBe(404);
  });

  it("names a district's state, links each area to the samples inside it, and lists no wilderness", async () => {
    const { appFor } = await withSettledRefugeSample();
    const bob = appFor("bob");
    const districts = await (await bob.request("/areas/districts")).text();
    expect(districts).toContain(">OR, USA</h2>");
    expect(districts).toContain(`href="/samples?scope=all&amp;area=census%3A41003"`);
    for (const tab of [en.areas.tab.districts, en.areas.tab.properties, en.areas.tab.ecoregions]) {
      expect(districts).toContain(tab);
    }
    const properties = await (await bob.request("/areas/properties")).text();
    expect(properties).toContain(`href="/samples?scope=all&amp;area=usfws%3A99001"`);
    expect(properties).toContain("William L. Finley National Wildlife Refuge");
    const ecoregions = await (await bob.request("/areas/ecoregions")).text();
    expect(ecoregions).toContain("Coast Range");
    // One sample is inside the Alsea Wilderness, which no tab lists (Peter, 2026-11-17).
    for (const html of [districts, properties, ecoregions]) {
      expect(html).not.toContain("Alsea Wilderness");
      expect(html).not.toContain(en.areas.kind.wilderness);
    }
  });

  it("the area filter finds exactly the samples inside the area, on both listings, and names it in a pill", async () => {
    const { appFor, sampleId, settledId } = await withSettledRefugeSample();
    const bob = appFor("bob");
    const html = await (await bob.request(areaSearch("/samples", REFUGE_KEY))).text();
    expect(html).toContain(`/samples/${settledId}"`);
    expect(html).toContain("Corvallis");
    // The sample in the wilderness is in the same county and not in the refuge.
    expect(html).not.toContain(`/samples/${sampleId}"`);
    expect(html).toContain("William L. Finley National Wildlife Refuge");
    expect(html).toContain(en.areas.filter);
    // The specimens listing takes the same filter: the one specimen is the wilderness sample's.
    const specimens = await (await bob.request(areaSearch("/specimens", "wilderness.net:9001"))).text();
    expect(specimens).toContain(`/samples/${sampleId}"`);
    expect(await (await bob.request(areaSearch("/specimens", REFUGE_KEY))).text()).not.toContain(`/samples/${sampleId}"`);
  });

  it("an area the store does not hold finds nothing, and says so", async () => {
    const { appFor, sampleId, settledId } = await withSettledRefugeSample();
    const html = await (await appFor("bob").request(areaSearch("/samples", "usfws:nowhere"))).text();
    expect(html).not.toContain(`/samples/${sampleId}"`);
    expect(html).not.toContain(`/samples/${settledId}"`);
    expect(html).toContain(en.areas.filterUnknown);
  });

  it("keeps a sample from a reader who may not see where it is", async () => {
    // Alice's sample in the wilderness is obscured, and Bob is not staff here.
    const { appFor, sampleId } = await setup("'obscured'");
    const key = "wilderness.net:9001";
    const bobs = await (await appFor("bob").request(areaSearch("/samples", key))).text();
    expect(bobs).not.toContain(`/samples/${sampleId}"`);
    // Nor is he told the area's name: the store holds an area only once a
    // sample lies inside it, so the name alone would say one does.
    expect(bobs).not.toContain("Alsea Wilderness");
    expect(bobs).toContain(en.areas.filterUnknown);
    const bobsSpecimens = await (await appFor("bob").request(areaSearch("/specimens", key))).text();
    expect(bobsSpecimens).not.toContain(`/samples/${sampleId}"`);
    expect(bobsSpecimens).not.toContain("Alsea Wilderness");
    // Alice collected it, so she finds it.
    expect(await (await appFor("alice").request(areaSearch("/samples", key))).text()).toContain(`/samples/${sampleId}"`);
  });
});

describe("an area's name as a page shows it", () => {
  // The first three are names as the sources write them; the last is synthetic.
  it.each([
    ["WILLIAM L. FINLEY NATIONAL WILDLIFE REFUGE", "William L. Finley National Wildlife Refuge"],
    ["E.C. MANNING PARK", "E.C. Manning Park"],
    ["MCNARY NATIONAL WILDLIFE REFUGE", "McNary National Wildlife Refuge"],
    ["BOSQUE DEL APACHE NATIONAL WILDLIFE REFUGE", "Bosque del Apache National Wildlife Refuge"],
    ["Cottonwood Canyon State Park", "Cottonwood Canyon State Park"],
    ["Shumaker Unit, Chief Joseph Wildlife Area", "Shumaker Unit, Chief Joseph Wildlife Area"],
    ["KETTLE RIVER/GRANBY PARK", "Kettle River/Granby Park"],
  ])("%s", (written, shown) => {
    expect(areaDisplayName(written)).toBe(shown);
  });
});
