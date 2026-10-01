import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import {
  addSpecimensToBatch,
  addToBatch,
  batchRows,
  entrySeasons,
  entryTaxa,
  forgetEntryTaxa,
  removeFromBatch,
  saveDrafts,
  seasonRows,
  UnknownTaxon,
  UnreachableSpecimens,
} from "../src/app/determine.js";
import { commitDeterminationDrafts } from "../src/commit-determinations.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { en } from "../src/app/messages/en.js";

/**
 * Volunteers naming their own specimens (beeline-bcq). What matters here is
 * the boundary: a draft is changeable and invisible, and only the overnight
 * commit makes a determination — and the reach rule, since every write names
 * specimens by id and an id is easy to type.
 */

type Conn = Awaited<ReturnType<typeof createMemoryDb>>["conn"];

const one = async (conn: Conn, query: string): Promise<number> => {
  const [[id]] = (await (await conn.run(query)).getRows()) as [[number]];
  return id;
};

const person = (conn: Conn, name: string) =>
  one(conn, `INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`);

async function fixture() {
  const { instance, conn } = await createMemoryDb();
  const ada = await person(conn, "Ada Adams");
  const bo = await person(conn, "Bo Barnes");
  const gil = await person(conn, "Gil Garcia");

  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Apidae'), ('family', 'Andrenidae'), ('family', 'Vespidae')`);
  const family = (name: string) => `(SELECT entity_id FROM animal WHERE scientific_name = '${name}')`;
  await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) VALUES
    ('genus', 'Bombus', ${family("Apidae")}), ('genus', 'Apis', ${family("Apidae")}),
    ('genus', 'Andrena', ${family("Andrenidae")}), ('genus', 'Vespula', ${family("Vespidae")})`);
  await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) VALUES
    ('species', 'Bombus vosnesenskii', ${family("Bombus")}),
    ('species', 'Bombus flavidus', ${family("Bombus")}),
    ('species', 'Apis mellifera', ${family("Apis")})`);
  const animal = async (name: string) => one(conn, `SELECT entity_id FROM animal WHERE scientific_name = '${name}'`);

  // Ada's 2026 sample, her 2024 one (seven-digit numbers, as they were),
  // a February sample that belongs to 2025's season, and Bo's.
  const ada26 = await insertCleanSample(conn, { collector_id: String(ada), sample_number: "'1'", date_start: "DATE '2026-07-14'", date_end: "DATE '2026-07-14'" });
  const ada24 = await insertCleanSample(conn, { collector_id: String(ada), sample_number: "'7'", date_start: "DATE '2024-06-01'", date_end: "DATE '2024-06-01'" });
  const adaFeb = await insertCleanSample(conn, { collector_id: String(ada), sample_number: "'2'", date_start: "DATE '2026-02-10'", date_end: "DATE '2026-02-10'" });
  const bo26 = await insertCleanSample(conn, { collector_id: String(bo), sample_number: "'1'" });
  await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES
    (${ada26}, 1, '26000101'), (${ada26}, 2, '26000102'), (${ada26}, 3, '26000103'),
    (${ada24}, 1, '2400555'), (${adaFeb}, 1, '25000900'), (${bo26}, 1, '26000201')`);
  const spec = async (n: string) => one(conn, `SELECT entity_id FROM specimen WHERE field_number = '${n}'`);

  // 26000102 already has Ada's own genus and an expert's species; the
  // expert's must not reach the entry screen.
  await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_id, verbatim_identification, sex, recorded_at)
    VALUES (${await spec("26000102")}, ${await animal("Bombus")}, false, 'in_app', ${ada}, 'Bombus', 'female', TIMESTAMPTZ '2026-08-01 10:00:00Z'),
           (${await spec("26000102")}, ${await animal("Bombus vosnesenskii")}, true, 'ecdysis_import', NULL, 'Bombus vosnesenskii', 'female', TIMESTAMPTZ '2026-09-01 10:00:00Z')`);

  forgetEntryTaxa();
  return { db: createKysely(instance), conn, ada, bo, gil, animal, spec, ada26, bo26 };
}

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

/** The app, signed in as Ada — or as Gil, an admin, who may view Beeline as her. */
async function appFixture(as: "ada" | "gil" = "ada") {
  const f = await fixture();
  await f.conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (${f.gil}, 'peter')`);
  const people = { ada: f.ada, gil: f.gil };
  const app = createApp({
    db: f.db,
    // Sandbox: development makes everyone an admin.
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: people[as], login: as, iconUrl: null }),
  });
  const json = (path: string, body: unknown, cookie?: string) =>
    app.request(path, {
      method: "POST",
      headers: { origin: "http://localhost:3054", "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  return { ...f, app, json };
}

describe("which taxa have castes", () => {
  it("follows the nearest stated ancestor, so cuckoo bumble bees have none", async () => {
    const { conn } = await fixture();
    const castes = await rows(
      conn,
      `SELECT a.scientific_name, c.has_castes FROM animal_castes c JOIN animal a ON a.entity_id = c.animal_id ORDER BY 1`,
    );
    expect(Object.fromEntries(castes as [string, boolean][])).toMatchObject({
      Bombus: true,
      "Bombus vosnesenskii": true,
      "Bombus flavidus": false,
      Apis: true,
      "Apis mellifera": true,
      Andrena: false,
      Vespula: false,
    });
  });
});

describe("seasons", () => {
  it("count a February sample in the previous season, and count only volunteer names as named", async () => {
    const { db, ada } = await fixture();
    expect(await entrySeasons(db, ada, ada)).toEqual([
      { season: 2026, specimens: 3, unnamed: 2 },
      { season: 2025, specimens: 1, unnamed: 1 },
      { season: 2024, specimens: 1, unnamed: 1 },
    ]);
  });
});

describe("the rows", () => {
  it("are the person's own, in collecting order, with their earlier name and never the expert's", async () => {
    const { db, ada, animal } = await fixture();
    const season = await seasonRows(db, ada, ada, 2026);
    expect(season.map((r) => r.fieldNumber)).toEqual(["26000101", "26000102", "26000103"]);
    expect(season[1]!.prior).toMatchObject({ animalId: await animal("Bombus"), sex: "female", channel: "in_app" });
  });
});

describe("drafts", () => {
  it("normalise sex against the taxon: a male bumble bee is a drone, and only social bees keep a caste", async () => {
    const { db, ada, animal, spec } = await fixture();
    const [a, b, c] = [await spec("26000101"), await spec("26000103"), await spec("2400555")];
    const saved = await saveDrafts(db, ada, ada, [
      { specimenId: a, animalId: await animal("Bombus vosnesenskii"), sex: "male", caste: null },
      { specimenId: b, animalId: await animal("Bombus flavidus"), sex: "female", caste: "worker" },
      { specimenId: c, animalId: await animal("Andrena"), sex: "female", caste: "gyne" },
    ]);
    const by = new Map(saved.map((r) => [r.id, r.draft]));
    expect(by.get(a)).toMatchObject({ sex: "male", caste: "drone" });
    expect(by.get(b)).toMatchObject({ sex: "female", caste: null });
    expect(by.get(c)).toMatchObject({ sex: "female", caste: null });
  });

  it("are replaced, not added to, and vanish when they say what was already said", async () => {
    const { db, ada, animal, spec } = await fixture();
    const s = await spec("26000102");
    await saveDrafts(db, ada, ada, [{ specimenId: s, animalId: await animal("Bombus vosnesenskii"), sex: "female", caste: "worker" }]);
    const [changed] = await saveDrafts(db, ada, ada, [{ specimenId: s, animalId: await animal("Apis mellifera"), sex: "female", caste: "worker" }]);
    expect(changed!.draft).toMatchObject({ animalId: await animal("Apis mellifera") });
    // Back to what her determination already says: nothing to keep.
    const [back] = await saveDrafts(db, ada, ada, [{ specimenId: s, animalId: await animal("Bombus"), sex: "female", caste: null }]);
    expect(back!.draft).toBeNull();
  });

  it("refuse somebody else's specimen", async () => {
    const { db, ada, animal, spec } = await fixture();
    await expect(
      saveDrafts(db, ada, ada, [{ specimenId: await spec("26000201"), animalId: await animal("Bombus"), sex: null, caste: null }]),
    ).rejects.toBeInstanceOf(UnreachableSpecimens);
  });

  it("refuse a taxon that does not exist", async () => {
    const { db, ada, spec } = await fixture();
    await expect(saveDrafts(db, ada, ada, [{ specimenId: await spec("26000101"), animalId: 999999, sex: null, caste: null }])).rejects.toBeInstanceOf(
      UnknownTaxon,
    );
  });

  it("belong to whoever is signed in, while reach follows whoever they act for", async () => {
    const { db, conn, ada, gil, animal, spec } = await fixture();
    await saveDrafts(db, ada, gil, [{ specimenId: await spec("26000101"), animalId: await animal("Bombus"), sex: null, caste: null }]);
    expect(await rows(conn, `SELECT determiner_id FROM determination_draft`)).toEqual([[gil]]);
    expect((await seasonRows(db, ada, ada, 2026))[0]!.draft).toBeNull();
  });
});

describe("the batch", () => {
  it("takes numbers from any season, in the order given, and says what it could not find", async () => {
    const { db, ada } = await fixture();
    const result = await addToBatch(db, ada, ada, "26000103, 2400555\n101, 26000201, 999");
    expect(result.added).toBe(3);
    expect(result.entries.map((e) => [e.text, e.found, e.problem?.code ?? null])).toEqual([
      ["26000103", 1, null],
      ["2400555", 1, null],
      ["26000101", 1, null],
      ["26000201", 0, "notTheirs"], // Bo's: not hers to find
      ["999", 0, "notTheirs"],
    ]);
    expect((await batchRows(db, ada, ada)).map((r) => r.fieldNumber)).toEqual(["26000103", "2400555", "26000101"]);
  });

  it("does not add a number twice, and counts it as already there", async () => {
    const { db, ada } = await fixture();
    await addToBatch(db, ada, ada, "26000101-103");
    const again = await addToBatch(db, ada, ada, "26000102");
    expect([again.added, again.already]).toEqual([0, 1]);
    expect((await batchRows(db, ada, ada)).map((r) => r.fieldNumber)).toEqual(["26000101", "26000102", "26000103"]);
  });

  it("appends ticked rows after typed ones, and loses rows on request", async () => {
    const { db, ada, spec } = await fixture();
    await addToBatch(db, ada, ada, "26000103");
    await addSpecimensToBatch(db, ada, ada, [await spec("25000900"), await spec("26000103")]);
    expect((await batchRows(db, ada, ada)).map((r) => r.fieldNumber)).toEqual(["26000103", "25000900"]);
    await removeFromBatch(db, ada, [await spec("26000103")]);
    expect((await batchRows(db, ada, ada)).map((r) => r.fieldNumber)).toEqual(["25000900"]);
    await removeFromBatch(db, ada, "all");
    expect(await batchRows(db, ada, ada)).toEqual([]);
  });
});

describe("the overnight commit", () => {
  it("turns drafts into in_app determinations credited to their determiner, and leaves only what cannot be one", async () => {
    const { db, conn, ada, gil, animal, spec } = await fixture();
    await saveDrafts(db, ada, gil, [
      { specimenId: await spec("26000101"), animalId: await animal("Bombus vosnesenskii"), sex: "female", caste: "worker" },
      // A sex with no name yet: waits.
      { specimenId: await spec("26000103"), animalId: null, sex: "male", caste: null },
    ]);
    const counts = await commitDeterminationDrafts(conn);
    expect(counts).toEqual({ committed: 1, unchanged: 0, waiting: 1 });
    const made = await rows(
      conn,
      `SELECT channel, is_expert, determiner_id, verbatim_identification, sex, caste, determined_on IS NOT NULL
       FROM determination WHERE specimen_id = ${await spec("26000101")}`,
    );
    expect(made).toEqual([["in_app", false, gil, "Bombus vosnesenskii", "female", "worker", true]]);
    expect(await rows(conn, `SELECT specimen_id FROM determination_draft`)).toEqual([[await spec("26000103")]]);
  });

  it("records nothing for a draft that matches the newest volunteer determination", async () => {
    const { conn, ada, animal, spec } = await fixture();
    // Written directly: saveDrafts would already have dropped it.
    await conn.run(`INSERT INTO determination_draft (specimen_id, determiner_id, animal_id, sex)
      VALUES (${await spec("26000102")}, ${ada}, ${await animal("Bombus")}, 'female')`);
    expect(await commitDeterminationDrafts(conn)).toEqual({ committed: 0, unchanged: 1, waiting: 0 });
    expect(await rows(conn, `SELECT count(*) FROM determination WHERE channel = 'in_app'`)).toEqual([[1n]]);
  });

  it("makes the volunteer's name the record where no expert has spoken, and never over one", async () => {
    const { db, conn, ada, animal, spec } = await fixture();
    await saveDrafts(db, ada, ada, [
      { specimenId: await spec("26000101"), animalId: await animal("Andrena"), sex: "female", caste: null },
      { specimenId: await spec("26000102"), animalId: await animal("Apis mellifera"), sex: "female", caste: "worker" },
    ]);
    await commitDeterminationDrafts(conn);
    const record = await rows(
      conn,
      `SELECT sp.field_number, a.scientific_name FROM determination_of_record r
       JOIN specimen sp ON sp.entity_id = r.specimen_id JOIN animal a ON a.entity_id = r.animal_id ORDER BY 1`,
    );
    expect(record).toEqual([
      ["26000101", "Andrena"],
      ["26000102", "Bombus vosnesenskii"],
    ]);
  });
});

describe("the names offered", () => {
  it("leave out the scaffolding, mark bees and castes, and count uses", async () => {
    const { db } = await fixture();
    const taxa = await entryTaxa(db);
    const by = new Map(taxa.map((t) => [t.name, t]));
    expect(by.get("Bombus vosnesenskii")).toMatchObject({ bee: true, castes: true, family: "Apidae", uses: 1 });
    expect(by.get("Vespula")).toMatchObject({ bee: false, castes: false });
    expect(by.get("Bombus flavidus")).toMatchObject({ castes: false });
  });
});

describe("the page and its endpoints", () => {
  it("shows a volunteer their own specimens and their own earlier names, never an expert's", async () => {
    const { app } = await appFixture();
    const res = await app.request("/determinations");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<determine-grid");
    expect(body).toContain("26000101");
    expect(body).not.toContain("26000201"); // Bo's
    expect(body).toContain(en.determine.seasonOption(2026, 2));
    // 26000102's expert species must not reach the screen, by name or by id.
    expect(body).not.toContain("Bombus vosnesenskii");
  });

  it("saves a draft for the person signed in, and answers someone else's specimen as missing", async () => {
    const { json, animal, spec } = await appFixture();
    const ok = await json("/determinations/drafts", { writes: [{ specimenId: await spec("26000101"), animalId: await animal("Bombus"), sex: "male" }] });
    expect(ok.status).toBe(200);
    const { rows: saved } = (await ok.json()) as { rows: { draft: { caste: string } | null }[] };
    expect(saved[0]!.draft).toMatchObject({ caste: "drone" });
    const theirs = await json("/determinations/drafts", { writes: [{ specimenId: await spec("26000201"), animalId: await animal("Bombus") }] });
    expect(theirs.status).toBe(404);
  });

  it("adds typed numbers to the batch and returns it", async () => {
    const { app, json } = await appFixture();
    const res = await json("/determinations/batch", { add: "26000103, 2400555" });
    const out = (await res.json()) as { rows: { fieldNumber: string }[]; addition: { added: number } };
    expect(out.addition.added).toBe(2);
    expect(out.rows.map((r) => r.fieldNumber)).toEqual(["26000103", "2400555"]);
    expect(await (await app.request("/determinations?view=batch")).text()).toContain(en.determine.mode.batch(2));
  });

  it("lets staff viewing as a volunteer look but not save", async () => {
    const { app, json, animal, spec } = await appFixture("gil");
    const cookie = `${IMPERSONATING_COOKIE}=${encodeURIComponent("Ada Adams")}`;
    const page = await (await app.request("/determinations", { headers: { cookie } })).text();
    expect(page).toContain(en.determine.readOnly.replaceAll("'", "&#39;"));
    expect(page).toContain("26000101");
    const write = await json("/determinations/drafts", { writes: [{ specimenId: await spec("26000101"), animalId: await animal("Bombus") }] }, cookie);
    expect(write.status).toBe(403);
    expect((await json("/determinations/batch", { add: "26000101" }, cookie)).status).toBe(403);
  });

  it("answers a malformed body as the client's error, not the server's", async () => {
    const { app, json } = await appFixture();
    const raw = (path: string, body: string) =>
      app.request(path, { method: "POST", headers: { origin: "http://localhost:3054", "content-type": "application/json" }, body });
    expect((await raw("/determinations/drafts", "not json")).status).toBe(400);
    expect((await raw("/determinations/batch", "[1, 2]")).status).toBe(400);
    expect((await json("/determinations/drafts", { writes: "all of them" })).status).toBe(400);
    expect((await json("/determinations/drafts", { writes: [null] })).status).toBe(400);
    expect((await json("/determinations/drafts", { writes: [{ specimenId: "abc" }] })).status).toBe(400);
  });
});
