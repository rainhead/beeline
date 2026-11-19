import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { en } from "../src/app/messages/en.js";
import { createApp } from "../src/app/server.js";
import type { Kysely, KyselyPlugin } from "kysely";
import { createKysely } from "../src/db.js";
import type { Database } from "../src/model.js";
import { IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { addressRows, needsLookup, runCollectors, type RunCollector } from "../src/app/print-run-addresses.js";
import {
  createIdealLogicClient,
  IdealLogicError,
  RequestBudget,
  type IdealLogicClient,
  type IdealLogicFetch,
  type Registrant,
} from "../src/ideal-logic.js";
import { approveRun, markPrinted, prepareRun, requestReprint } from "../src/print-run.js";
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

/** A client that has 41 requests left, and spends one on each fetch, a failed one too. */
function fakeClient(opts: { fail?: IdealLogicError; registrants?: Registrant[]; hold?: Promise<void> } = {}) {
  let left = 41;
  const fetchRegistrants = vi.fn(async () => {
    left -= 1;
    await opts.hold;
    if (opts.fail) throw opts.fail;
    return opts.registrants ?? REGISTRANTS;
  });
  const client: IdealLogicClient = { fetchRegistrants, remaining: () => left };
  return { client, fetchRegistrants };
}

interface Fixture {
  conn: DuckDBConnection;
  ids: Record<string, number>;
  link: (personId: number, idealLogicId: string) => Promise<unknown>;
}

async function setup(
  client: IdealLogicClient | null,
  who: "staffer" | "volunteer" = "staffer",
  opts: { linked?: boolean; before?: (f: Fixture) => Promise<void>; wrapDb?: (db: Kysely<Database>, f: Fixture) => Kysely<Database> } = {},
) {
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
  if (opts.linked !== false) {
    await link(ids["Ada Ash"]!, "HOUSE-1");
    await link(ids["Bo Birch"]!, "HOUSE-2");
    await link(ids["Cy Cedar"]!, "CAN-1");
    await link(ids["Ed Elm"]!, "NOADDR-1");
    await link(ids["Flo Fir"]!, "GONE-9");
  }
  await opts.before?.({ conn, ids, link });
  const dir = await mkdtemp(join(tmpdir(), "beeline-addresses-"));
  dirs.push(dir);
  const paths = await scratchPaths();
  let asVolunteer = false;
  const app = createApp({
    ...paths,
    db: opts.wrapDb ? opts.wrapDb(createKysely(instance), { conn, ids, link }) : createKysely(instance),
    config: { environment: "sandbox" as const, origin: ORIGIN, idealLogic: client },
    inat: unusedInat,
    resolveSession: async () => ({ personId: asVolunteer ? ids["Ada Ash"]! : staffer, login: "who", iconUrl: null }),
    printConn: conn,
    printRunsDir: dir,
  });
  const post = (path: string, body: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { origin: ORIGIN, ...headers }, body: new URLSearchParams(body) });
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
    // The real errors have no closing full stop; the page adds the punctuation.
    const budget = fakeClient({ fail: new IdealLogicError("Beeline has made 60 requests to Ideal Logic today", "budget") });
    const spent = await setup(budget.client);
    const res = await spent.post(`${spent.runPath}/addresses.csv`);
    expect(res.status).toBe(429);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain(en.printRuns.run.addresses.failedHeading);
    expect(text).toContain("No file was made. Beeline has made 60 requests to Ideal Logic today. Beeline may make 40 more requests");
    expect(text).not.toContain("Ada");
    expect(text).not.toContain("Corvallis");

    for (const kind of ["unreachable", "refused", "unreadable", "incomplete"] as const) {
      const down = fakeClient({ fail: new IdealLogicError("Ideal Logic could not be reached", kind) });
      const s = await setup(down.client);
      const failed = await s.post(`${s.runPath}/addresses.csv`);
      expect(failed.status).toBe(503);
      // No file went out, and the reason is on the page, after the number was spent.
      expect(failed.headers.get("content-type")).toContain("text/html");
      expect(failed.headers.get("content-disposition")).toBeNull();
      expect(await failed.text()).toContain("No file was made. Ideal Logic could not be reached. Beeline may make 40 more requests");
    }
  });

  it("answers a canceled run with the standard page and status 409", async () => {
    const { client } = fakeClient();
    const s = await setup(client);
    await s.post(`${s.runPath}/cancel`);
    const res = await s.post(`${s.runPath}/addresses.csv`);
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain(en.printRuns.run.addresses.canceledNoAddresses);
    expect(text).toContain(en.errorPage.home);
  });

  it("refuses staff who are viewing as somebody else", async () => {
    const { client, fetchRegistrants } = fakeClient();
    const s = await setup(client);
    const res = await s.post(`${s.runPath}/addresses.csv`, {}, { cookie: `${IMPERSONATING_COOKIE}=${encodeURIComponent("Ada Ash")}` });
    expect(res.status).toBe(403);
    expect(fetchRegistrants).not.toHaveBeenCalled();
  });

  it("does not ask Ideal Logic when no collector in the run has a registration", async () => {
    const { client, fetchRegistrants } = fakeClient();
    const s = await setup(client, "staffer", { linked: false });
    const res = await s.post(`${s.runPath}/addresses.csv`);
    expect(res.status).toBe(200);
    expect(fetchRegistrants).not.toHaveBeenCalled();
    const out = lines(await res.text());
    expect(out).toHaveLength(7);
    for (const row of out.slice(1)) expect(row).toContain(en.printRuns.run.addresses.notes.noRegistration);
  });

  it("costs one request when the button is pressed twice at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const asked: string[] = [];
    const fetchImpl: IdealLogicFetch = async (url) => {
      asked.push(url);
      await gate;
      return {
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === "x-numresults" ? "1" : null) },
        text: async () =>
          JSON.stringify([
            {
              id: "HOUSE-1",
              first_name: "Invented",
              last_name: "Person",
              email_address: "house-1@example.org",
              home_address_street: "12 Oak Street",
              home_address_city: "Corvallis",
              home_address_us_state: "OR",
              home_address_postal_code: "97330",
            },
          ]),
      };
    };
    const client = createIdealLogicClient({ key: "k", fetchImpl, budget: new RequestBudget(5) });
    const s = await setup(client);
    // Wait until both requests have reached the client, however long that
    // takes, within a bound; release the held fetch even if the wait fails.
    const reached = vi.spyOn(client, "fetchRegistrants");
    const first = s.post(`${s.runPath}/addresses.csv`);
    const second = s.post(`${s.runPath}/addresses.csv`);
    try {
      await vi.waitFor(() => expect(reached).toHaveBeenCalledTimes(2), { timeout: 5000, interval: 5 });
    } finally {
      release();
    }
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(asked).toHaveLength(1);
    expect(client.remaining()).toBe(4);
  });

  it("refuses with 409 a run canceled while Ideal Logic was being asked", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { client, fetchRegistrants } = fakeClient({ hold });
    const s = await setup(client);
    const pending = s.post(`${s.runPath}/addresses.csv`);
    try {
      await vi.waitFor(() => expect(fetchRegistrants).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 5 });
      expect((await s.post(`${s.runPath}/cancel`)).status).toBe(302);
    } finally {
      release();
    }
    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.text()).toContain(en.printRuns.run.addresses.canceledNoAddresses);
  });

  it("uses the registration link as it is when Ideal Logic answers, not as it was when the request began", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { client, fetchRegistrants } = fakeClient({ hold });
    const s = await setup(client);
    const pending = s.post(`${s.runPath}/addresses.csv`);
    try {
      await vi.waitFor(() => expect(fetchRegistrants).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 5 });
      // Cy is moved from the Victoria registration to the household's.
      await s.conn.run(
        `INSERT INTO person_registration_event (person_id, ideal_logic_id, evidence, decided_by) VALUES (${s.ids["Cy Cedar"]}, 'HOUSE-1', 'staff', 'test')`,
      );
    } finally {
      release();
    }
    const out = lines(await (await pending).text());
    expect(out.some((l) => l.startsWith("Cy Cedar,3 Elm Road"))).toBe(false);
    expect(out[1]).toMatch(/^Ada Ash and Cy Cedar and Bo Birch,12 Oak Street,/);
  });

  it("shows the button only where a client is configured", async () => {
    const { client } = fakeClient();
    const withKey = await setup(client);
    const page = await (await withKey.app.request(withKey.runPath)).text();
    expect(page).toContain(`action="${withKey.runPath}/addresses.csv"`);
    expect(page).toContain(en.printRuns.run.addresses.button);
    expect(page).toContain("drop the leading zero of a ZIP code");

    const without = await setup(null);
    const bare = await (await without.app.request(without.runPath)).text();
    expect(bare).not.toContain("addresses.csv");
  });
});

const notes = en.printRuns.run.addresses.notes;

describe("a row that cannot be delivered", () => {
  it("says what is missing, keeps what is there, and sorts after the complete rows and before those with no address", async () => {
    const extra = [
      registrant("GUS-1", { street: "1 Ash Way", city: null, stateProvince: "OR", postalCode: "97331", country: "USA" }),
      registrant("HAL-1", { street: "2 Beech Way", city: "Salem", stateProvince: null, postalCode: "12345", country: null }),
      registrant("IVY-1", { street: "3 Cedar Way", city: "Iqaluit", stateProvince: null, postalCode: "X0A 0H0", country: "CAN" }),
    ];
    const { client } = fakeClient({ registrants: [...REGISTRANTS, ...extra] });
    const { post, runPath } = await setup(client, "staffer", {
      before: async ({ conn, ids, link }) => {
        const added = [
          ["Gus Gray", "GUS-1"],
          ["Hal Hill", "HAL-1"],
          ["Ivy Ives", "IVY-1"],
        ] as const;
        for (const [i, [name, reg]] of added.entries()) {
          const [given, family] = name.split(" ");
          const [[id]] = (await rows(
            conn,
            `INSERT INTO person (display_name, given_name, family_name) VALUES ('${name}', '${given}', '${family}') RETURNING entity_id`,
          )) as [[number]];
          ids[name] = id;
          await insertCleanSample(conn, { collector_id: String(id), specimen_count: String(7 + i), sample_number: "'1'" });
          await link(id, reg);
        }
      },
    });
    const out = lines(await (await post(`${runPath}/addresses.csv`)).text());
    expect(out.map((l) => l.split(",")[0])).toEqual([
      "Names",
      "Ada Ash and Bo Birch",
      "Cy Cedar",
      "Gus Gray",
      "Hal Hill",
      "Ivy Ives",
      "Di Dale",
      "Ed Elm",
      "Flo Fir",
    ]);
    // The parts that are present stay, so staff can finish the row by hand.
    expect(out[3]).toMatch(/^Gus Gray,1 Ash Way,,,OR,97331,,7,/);
    expect(out[3]).toContain("Incomplete address: no city. Finish it by hand before mailing.");
    expect(out[4]).toMatch(/^Hal Hill,2 Beech Way,,Salem,,12345,,8,/);
    expect(out[4]).toContain("Incomplete address: no state or province, country unknown.");
    // A postal code starting with X names no single province.
    expect(out[5]).toMatch(/^Ivy Ives,3 Cedar Way,,Iqaluit,,X0A 0H0,CANADA,9,/);
    expect(out[5]).toContain("Incomplete address: no state or province.");
  });
});

describe("labels that follow today's primary collector", () => {
  it("marks a collector changed after printing, and counts the labels the file no longer holds", async () => {
    const { client } = fakeClient();
    const { post, runPath, conn, ids } = await setup(client);
    // Di's sample (4 labels) is now Ed's, and Flo's (6 labels) has no collector.
    await conn.run(`UPDATE sample_collector SET person_id = ${ids["Ed Elm"]} WHERE person_id = ${ids["Di Dale"]}`);
    await conn.run(`DELETE FROM sample_collector WHERE person_id = ${ids["Flo Fir"]}`);
    const out = lines(await (await post(`${runPath}/addresses.csv`)).text());
    // Ed now has 5 + 4 labels, printed as two different lines.
    const ed = out.find((l) => l.startsWith("Ed Elm"))!;
    expect(ed).toMatch(/^Ed Elm,,,,,,,9,D\.Dale; E\.Elm,/);
    expect(ed).toContain(notes.collectorLineDiffers);
    expect(out.some((l) => l.startsWith("Di Dale"))).toBe(false);
    expect(out.some((l) => l.startsWith("Flo Fir"))).toBe(false);
    // The last row has no names or address, and says how many labels are missing.
    expect(out.at(-1)).toMatch(/^,,,,,,,6,,/);
    expect(out.at(-1)).toContain(notes.unaccountedLabels(6));
  });

  it("counts a label towards nobody when its sample has two primary collectors, and never writes a negative count", async () => {
    const { client } = fakeClient();
    const { post, runPath, conn, ids } = await setup(client);
    // The store asserts this state cannot arise; build it directly. Di's sample
    // (4 labels) gets a second collector at position 1.
    await conn.run(
      `INSERT INTO sample_collector (sample_id, person_id, position)
       SELECT sample_id, ${ids["Ed Elm"]}, 1 FROM sample_collector WHERE person_id = ${ids["Di Dale"]}`,
    );
    const out = lines(await (await post(`${runPath}/addresses.csv`)).text());
    expect(out.some((l) => l.startsWith("Di Dale"))).toBe(false);
    // Ed has only his own 5 labels, not a share of Di's 4.
    expect(out.find((l) => l.startsWith("Ed Elm"))).toMatch(/^Ed Elm,,,,,,,5,/);
    expect(out.at(-1)).toMatch(/^,,,,,,,4,,/);
    expect(out.at(-1)).toContain(notes.unaccountedLabels(4));
    for (const l of out.slice(1)) expect(l).not.toMatch(/,-\d/);
  });

  it("counts a reprint in a later run once, under the collector of its sample", async () => {
    const { instance, conn } = await createMemoryDb();
    const db = createKysely(instance);
    const person = async (display: string, given: string, family: string) =>
      ((await rows(
        conn,
        `INSERT INTO person (display_name, given_name, family_name) VALUES ('${display}', '${given}', '${family}') RETURNING entity_id`,
      )) as [[number]])[0][0];
    const ash = await person("Ada Ash", "Ada", "Ash");
    const birch = await person("Bo Birch", "Bo", "Birch");
    const at = (day: number) => new Date(`2026-09-2${day}T16:00:00Z`);
    const ashSample = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "2" });
    const first = (await prepareRun(conn, { atlasId: null, personId: ash, now: at(1) }))!.printRunId;
    await approveRun(conn, first, { personId: ash, now: at(1) });
    await markPrinted(conn, first, { personId: ash, now: at(1) });
    await insertCleanSample(conn, { collector_id: String(birch), specimen_count: "1", sample_number: "'7'" });
    const [[second]] = (await rows(conn, `SELECT entity_id FROM specimen WHERE sample_id = ${ashSample} AND specimen_number = 2`)) as [[number]];
    await requestReprint(conn, { specimenId: second }, { personId: ash, now: at(2), reason: "damaged" });
    const run = (await prepareRun(conn, { atlasId: null, personId: ash, now: at(3) }))!;
    expect(run).toMatchObject({ labels: 2, reprints: 1 });

    const found = await runCollectors(db, run.printRunId);
    expect(found.totalLabels).toBe(2);
    expect(found.collectors.map((c) => [c.displayName, c.labels, c.collectorLineDiffers])).toEqual([
      ["Ada Ash", 1, false],
      ["Bo Birch", 1, false],
    ]);
    // Nothing is left out, so there is no row for missing labels.
    expect(addressRows(found, []).map((r) => r.labels)).toEqual([1, 1]);
  });
});

describe("which collectors share a row", () => {
  const collector = (id: number, name: string, ideal: string): RunCollector => ({
    personId: id,
    displayName: name,
    familyName: name.split(" ")[1]!,
    givenName: name.split(" ")[0]!,
    labels: 1,
    printedAs: [],
    idealLogicId: ideal,
    collectorLineDiffers: false,
    keptInLab: false,
  });
  const at = (id: string, city: string | null, postalCode: string | null): Registrant =>
    registrant(id, { street: "5 Pine Street", city, stateProvince: "OR", postalCode, country: "USA" });

  it("keeps the same street in two cities apart when there is no postal code", () => {
    const got = addressRows(
      { collectors: [collector(1, "Ann Ames", "A"), collector(2, "Ben Bell", "B")], totalLabels: 2 },
      [at("A", "Bend", null), at("B", "Burns", null)],
    );
    expect(got.map((r) => r.names)).toEqual([["Ann Ames"], ["Ben Bell"]]);
  });

  it("keeps even the same street and city apart with no postal code, unless it is one registration", () => {
    const apart = addressRows(
      { collectors: [collector(1, "Ann Ames", "A"), collector(2, "Ben Bell", "B")], totalLabels: 2 },
      [at("A", "Bend", null), at("B", "Bend", null)],
    );
    expect(apart).toHaveLength(2);
    const together = addressRows(
      { collectors: [collector(1, "Ann Ames", "A"), collector(2, "Ben Bell", "A")], totalLabels: 2 },
      [at("A", "Bend", null)],
    );
    expect(together.map((r) => r.names)).toEqual([["Ann Ames", "Ben Bell"]]);
  });

  it("keeps the same street and postal code apart when the city differs, and merges when everything agrees", () => {
    const got = addressRows(
      {
        collectors: [collector(1, "Ann Ames", "A"), collector(2, "Ben Bell", "B"), collector(3, "Cal Cox", "C")],
        totalLabels: 3,
      },
      [at("A", "Bend", "97701"), at("B", "Bend ", "97701"), at("C", "Sisters", "97701")],
    );
    expect(got.map((r) => r.names)).toEqual([["Ann Ames", "Ben Bell"], ["Cal Cox"]]);
  });
});

describe("which collectors share a row: spellings and households with no street", () => {
  const collector = (id: number, name: string, ideal: string | null, labels = 1): RunCollector => ({
    personId: id,
    displayName: name,
    familyName: name.split(" ")[1]!,
    givenName: name.split(" ")[0]!,
    labels,
    printedAs: [],
    idealLogicId: ideal,
    collectorLineDiffers: false,
    keptInLab: false,
  });
  const home = (id: string, street: string, city: string, postalCode: string): Registrant =>
    registrant(id, { street, city, stateProvince: "OR", postalCode, country: "USA" });

  it("keeps the boundary between numbers, so 12-14 Oak St and 1214 Oak St are two homes", () => {
    const got = addressRows(
      { collectors: [collector(1, "Ann Ames", "A"), collector(2, "Ben Bell", "B")], totalLabels: 2 },
      [home("A", "12-14 Oak St", "Bend", "97701"), home("B", "1214 Oak St", "Bend", "97701")],
    );
    expect(got.map((r) => r.names)).toEqual([["Ann Ames"], ["Ben Bell"]]);
  });

  it("still joins a street typed with a trailing full stop or another case, and a postal code with or without a space", () => {
    const got = addressRows(
      { collectors: [collector(1, "Ann Ames", "A"), collector(2, "Ben Bell", "B")], totalLabels: 2 },
      [home("A", "12 Oak St.", "Bend", "V8W 1P6"), home("B", "12 OAK st", "bend", "v8w1p6")],
    );
    expect(got.map((r) => r.names)).toEqual([["Ann Ames", "Ben Bell"]]);
  });

  it("gives collectors who share a registration with no street one row, and those with none each their own", () => {
    const got = addressRows(
      {
        collectors: [
          collector(1, "Ann Ames", "N", 2),
          collector(2, "Ben Bell", "N", 3),
          collector(3, "Cal Cox", null, 4),
          collector(4, "Dee Day", null, 5),
        ],
        totalLabels: 14,
      },
      [registrant("N", null)],
    );
    expect(got.map((r) => [r.names, r.labels])).toEqual([
      [["Ann Ames", "Ben Bell"], 5],
      [["Cal Cox"], 4],
      [["Dee Day"], 5],
    ]);
    expect(got[0]!.notes).toEqual([{ code: "noAddress" }]);
    expect(got[1]!.notes).toEqual([{ code: "noRegistration" }]);
  });

  it("never writes a negative count of labels left out", () => {
    const got = addressRows({ collectors: [collector(1, "Ann Ames", null, 5)], totalLabels: 3 }, []);
    expect(got.map((r) => r.labels)).toEqual([5]);
  });
});

describe("labels kept in the lab", () => {
  const notes = en.printRuns.run.addresses.notes;
  const keep = (f: Fixture, name: string) =>
    f.conn.run(`INSERT INTO person_mailing_event (person_id, instruction, decided_by) VALUES (${f.ids[name]}, 'keep_in_lab', 'test')`);

  it("gives each such collector a row of their own, after the incomplete addresses and before those with none", async () => {
    const { client } = fakeClient();
    const s = await setup(client, "staffer", {
      before: async (f) => {
        // Ada and Bo share a home; kept in the lab, they still get a row each.
        await keep(f, "Ada Ash");
        await keep(f, "Bo Birch");
        await keep(f, "Di Dale");
      },
    });
    const out = lines(await (await s.post(`${s.runPath}/addresses.csv`)).text());
    expect(out).toHaveLength(7);
    // Cy is the only home left.
    expect(out[1]).toMatch(/^Cy Cedar,3 Elm Road,/);
    // Then the kept rows, by name: no address, the labels counted, and the line as printed.
    expect(out[2]).toBe(`Ada Ash,,,,,,,1,A.Ash,${notes.keepInLab}`);
    expect(out[3]).toBe(`Bo Birch,,,,,,,2,B.Birch,${notes.keepInLab}`);
    expect(out[4]).toBe(`Di Dale,,,,,,,4,D.Dale,${notes.keepInLab}`);
    // Di has no registration, but being kept in the lab is what the row says; then those with no address.
    expect(out[5]).toMatch(/^Ed Elm,,,,,,,5,E\.Elm,/);
    expect(out[5]).toContain(notes.noAddress);
    expect(out[6]).toMatch(/^Flo Fir,/);
  });

  it("sorts them after an incomplete address", async () => {
    const { client } = fakeClient({
      registrants: [
        registrant("HOUSE-1", { street: "12 Oak Street", city: "Corvallis", stateProvince: "OR", postalCode: "", country: "USA" }),
        ...REGISTRANTS.slice(1),
      ],
    });
    const s = await setup(client, "staffer", { before: (f) => keep(f, "Cy Cedar").then(() => undefined) });
    const out = lines(await (await s.post(`${s.runPath}/addresses.csv`)).text());
    // Bo's address is whole; Ada's has no postal code; then Cy, kept in the lab.
    expect(out[1]).toMatch(/^Bo Birch,/);
    expect(out[2]).toMatch(/^Ada Ash,12 Oak Street,/);
    expect(out[2]).toContain("no postal code");
    const at = out.findIndex((l) => l.startsWith("Cy Cedar,"));
    expect(at).toBe(3);
    expect(out[at + 1]).toMatch(/^Di Dale,/);
  });

  it("does not look up their registration, and does not call Ideal Logic when nobody else has one", async () => {
    const { client, fetchRegistrants } = fakeClient();
    const s = await setup(client, "staffer", {
      before: async (f) => {
        // Every collector with a registration is kept in the lab; Di has none.
        for (const name of ["Ada Ash", "Bo Birch", "Cy Cedar", "Ed Elm", "Flo Fir"]) await keep(f, name);
      },
    });
    const res = await s.post(`${s.runPath}/addresses.csv`);
    expect(res.status).toBe(200);
    expect(fetchRegistrants).not.toHaveBeenCalled();
    const out = lines(await res.text());
    expect(out).toHaveLength(7);
    expect(out.slice(1, 6).every((l) => l.includes(notes.keepInLab))).toBe(true);
    expect(out[6]).toContain(notes.noRegistration);
  });

  it("still asks Ideal Logic when somebody who is mailed has a registration", async () => {
    const { client, fetchRegistrants } = fakeClient();
    const s = await setup(client, "staffer", { before: (f) => keep(f, "Ada Ash").then(() => undefined) });
    await s.post(`${s.runPath}/addresses.csv`);
    expect(fetchRegistrants).toHaveBeenCalledTimes(1);
  });

  it("asks Ideal Logic when a collector is switched back to mail after the first check and before the collectors are read", async () => {
    const { client, fetchRegistrants } = fakeClient();
    let switched = false;
    const s = await setup(client, "staffer", {
      before: async (f) => {
        for (const name of ["Ada Ash", "Bo Birch", "Cy Cedar", "Ed Elm", "Flo Fir"]) await keep(f, name);
      },
      // The first check is the one query that reads person_mailing_instruction
      // with LIMIT 1. Once its answer is back, staff switch Cy to mail.
      wrapDb: (db, f) => {
        const ids = new Set<string>();
        const plugin: KyselyPlugin = {
          transformQuery: ({ node, queryId }) => {
            const text = JSON.stringify(node);
            if (!switched && text.includes("person_mailing_instruction") && text.includes("LIMIT 1")) ids.add(queryId.queryId);
            return node;
          },
          transformResult: async ({ result, queryId }) => {
            if (ids.has(queryId.queryId) && !switched) {
              switched = true;
              await f.conn.run(`INSERT INTO person_mailing_event (person_id, instruction, decided_by) VALUES (${f.ids["Cy Cedar"]}, 'mail', 'test')`);
            }
            return result;
          },
        };
        return db.withPlugin(plugin);
      },
    });
    const res = await s.post(`${s.runPath}/addresses.csv`);
    expect(res.status).toBe(200);
    expect(switched).toBe(true);
    expect(fetchRegistrants).toHaveBeenCalledTimes(1);
    const out = lines(await res.text());
    expect(out.some((l) => l.startsWith("Cy Cedar,3 Elm Road,"))).toBe(true);
    expect(out.join("\n")).not.toContain(notes.notInAnswer);
  });

  it("decides from the collectors whether anybody needs looking up", () => {
    const c = (idealLogicId: string | null, keptInLab: boolean) => ({ keptInLab, idealLogicId }) as RunCollector;
    expect(needsLookup({ collectors: [c("A", true), c(null, false)], totalLabels: 2 })).toBe(false);
    expect(needsLookup({ collectors: [c("A", true), c("B", false)], totalLabels: 2 })).toBe(true);
  });

  it("puts a collector back among the addresses once they are mailed again", async () => {
    const { client } = fakeClient();
    const s = await setup(client, "staffer", {
      before: async (f) => {
        await keep(f, "Cy Cedar");
        await f.conn.run(`INSERT INTO person_mailing_event (person_id, instruction, decided_by) VALUES (${f.ids["Cy Cedar"]}, 'mail', 'test')`);
      },
    });
    const out = lines(await (await s.post(`${s.runPath}/addresses.csv`)).text());
    expect(out[2]).toMatch(/^Cy Cedar,3 Elm Road,/);
    expect(out.join("\n")).not.toContain(notes.keepInLab);
  });

  describe("in the rows", () => {
    const collector = (id: number, name: string, ideal: string | null, keptInLab: RunCollector["keptInLab"]): RunCollector => ({
      personId: id,
      displayName: name,
      familyName: name.split(" ")[1]!,
      givenName: name.split(" ")[0]!,
      labels: 2,
      printedAs: [`${name[0]}.${name.split(" ")[1]}`],
      idealLogicId: ideal,
      collectorLineDiffers: false,
      keptInLab,
    });

    it("never puts two people kept in the lab in one row, even on one registration", () => {
      const got = addressRows(
        {
          collectors: [collector(1, "Ann Ames", "A", true), collector(2, "Ben Bell", "A", true)],
          totalLabels: 4,
        },
        [registrant("A", { street: "5 Pine Street", city: "Bend", stateProvince: "OR", postalCode: "97701", country: "USA" })],
      );
      expect(got.map((r) => [r.names, r.labels, r.hasAddress, r.line1])).toEqual([
        [["Ann Ames"], 2, false, ""],
        [["Ben Bell"], 2, false, ""],
      ]);
      expect(got[1]!.notes).toEqual([{ code: "keepInLab" }]);
    });

    it("does not read a registration for them, so one that Ideal Logic did not return is no fault", () => {
      const got = addressRows({ collectors: [collector(1, "Ann Ames", "MISSING", true)], totalLabels: 2 }, []);
      expect(got).toHaveLength(1);
      expect(got[0]!.notes).toEqual([{ code: "keepInLab" }]);
    });
  });
});
