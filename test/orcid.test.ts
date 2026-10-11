import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { identificationsOf } from "../src/app/dwc-archive.js";
import { EMPTY_QUERY, ALL, listSpecimens, specimenCsvRow, SPECIMEN_CSV_HEADER } from "../src/app/listings.js";
import { createApp } from "../src/app/server.js";
import { applyPersonOverlay } from "../src/apply-person-overlay.js";
import { createKysely } from "../src/db.js";
import { fetchInatOrcids } from "../src/fetch-inat-orcids.js";
import { loadOrcids, orcidRows } from "../src/load-orcids.js";
import { orcidUrl, parseOrcid } from "../src/orcid.js";
import { readChanges } from "../src/person-change.js";
import { readOverlay, valueProblem, type PersonOverlayRow } from "../src/person-overlay.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

// ORCID's own documented examples (support.orcid.org, "Structure of the ORCID
// identifier"), and two more made with the same check digit. Synthetic: none
// of them is anybody in Beeline.
const CARBERRY = "0000-0002-1825-0097";
const SECOND = "0000-0001-5109-3700";
const ENDS_IN_X = "0000-0002-1694-233X";
const FOURTH = "0000-0003-0000-0011";

describe("parsing an ORCID iD", () => {
  it("takes the bare iD and the URL forms people paste, and gives the bare iD", () => {
    expect(parseOrcid(CARBERRY)).toBe(CARBERRY);
    expect(parseOrcid(`https://orcid.org/${CARBERRY}`)).toBe(CARBERRY);
    expect(parseOrcid(`orcid.org/${CARBERRY}/`)).toBe(CARBERRY);
    expect(parseOrcid(`  http://www.orcid.org/${CARBERRY} `)).toBe(CARBERRY);
    // A check digit of ten is written X, and a lowercase one means the same.
    expect(parseOrcid(ENDS_IN_X.toLowerCase())).toBe(ENDS_IN_X);
  });

  it("refuses a typo, which the check digit catches, and anything not shaped like an iD", () => {
    expect(parseOrcid("0000-0002-1825-0098")).toBeNull();
    expect(parseOrcid("0000-0002-1852-0097")).toBeNull();
    expect(parseOrcid("0000000218250097")).toBeNull();
    expect(parseOrcid("https://example.org/0000-0002-1825-0097")).toBeNull();
    expect(parseOrcid("")).toBeNull();
  });

  it("is written out as the URL ORCID asks for", () => {
    expect(orcidUrl(CARBERRY)).toBe(`https://orcid.org/${CARBERRY}`);
  });
});

/** Ada has an iNaturalist account; Bo has none; Cy has one too. */
async function store() {
  const { instance, conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Ada Collector'), (2, 'Bo Netter'), (3, 'Cy Keyer')`);
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (1, 111, 'ada'), (3, 333, 'cy')`);
  return { instance, conn, db: createKysely(instance) };
}

const decision = (person_ref: string, value: string): PersonOverlayRow => ({
  person_ref,
  field: "orcid",
  value,
  author: "staffer",
  reason: "they gave it",
});

describe("an ORCID iD staff record", () => {
  it("is an overlay field whose value is the bare iD or nothing", () => {
    expect(valueProblem("orcid", CARBERRY)).toBeNull();
    expect(valueProblem("orcid", "")).toBeNull();
    // Normalised before it is written, so the file has one spelling per iD.
    expect(valueProblem("orcid", orcidUrl(CARBERRY))).not.toBeNull();
    expect(valueProblem("orcid", "0000-0002-1825-0098")).not.toBeNull();
  });

  it("is applied, replaced, and cleared", async () => {
    const { conn } = await store();
    expect((await applyPersonOverlay(conn, [decision("name:Bo Netter", CARBERRY)])).unresolved).toEqual([]);
    expect(await rows(conn, `SELECT person_id, orcid FROM person_orcid`)).toEqual([[2, CARBERRY]]);
    await applyPersonOverlay(conn, [decision("name:Bo Netter", SECOND)]);
    expect(await rows(conn, `SELECT person_id, orcid FROM person_orcid`)).toEqual([[2, SECOND]]);
    await applyPersonOverlay(conn, [decision("name:Bo Netter", "")]);
    expect(await rows(conn, `SELECT count(*) FROM person_orcid`)).toEqual([[0n]]);
  });

  it("is refused for a second person rather than moved", async () => {
    const { conn } = await store();
    await applyPersonOverlay(conn, [decision("name:Bo Netter", CARBERRY)]);
    const second = await applyPersonOverlay(conn, [decision("name:Ada Collector", CARBERRY)]);
    expect(second.unresolved.map((u) => u.reason)).toEqual([`ORCID ${CARBERRY} is already recorded for person 2`]);
    expect(await rows(conn, `SELECT person_id FROM person_orcid`)).toEqual([[2]]);
  });
});

describe("the ORCID iD of record", () => {
  it("is the iNaturalist account's where it has one, and staff's otherwise", async () => {
    const { conn } = await store();
    await applyPersonOverlay(conn, [decision("name:Ada Collector", SECOND), decision("name:Bo Netter", CARBERRY)]);
    await conn.run(`INSERT INTO inat_user_orcid (inat_user_id, orcid) VALUES (111, '${ENDS_IN_X}')`);
    expect(await rows(conn, `SELECT person_id, orcid, source FROM person_orcid_of_record ORDER BY person_id`)).toEqual([
      [1, ENDS_IN_X, "inaturalist"],
      [2, CARBERRY, "staff"],
    ]);
    expect(await rows(conn, `SELECT count(*) FROM person_orcid_shared`)).toEqual([[0n]]);
  });

  it("names an iD that would credit two people", async () => {
    const { conn } = await store();
    // A household's login, connected to the partner's ORCID: staff gave Bo
    // the iD that Cy's account reports.
    await applyPersonOverlay(conn, [decision("name:Bo Netter", FOURTH)]);
    await conn.run(`INSERT INTO inat_user_orcid (inat_user_id, orcid) VALUES (333, '${FOURTH}')`);
    expect(await rows(conn, `SELECT person_id, source FROM person_orcid_shared ORDER BY person_id`)).toEqual([
      [2, "staff"],
      [3, "inaturalist"],
    ]);
  });
});

describe("the records an ORCID iD credits", () => {
  it("writes recordedByID for the collectors who have one and identifiedByID for the determiner", async () => {
    const { conn, db } = await store();
    const sample = await insertCleanSample(conn, { collector_id: "1" });
    await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${sample}, 2, 2), (${sample}, 3, 3)`);
    await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('genus', 'Bombus')`);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, 1, '26000001')`);
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_id, recorded_at)
       SELECT sp.entity_id, an.entity_id, true, 'legacy_import', 2, TIMESTAMPTZ '2026-08-01 00:00:00+00'
       FROM specimen sp, animal an`,
    );
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, determiner_name, verbatim_identification, recorded_at)
       SELECT sp.entity_id, an.entity_id, true, 'ecdysis_import', 'Known Only By Name', 'Bombus', TIMESTAMPTZ '2026-09-01 00:00:00+00'
       FROM specimen sp, animal an`,
    );
    // Ada through iNaturalist, Bo through staff, Cy with neither.
    await conn.run(`INSERT INTO inat_user_orcid (inat_user_id, orcid) VALUES (111, '${SECOND}')`);
    await applyPersonOverlay(conn, [decision("name:Bo Netter", CARBERRY)]);

    const page = await listSpecimens(db, { ...EMPTY_QUERY, scope: ALL }, 1);
    const csv = Object.fromEntries(SPECIMEN_CSV_HEADER.map((h, i) => [h, specimenCsvRow(page.rows[0]!, page)[i]]));
    expect(csv.recordedBy).toBe("Ada Collector | Bo Netter | Cy Keyer");
    expect(csv.recordedByID).toBe(`https://orcid.org/${SECOND} | https://orcid.org/${CARBERRY}`);
    // The record is the newer determination, by a name with no person behind it.
    expect(csv.identifiedBy).toBe("Known Only By Name");
    expect(csv.identifiedByID).toBeNull();

    const history = await identificationsOf(db, [page.rows[0]!.specimen_id]);
    expect(history.map((h) => [h.determiner, h.determiner_orcid])).toEqual([
      ["Bo Netter", CARBERRY],
      ["Known Only By Name", null],
    ]);
  });
});

describe("fetching what iNaturalist says", () => {
  it("asks in bulk, then one at a time for accounts with no observations, and keeps what it was not told", async () => {
    const { conn } = await store();
    await conn.run(`INSERT INTO person (entity_id, display_name) VALUES (4, 'Di Gone'), (5, 'Ed Flaky')`);
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (4, 444, 'di'), (5, 555, 'ed')`);
    // Cy disconnected an ORCID since it was last seen; Ed's will not be asked about successfully.
    await conn.run(`INSERT INTO inat_user_orcid (inat_user_id, orcid) VALUES (333, '${FOURTH}'), (555, '${SECOND}')`);
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url.replace("https://api.test/v1", ""));
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes("/observations/observers")) {
        return json({
          results: [
            { user: { id: 111, orcid: `https://orcid.org/${CARBERRY}` } },
            { user: { id: 333, orcid: null } },
          ],
        });
      }
      if (url.endsWith("/users/444")) return new Response("", { status: 404 });
      if (url.endsWith("/users/555")) return new Response("", { status: 503 });
      return new Response("", { status: 500 });
    }) as typeof fetch;

    await expect(fetchInatOrcids(conn, { fetchImpl, apiBase: "https://api.test/v1", requestDelayMs: 0 })).rejects.toThrow(
      /HTTP 503/,
    );
    // A failed request fails the run and changes nothing.
    expect(await rows(conn, `SELECT inat_user_id, orcid FROM inat_user_orcid ORDER BY 1`)).toEqual([
      [333n, FOURTH],
      [555n, SECOND],
    ]);

    asked.length = 0;
    const ok = (async (input: string | URL | Request) =>
      String(input).endsWith("/users/555")
        ? new Response(JSON.stringify({ results: [{ id: 555, orcid: null }] }), { status: 200 })
        : fetchImpl(input)) as typeof fetch;
    const result = await fetchInatOrcids(conn, { fetchImpl: ok, apiBase: "https://api.test/v1", requestDelayMs: 0 });
    expect(asked).toEqual(["/observations/observers?user_id=111,333,444,555&per_page=100", "/users/444"]);
    expect(result).toEqual({ accounts: 4, answered: 4, withOrcid: 1, requests: 3 });
    expect(await rows(conn, `SELECT inat_user_id, orcid FROM inat_user_orcid`)).toEqual([[111n, CARBERRY]]);
  });
});

describe("loading confirmed iDs from a file", () => {
  const FILE = [
    "display_name,orcid,confirmed_by,confirmed_on,how",
    `Bo Netter,https://orcid.org/${CARBERRY},Staff Person,2026-10-10,they gave it`,
    `Cy Keyer,${SECOND},Staff Person,2026-10-10,name search; confirmed by email`,
  ].join("\n");

  it("refuses the whole file for any one problem, and names every problem", () => {
    const bad = `${FILE}\nAda Collector,0000-0002-1825-0098,Staff Person,,typo\nNo Body,${CARBERRY},,,`;
    expect(orcidRows(bad).problems).toEqual([
      "line 4: '0000-0002-1825-0098' is not an ORCID iD",
      "line 5: no confirmed_by — somebody has to have confirmed it",
      `line 5: ${CARBERRY} is also given to Bo Netter`,
    ]);
  });

  it("writes each as the page would, applies it, and files it in the person's history under who confirmed it", async () => {
    const { conn } = await store();
    const dir = await mkdtemp(join(tmpdir(), "orcids-"));
    const overlay = join(dir, "person-overlay.csv");
    const changeLog = join(dir, "person-change.csv");
    const { rows: decisions, problems } = orcidRows(FILE);
    expect(problems).toEqual([]);
    const result = await loadOrcids(conn, decisions, { overlay, changeLog });
    expect(result).toEqual({ recorded: 2, unresolved: [], personChangesRecorded: 2 });
    expect((await readOverlay(overlay)).map((r) => [r.person_ref, r.field, r.value, r.author, r.reason])).toEqual([
      ["name:Bo Netter", "orcid", CARBERRY, "Staff Person", "they gave it (2026-10-10)"],
      ["name:Cy Keyer", "orcid", SECOND, "Staff Person", "name search; confirmed by email (2026-10-10)"],
    ]);
    expect((await readChanges(changeLog)).map((c) => [c.person_ref, c.field, c.new_value, c.source, c.author])).toEqual([
      ["name:Bo Netter", "orcid", CARBERRY, "app", "Staff Person"],
      ["name:Cy Keyer", "orcid", SECOND, "app", "Staff Person"],
    ]);
  });

  it("writes nothing when a name reaches nobody or an iD is already somebody else's", async () => {
    const { conn } = await store();
    await applyPersonOverlay(conn, [decision("name:Ada Collector", SECOND)]);
    const dir = await mkdtemp(join(tmpdir(), "orcids-"));
    const overlay = join(dir, "person-overlay.csv");
    const { rows: decisions } = orcidRows(`${FILE}\nNo Body,${FOURTH},Staff Person,,x`);
    expect(await loadOrcids(conn, decisions, { overlay, changeLog: null })).toEqual({
      problems: [`${SECOND} is already recorded for Ada Collector`, "no person named 'No Body'"],
    });
    await expect(readFile(overlay, "utf8")).rejects.toThrow(/ENOENT/);
  });
});

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

async function personPage() {
  const { conn, db } = await store();
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (2)`);
  const dir = await mkdtemp(join(tmpdir(), "orcid-page-"));
  const overlayPath = join(dir, "person-overlay.csv");
  await writeFile(overlayPath, "person_ref,field,value,author,reason\n");
  const app = createApp({
    db,
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: 2, login: "bonetter", iconUrl: null }),
    personOverlayPath: overlayPath,
    personChangesPath: join(dir, "person-change.csv"),
    conn,
  });
  const post = (path: string, body: Record<string, string>) =>
    app.request(path, {
      method: "POST",
      headers: { origin: "http://localhost:3054", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  return { app, conn, post, overlayPath };
}

describe("a person's ORCID on their page", () => {
  it("says there is none and how they can connect one on iNaturalist", async () => {
    const { app } = await personPage();
    const body = await (await app.request("/people/ada")).text();
    expect(body).toContain("No ORCID iD");
    expect(body).toContain("Connected Accounts and connect ORCID");
    expect(body).toContain(`href="https://www.inaturalist.org/users/edit"`);
  });

  it("does not tell somebody with no account to connect one there", async () => {
    const { app } = await personPage();
    expect(await (await app.request("/people/2")).text()).not.toContain("Connected Accounts");
  });

  it("records a pasted iD, links it, and says the account's would win", async () => {
    const { app, conn, post, overlayPath } = await personPage();
    const saved = await post("/people/ada/orcid", { orcid: ` https://orcid.org/${CARBERRY} `, reason: "she gave it" });
    expect(saved.status).toBe(200);
    expect((await readOverlay(overlayPath)).map((r) => [r.person_ref, r.field, r.value])).toEqual([
      ["name:Ada Collector", "orcid", CARBERRY],
    ]);
    let body = await (await app.request("/people/ada")).text();
    expect(body).toContain(`href="https://orcid.org/${CARBERRY}"`);
    expect(body).toContain("Recorded by staff");

    await conn.run(`INSERT INTO inat_user_orcid (inat_user_id, orcid) VALUES (111, '${SECOND}')`);
    body = await (await app.request("/people/ada")).text();
    expect(body).toContain(`href="https://orcid.org/${SECOND}"`);
    expect(body).toContain("From their iNaturalist account");
    expect(body).toContain(`Staff also recorded ${CARBERRY}`);
  });

  it("refuses a typo and an iD somebody else holds before writing the overlay", async () => {
    const { app, post, overlayPath } = await personPage();
    let body = await (await post("/people/ada/orcid", { orcid: "0000-0002-1825-0098" })).text();
    expect(body).toContain("is not an ORCID iD");
    await post("/people/2/orcid", { orcid: CARBERRY });
    body = await (await post("/people/ada/orcid", { orcid: CARBERRY })).text();
    expect(body).toContain(`${CARBERRY} is already recorded for Bo Netter`);
    expect((await readOverlay(overlayPath)).map((r) => r.person_ref)).toEqual(["name:Bo Netter"]);
    expect((await app.request("/people/ada")).status).toBe(200);
  });
});
