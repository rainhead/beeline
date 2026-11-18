import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { en } from "../src/app/messages/en.js";
import { createApp } from "../src/app/server.js";
import { createKysely } from "../src/db.js";
import { IdealLogicError, type IdealLogicClient, type Registrant } from "../src/ideal-logic.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * A print run's mailing addresses (beeline-w8ab.3): fetched from Ideal Logic
 * while the request is answered, and never kept. Everyone here is invented
 * and every address is at example.org.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const ORIGIN = "http://localhost:3054";
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const registrant = (id: string, address: Registrant["address"]): Registrant => ({
  id,
  givenName: "Invented",
  familyName: "Person",
  atlases: [],
  inatHandle: null,
  email: `${id.toLowerCase()}@example.org`,
  address,
});

const REGISTRANTS: Registrant[] = [
  // Ada and Bo share a household, spelled two ways in what they typed.
  registrant("HOUSE-1", {
    street: "12 Oak Street\nApartment 4",
    city: "Corvallis",
    stateProvince: "OR",
    postalCode: "97330",
    country: "USA",
  }),
  registrant("HOUSE-2", {
    street: "12 oak street, apartment 4",
    city: "Corvallis",
    stateProvince: "OR",
    postalCode: "97330",
    country: "USA",
  }),
  registrant("CAN-1", { street: "3 Elm Road", city: "Victoria", stateProvince: "BC", postalCode: "V8W 1P6", country: "CAN" }),
  registrant("NOADDR-1", null),
];

function fakeClient(opts: { fail?: IdealLogicError; registrants?: Registrant[] } = {}) {
  const fetchRegistrants = vi.fn(async () => {
    if (opts.fail) throw opts.fail;
    return opts.registrants ?? REGISTRANTS;
  });
  const client: IdealLogicClient = { fetchRegistrants, remaining: () => 41 };
  return { client, fetchRegistrants };
}

async function setup(client: IdealLogicClient | null, who: "staffer" | "volunteer" = "staffer") {
  const { instance, conn } = await createMemoryDb();
  const person = async (name: string) => {
    const [given, family] = name.split(" ");
    const [[id]] = (await rows(
      conn,
      `INSERT INTO person (display_name, given_name, family_name) VALUES ('${name}', '${given}', '${family}') RETURNING entity_id`,
    )) as [[number]];
    return id;
  };
  const staffer = await person("Sam Staff");
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staffer})`);
  const link = (personId: number, id: string) =>
    conn.run(`INSERT INTO person_registration_event (person_id, ideal_logic_id, evidence, decided_by) VALUES (${personId}, '${id}', 'staff', 'test')`);
  const names = ["Ada Ash", "Bo Birch", "Cy Cedar", "Di Dale", "Ed Elm", "Flo Fir"];
  const ids: Record<string, number> = {};
  let n = 1;
  for (const name of names) {
    ids[name] = await person(name);
    await insertCleanSample(conn, { collector_id: String(ids[name]), specimen_count: String(n), sample_number: "'1'" });
    n += 1;
  }
  await link(ids["Ada Ash"]!, "HOUSE-1");
  await link(ids["Bo Birch"]!, "HOUSE-2");
  await link(ids["Cy Cedar"]!, "CAN-1");
  await link(ids["Ed Elm"]!, "NOADDR-1");
  await link(ids["Flo Fir"]!, "GONE-9");
  const dir = await mkdtemp(join(tmpdir(), "beeline-addresses-"));
  dirs.push(dir);
  const paths = await scratchPaths();
  let asVolunteer = false;
  const app = createApp({
    ...paths,
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: ORIGIN, idealLogic: client },
    inat: unusedInat,
    resolveSession: async () => ({ personId: asVolunteer ? ids["Ada Ash"]! : staffer, login: "who", iconUrl: null }),
    printConn: conn,
    printRunsDir: dir,
  });
  const post = (path: string, body: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { origin: ORIGIN }, body: new URLSearchParams(body) });
  const prepared = await post("/print-runs");
  const runPath = prepared.headers.get("location")!;
  asVolunteer = who === "volunteer";
  return { app, post, conn, paths, runPath, ids };
}

/** The file's lines, without the byte order mark. */
const lines = (body: string) => body.replace(/^﻿/, "").trim().split(/\r?\n/);

describe("a print run's mailing addresses", () => {
  it("gives one row per address, and a noted row for each collector with none, last", async () => {
    const { client, fetchRegistrants } = fakeClient();
    const { post, runPath, paths } = await setup(client);
    const scratch = dirname(paths.correctionsPath);
    const before = await readdir(scratch);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await post(`${runPath}/addresses.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const id = runPath.split("/").pop();
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="beeline-addresses-run-${id}.csv"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetchRegistrants).toHaveBeenCalledTimes(1);

    const out = lines(await res.text());
    const h = en.printRuns.run.addresses.headers;
    expect(out[0]).toBe(
      [h.names, h.line1, h.line2, h.city, h.stateProvince, h.postalCode, h.country, h.labels, h.printedAs, h.note].join(","),
    );
    const notes = en.printRuns.run.addresses.notes;
    // Ada (1 label) and Bo (2) share an address spelled two ways: one row, two street lines.
    expect(out[1]).toMatch(/^Ada Ash and Bo Birch,12 Oak Street,Apartment 4,Corvallis,OR,97330,,3,/);
    expect(out[1]).toContain("A.Ash; B.Birch");
    // Cy is Canadian: the country is written, the postal code kept as typed.
    expect(out[2]).toMatch(/^Cy Cedar,3 Elm Road,,Victoria,BC,V8W 1P6,CANADA,3,C\.Cedar,$/);
    // Then the three with no address, each saying why, in family name order.
    expect(out).toHaveLength(6);
    expect(out[3]).toMatch(/^Di Dale,,,,,,,4,D\.Dale,/);
    expect(out[3]).toContain(notes.noRegistration);
    expect(out[4]).toMatch(/^Ed Elm,,,,,,,5,E\.Elm,/);
    expect(out[4]).toContain(notes.noAddress);
    expect(out[5]).toMatch(/^Flo Fir,,,,,,,6,F\.Fir,/);
    expect(out[5]).toContain(notes.notInAnswer);

    // The record of the download says who and how many, never a name or an address.
    expect(log).toHaveBeenCalledTimes(1);
    const logged = String(log.mock.calls[0]![0]);
    expect(logged).toContain("2 of 5 rows have an address");
    expect(logged).not.toMatch(/Ada|Oak|example/);
    // Nothing was written beside the store.
    expect(await readdir(scratch)).toEqual(before);
  });

  it("refuses a canceled run, a volunteer, and a store with no Ideal Logic key", async () => {
    const { client, fetchRegistrants } = fakeClient();
    const staff = await setup(client);
    expect((await staff.post(`${staff.runPath}/cancel`)).status).toBe(302);
    expect((await staff.post(`${staff.runPath}/addresses.csv`)).status).toBe(409);

    const volunteer = await setup(client, "volunteer");
    expect((await volunteer.post(`${volunteer.runPath}/addresses.csv`)).status).toBe(403);

    const keyless = await setup(null);
    expect((await keyless.post(`${keyless.runPath}/addresses.csv`)).status).toBe(404);
    expect(fetchRegistrants).not.toHaveBeenCalled();
  });

  it("is not fetched by a GET, so a prefetch costs nothing", async () => {
    const { client, fetchRegistrants } = fakeClient();
    const { app, runPath } = await setup(client);
    const res = await app.request(`${runPath}/addresses.csv`);
    expect(res.status).toBe(404);
    expect(fetchRegistrants).not.toHaveBeenCalled();
  });

  it("calls Ideal Logic once for each download, and keeps nothing between them", async () => {
    const { client, fetchRegistrants } = fakeClient();
    const { post, runPath } = await setup(client);
    await post(`${runPath}/addresses.csv`);
    expect(fetchRegistrants).toHaveBeenCalledTimes(1);
    await post(`${runPath}/addresses.csv`);
    expect(fetchRegistrants).toHaveBeenCalledTimes(2);
  });

  it("answers 429 with no file when the day's requests are spent, and 503 when Ideal Logic cannot be reached", async () => {
    const budget = fakeClient({ fail: new IdealLogicError("Today's requests to Ideal Logic are used up.", "budget") });
    const spent = await setup(budget.client);
    const res = await spent.post(`${spent.runPath}/addresses.csv`);
    expect(res.status).toBe(429);
    expect(res.headers.get("content-disposition")).toBeNull();
    const text = await res.text();
    expect(text).toContain("Today's requests to Ideal Logic are used up.");
    expect(text).toContain("41 more requests");
    expect(text).not.toContain("Ada");

    for (const kind of ["unreachable", "refused", "unreadable", "incomplete"] as const) {
      const down = fakeClient({ fail: new IdealLogicError("Ideal Logic failed.", kind) });
      const s = await setup(down.client);
      expect((await s.post(`${s.runPath}/addresses.csv`)).status).toBe(503);
    }
  });

  it("shows the button only where a client is configured", async () => {
    const { client } = fakeClient();
    const withKey = await setup(client);
    const page = await (await withKey.app.request(withKey.runPath)).text();
    expect(page).toContain(`action="${withKey.runPath}/addresses.csv"`);
    expect(page).toContain(en.printRuns.run.addresses.button);

    const without = await setup(null);
    const bare = await (await without.app.request(without.runPath)).text();
    expect(bare).not.toContain("addresses.csv");
  });
});
