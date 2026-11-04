import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { parseCsv } from "../src/corrections.js";
import { readSampleOverlay } from "../src/sample-overlay.js";
import { duckdbReader } from "../src/person-change.js";
import { recordSampleChanges } from "../src/sample-change.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * Staff giving many samples their suggested locality at once from /samples
 * (beeline-7ywr): the action is chosen first, each row says what it would
 * take or why it cannot, and the write is one press of "Use this locality"
 * per ticked sample, credited to the staffer.
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

const b = en.listings.samples.bulk;

/**
 * Alice's samples, one of each case LOCALITY_BLOCKER tells apart, each linked
 * to an observation and each but one with a name for its point. The
 * localities are the shapes the first print run was held on: a street
 * address too long for a label, and none at all.
 */
async function setup() {
  const { instance, conn } = await createMemoryDb();
  const alice = await person(conn, "Alice Adams", "alice", 1);
  const sam = await person(conn, "Sam Staff", "samstaff", 2);
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${sam})`);
  const sample = (n: string, obs: number, locality: string | null) =>
    insertCleanSample(conn, {
      collector_id: String(alice),
      sample_number: `'${n}'`,
      inat_observation_id: String(obs),
      locality: locality === null ? "NULL" : `'${locality}'`,
    });
  const suggest = (id: number, name: string) =>
    conn.run(
      `INSERT INTO sample_locality_candidate (sample_id, rank, locality, basis, latitude, longitude, gazetteer_build, rule_version, derived_at)
       SELECT sample_id, 1, '${name}', 'refuge', latitude, longitude, 'test', 1, current_timestamp
       FROM sample_location WHERE sample_id = ${id}`,
    );
  const ids = {
    tooLong: await sample("1", 901, "26208 Finley Refuge Rd"),
    missing: await sample("2", 902, null),
    printed: await sample("3", 903, "26208 Finley Refuge Rd"),
    unnamed: await sample("4", 904, null),
    same: await sample("5", 905, "Finley NWR"),
    set: await sample("6", 906, "Bald Hill"),
  };
  for (const id of [ids.tooLong, ids.missing, ids.printed, ids.same, ids.set]) await suggest(id, "Finley NWR");
  await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${ids.printed}, 1)`);
  await conn.run(
    `INSERT INTO sample_locality_override (sample_id, locality, observed_locality, set_by) VALUES (${ids.set}, 'Bald Hill', NULL, ${alice})`,
  );
  const dir = await mkdtemp(join(tmpdir(), "beeline-bulk-locality-"));
  const paths = {
    sampleOverlayPath: join(dir, "sample-overlay.csv"),
    correctionsPath: join(dir, "corrections.csv"),
    sampleChangesPath: join(dir, "sample-change.csv"),
    sampleStatePath: join(dir, "sample-state.csv"),
  };
  const base = await scratchPaths();
  const people = { alice, sam };
  const appFor = (who: "alice" | "sam") =>
    createApp({
      ...base,
      db: createKysely(instance),
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId: people[who], login: who === "sam" ? "samstaff" : "alice", iconUrl: null }),
      conn,
      ...paths,
    });
  return { appFor, conn, ids, ...paths };
}

const localityOf = async (conn: DuckDBConnection, id: number) =>
  ((await rows(conn, `SELECT locality FROM sample WHERE entity_id = ${id}`)) as (string | null)[][])[0]![0];

const tickBox = (id: number) => `name="sample" value="${id}"`;

const give = (app: ReturnType<Awaited<ReturnType<typeof setup>>["appFor"]>, ids: number[], back = "/samples?act=locality") => {
  const body = new URLSearchParams({ back });
  for (const id of ids) body.append("sample", String(id));
  return app.request("/samples/locality", { method: "POST", body });
};

describe("giving samples their suggested locality from the listing", () => {
  it("offers staff the action, and in its mode a box with the name where a sample can take it and a reason where not", async () => {
    const { appFor, ids } = await setup();
    const staff = appFor("sam");
    const plain = await (await staff.request("/samples?scope=all")).text();
    expect(plain).toContain(b.start);
    expect(plain).not.toContain(tickBox(ids.tooLong));

    const mode = await (await staff.request("/samples?scope=all&act=locality")).text();
    expect(mode).toContain(b.modeHeading);
    expect(mode).toContain(tickBox(ids.tooLong));
    expect(mode).toContain(tickBox(ids.missing));
    expect(mode).toContain(`aria-label="${b.tickOne("1", "Finley NWR")}"`);
    for (const id of [ids.printed, ids.unnamed, ids.same, ids.set]) expect(mode).not.toContain(tickBox(id));
    for (const reason of ["printed", "none", "same", "set"] as const) expect(mode).toContain(b.blocker[reason]);
    expect(mode).toContain('action="/samples/locality"');
  });

  it("is staff's alone: a volunteer asking for the mode gets the plain listing", async () => {
    const { appFor, ids } = await setup();
    const page = await (await appFor("alice").request("/samples?act=locality")).text();
    expect(page).not.toContain(b.start);
    expect(page).not.toContain(b.modeHeading);
    expect(page).not.toContain(tickBox(ids.tooLong));
  });

  it("finds the samples whose locality is missing or will not fit a label", async () => {
    const { appFor, ids } = await setup();
    const page = await (await appFor("sam").request("/samples?scope=all&qc=locality")).text();
    expect(page).toContain(`/samples/${ids.tooLong}"`);
    expect(page).toContain(`/samples/${ids.missing}"`);
    expect(page).not.toContain(`/samples/${ids.same}"`);
    expect(page).not.toContain(`/samples/${ids.set}"`);
  });

  it("gives each ticked sample that can take it its suggestion, credited to the staffer, and leaves the rest", async () => {
    const { appFor, conn, ids, sampleOverlayPath, sampleChangesPath, sampleStatePath } = await setup();
    // A first pass over a store with no snapshot baselines rather than records.
    await recordSampleChanges(duckdbReader(conn), { log: sampleChangesPath, state: sampleStatePath }, { source: "reconcile" });
    const res = await give(appFor("sam"), Object.values(ids), "/samples?scope=all&act=locality&qc=locality");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/samples?scope=all&act=locality&qc=locality&localities=2&of=6");

    expect(await localityOf(conn, ids.tooLong)).toBe("Finley NWR");
    expect(await localityOf(conn, ids.missing)).toBe("Finley NWR");
    expect(await localityOf(conn, ids.printed)).toBe("26208 Finley Refuge Rd");
    expect(await localityOf(conn, ids.unnamed)).toBe(null);
    expect(await localityOf(conn, ids.set)).toBe("Bald Hill");

    const overlay = await readSampleOverlay(sampleOverlayPath);
    expect(overlay.map((r) => [r.sample_ref, r.value, r.author])).toEqual([
      ["inat:901", "Finley NWR", "samstaff"],
      ["inat:902", "Finley NWR", "samstaff"],
    ]);
    expect(overlay[0]!.reason).toBe(en.suggestedLocality.reason(en.suggestedLocality.basis.refuge));

    const log = parseCsv(await readFile(sampleChangesPath, "utf8"));
    const given = log.filter((r) => r.includes("locality") && r.includes("Finley NWR"));
    expect(given).toHaveLength(2);
    expect(given.every((r) => r.includes("samstaff") && r.includes(b.historyReason))).toBe(true);

    const back = await (await appFor("sam").request("/samples?scope=all&localities=2&of=6")).text();
    expect(back).toContain(b.done(2, 6));
  });

  it("refuses a volunteer, and sends a back link elsewhere to the listing itself", async () => {
    const { appFor, conn, ids } = await setup();
    expect((await give(appFor("alice"), [ids.tooLong])).status).toBe(403);
    expect(await localityOf(conn, ids.tooLong)).toBe("26208 Finley Refuge Rd");
    const res = await give(appFor("sam"), [ids.tooLong], "https://example.com/samples");
    expect(res.headers.get("location")).toBe("/samples?localities=1&of=1");
  });
});
