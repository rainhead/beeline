import type { DuckDBConnection } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";
import { IMPERSONATING_COOKIE } from "../src/app/acting.js";
import type { InatClient } from "../src/app/auth.js";
import { en } from "../src/app/messages/en.js";
import { listRegistrations } from "../src/app/registrations.js";
import { createApp } from "../src/app/server.js";
import { createKysely } from "../src/db.js";
import { approveRun, markMailed, markPrinted, prepareRun } from "../src/print-run.js";
import { canonicalJson } from "../src/sync-inat.js";
import { refreshObservationFields } from "../src/refresh-observation-fields.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths, SETTLED_SEASON } from "./helpers.js";

/**
 * The staff screen for registrations (beeline-w8ab.2). Everyone here is
 * invented, and no registrant has an address or an email address, since
 * Beeline holds neither.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const ORIGIN = "http://localhost:3054";

async function stageObserver(conn: DuckDBConnection, id: number, userId: number, login: string): Promise<void> {
  const o = {
    id,
    uuid: `uuid-${id}`,
    observed_on: "2026-07-14",
    geojson: { coordinates: [-123.262, 44.5646], type: "Point" },
    positional_accuracy: 30,
    public_positional_accuracy: 30,
    geoprivacy: null,
    taxon_geoprivacy: null,
    place_ids: [],
    place_guess: "Corvallis, OR, US",
    user: { id: userId, login, name: "Nan New" },
    taxon: { id: 47604, name: "Rubus", ancestor_ids: [48460, 47126, 211194, 47604] },
    ofvs: [
      { name: "sampleId", value: String(id) },
      { name: "numberOfSpecimens", value: "3" },
    ],
  };
  await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
  await conn.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
    [id, canonicalJson(o), `hash-${id}`] as never,
  );
  await refreshObservationFields(conn);
}

async function setup() {
  const { instance, conn } = await createMemoryDb();
  const person = async (display: string, given: string, family: string, login?: string) => {
    const [[id]] = (await rows(
      conn,
      `INSERT INTO person (display_name, given_name, family_name) VALUES ('${display}', '${given}', '${family}') RETURNING entity_id`,
    )) as [[number]];
    if (login !== undefined) {
      await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${1000 + Number(id)}, '${login}')`);
    }
    return Number(id);
  };
  const sam = await person("Sam Staff", "Sam", "Staff", "samstaff");
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${sam})`);
  const ids = {
    ada: await person("Ada Ash", "Ada", "Ash", "AdaAsh"),
    bo: await person("Bo Birch", "Bo", "Birch", "bobirch"),
    cy: await person("Cy Cedar", "Cy", "Cedar"),
    di: await person("Di Dale", "Di", "Dale"),
    ed: await person("Ed Elm", "Ed", "Elm"),
    flo: await person("Flo Fir", "Flo", "Fir"),
    gus: await person("Gus Gray", "Gus", "Gray"),
    hal: await person("Hal Holt", "Hal", "Holt", "halholt"),
  };
  await conn.run(
    `INSERT INTO person_membership (person_id, program_id) SELECT ${ids.ada}, entity_id FROM program WHERE code = 'OBA'`,
  );

  // Di's labels are in a run that was mailed; Bo's are in a run not yet mailed.
  await insertCleanSample(conn, { collector_id: String(ids.di), sample_number: "'1'" });
  const at = new Date("2026-09-21T16:00:00Z");
  const mailed = (await prepareRun(conn, { atlasId: null, personId: sam, now: at }))!.printRunId;
  await approveRun(conn, mailed, { personId: sam, now: at });
  await markPrinted(conn, mailed, { personId: sam, now: at });
  await markMailed(conn, mailed, { personId: sam, now: at });
  await insertCleanSample(conn, { collector_id: String(ids.bo), sample_number: "'1'" });
  await prepareRun(conn, { atlasId: null, personId: sam, now: new Date("2026-09-22T16:00:00Z") });
  // Cy's only sample is from a settled season, so nothing of it is waiting.
  await insertCleanSample(conn, {
    collector_id: String(ids.cy),
    sample_number: "'1'",
    date_start: `DATE '${SETTLED_SEASON}-07-14'`,
    date_end: `DATE '${SETTLED_SEASON}-07-14'`,
  });
  // Ada's labels are waiting: nothing has frozen them.
  await insertCleanSample(conn, { collector_id: String(ids.ada), sample_number: "'1'" });
  // Ed and Flo have a decision, so they are not listed; Gus has no sample.
  await insertCleanSample(conn, { collector_id: String(ids.ed), sample_number: "'1'", date_start: `DATE '${SETTLED_SEASON}-07-14'`, date_end: `DATE '${SETTLED_SEASON}-07-14'` });
  await insertCleanSample(conn, { collector_id: String(ids.flo), sample_number: "'1'", date_start: `DATE '${SETTLED_SEASON}-07-14'`, date_end: `DATE '${SETTLED_SEASON}-07-14'` });
  // Hal collects as a second collector only.
  const halSample = await insertCleanSample(conn, { collector_id: String(ids.cy), sample_number: "'2'", date_start: `DATE '${SETTLED_SEASON}-07-15'`, date_end: `DATE '${SETTLED_SEASON}-07-15'` });
  await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${halSample}, ${ids.hal}, 2)`);

  const registrant = (id: string, given: string, family: string, atlases: string | null, handle: string | null, seen: string) =>
    conn.run(
      `INSERT INTO ideal_logic_registrant (ideal_logic_id, given_name, family_name, atlases, inat_handle, first_seen_at)
       VALUES ('${id}', '${given}', '${family}', ${atlases === null ? "NULL" : `'${atlases}'`}, ${handle === null ? "NULL" : `'${handle}'`}, TIMESTAMP '${seen}')`,
    );
  await registrant("ADA-1", "Ada", "Ash", "OBA", "adaash", "2026-11-10 01:00:00");
  await registrant("ASH-2", "Zed", "Ash", "WaBA", null, "2026-11-10 01:00:00");
  await registrant("BIR-1", "Bo", "Birch", null, null, "2026-11-10 01:00:00");
  await registrant("DAL-1", "Dee", "Dale", null, "bobirch", "2026-11-10 01:00:00");
  await registrant("ELM-1", "Ed", "Elm", "MM", "edelm", "2026-11-10 01:00:00");
  await registrant("NEW-1", "Nan", "New", "OBA", "NewBee", "2026-11-17 01:00:00");
  await registrant("OLD-1", "Olly", "Old", "MM;WaBA", null, "2026-11-12 01:00:00");
  await registrant("NONE-1", "Pat", "Plain", null, null, "2026-11-17 01:00:00");
  const event = (person: number, id: string | null) =>
    conn.run(
      `INSERT INTO person_registration_event (person_id, ideal_logic_id, evidence, decided_by) VALUES (${person}, ${id === null ? "NULL" : `'${id}'`}, 'staff', 'test')`,
    );
  await event(ids.ed, "ELM-1");
  await event(ids.flo, null);
  await stageObserver(conn, 1, 500, "newbee");

  let who = sam;
  const app = createApp({
    ...(await scratchPaths()),
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: ORIGIN },
    inat: unusedInat,
    resolveSession: async () => ({ personId: who, login: who === sam ? "samstaff" : "volunteer", iconUrl: null }),
    printConn: conn,
  });
  const get = (path: string, cookie?: string) => app.request(path, cookie === undefined ? {} : { headers: { cookie } });
  const post = (path: string, body: Record<string, string> = {}, cookie?: string) =>
    app.request(path, {
      method: "POST",
      headers: { origin: ORIGIN, ...(cookie === undefined ? {} : { cookie }) },
      body: new URLSearchParams(body),
    });
  return { app, conn, ids, get, post, db: createKysely(instance), asVolunteer: () => void (who = ids.ada) };
}

const decisions = async (conn: DuckDBConnection, personId: number) =>
  (await rows(
    conn,
    `SELECT ideal_logic_id, evidence, decided_by FROM person_registration_event WHERE person_id = ${personId} ORDER BY entity_id`,
  )) as [string | null, string, string][];

describe("what the registrations page lists", () => {
  it("lists collectors with no decision, labels waiting first, then labels in an unmailed run, then the rest by latest sample", async () => {
    const { db, ids } = await setup();
    const { collectors } = await listRegistrations(db);
    expect(collectors.map((c) => [c.display_name, c.waiting > 0, c.in_unmailed_run > 0])).toEqual([
      ["Ada Ash", true, false],
      ["Bo Birch", false, true],
      // Di's sample is from the current season and was mailed; Cy's are settled.
      ["Di Dale", false, false],
      ["Cy Cedar", false, false],
    ]);
    const ada = collectors[0]!;
    expect(ada).toMatchObject({ person_id: ids.ada, login: "AdaAsh", membership: "atlas", atlas_abbreviation: "OBA", samples: 1 });
    // Cy is primary collector of two samples. Hal, a second collector only, is not listed.
    expect(collectors.find((c) => c.display_name === "Cy Cedar")!.samples).toBe(2);
    expect(collectors.map((c) => c.display_name)).not.toContain("Hal Holt");
  });

  it("suggests a registrant for the same full name, the same family name, or a handle that is the login", async () => {
    const { db } = await setup();
    const { collectors } = await listRegistrations(db);
    const by = (name: string) => collectors.find((c) => c.display_name === name)!;
    // Ada: the same name and the handle (typed in another case); a family name alone ranks last.
    expect(by("Ada Ash").suggestions.map((s) => [s.ideal_logic_id, s.reasons])).toEqual([
      ["ADA-1", ["full_name", "handle"]],
      ["ASH-2", ["family_name"]],
    ]);
    // Bo: the name alone, and a handle that is his login under another name.
    expect(by("Bo Birch").suggestions.map((s) => [s.ideal_logic_id, s.reasons])).toEqual([
      ["BIR-1", ["full_name"]],
      ["DAL-1", ["handle"]],
    ]);
    // Di: the family name only, where the given name differs.
    expect(by("Di Dale").suggestions.map((s) => [s.ideal_logic_id, s.reasons])).toEqual([["DAL-1", ["family_name"]]]);
    expect(by("Cy Cedar").suggestions).toEqual([]);
  });

  it("lists registrants linked to nobody who named an atlas or a handle, newest first, and links a handle to the observer waiting on Unknown collectors", async () => {
    const { db } = await setup();
    const { registrants } = await listRegistrations(db);
    // ELM-1 is linked, BIR-1 and NONE-1 named neither atlas nor handle.
    expect(registrants.map((r) => r.ideal_logic_id)).toEqual(["NEW-1", "OLD-1", "ADA-1", "ASH-2", "DAL-1"]);
    expect(registrants[0]).toMatchObject({ atlases: ["OBA"], inat_handle: "NewBee", unclaimed_user_id: 500 });
    expect(registrants[1]).toMatchObject({ atlases: ["MM", "WaBA"], inat_handle: null, unclaimed_user_id: null });
  });

  it("renders both sections with their counts, the id small, and neither an address nor an email address", async () => {
    const { get } = await setup();
    const res = await get("/registrations");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(en.registrations.collectorsHeading(4));
    expect(html).toContain(en.registrations.registrantsHeading(5));
    expect(html).toContain('href="/unclaimed/500"');
    expect(html).toContain('href="/people/');
    expect(html).toContain("iNaturalist login.");
    expect(html).toContain("<small>");
    expect(html).not.toMatch(/@[a-z]+\.org|mailing address:/i);
    // The navigation offers it.
    expect(html).toContain('href="/registrations"');
  });
});

describe("deciding from the page", () => {
  it("links a suggestion with staff evidence, and redirects back with a confirmation", async () => {
    const { post, get, conn, ids } = await setup();
    const res = await post(`/registrations/${ids.ada}/link`, { ideal_logic_id: "ADA-1" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/registrations?saved=linked&for=${ids.ada}&id=ADA-1#collectors`);
    expect(await decisions(conn, ids.ada)).toEqual([["ADA-1", "staff", "samstaff"]]);
    const html = await (await get(res.headers.get("location")!)).text();
    expect(html).toContain(en.registrations.saved.linked("Ada Ash", "Ada Ash"));
    expect(html).toContain(en.registrations.collectorsHeading(3));
  });

  it("records that a person has no registration, which keeps the nightly job from linking them", async () => {
    const { post, conn, ids } = await setup();
    const res = await post(`/registrations/${ids.bo}/none`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("saved=none");
    expect(await decisions(conn, ids.bo)).toEqual([[null, "staff", "samstaff"]]);
  });

  it("links by an id typed in, and shows the refusal for one Beeline has not seen", async () => {
    const { post, conn, ids } = await setup();
    const refused = await post(`/registrations/${ids.cy}/link`, { ideal_logic_id: "NOPE-0" });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain(en.registrations.problem(en.registrations.refused.unknownRegistration));
    expect(await decisions(conn, ids.cy)).toEqual([]);

    const blank = await post(`/registrations/${ids.cy}/link`, { ideal_logic_id: "  " });
    expect(blank.status).toBe(422);

    const linked = await post(`/registrations/${ids.cy}/link`, { ideal_logic_id: " OLD-1 " });
    expect(linked.status).toBe(302);
    expect(await decisions(conn, ids.cy)).toEqual([["OLD-1", "staff", "samstaff"]]);
  });

  it("says nothing changed when the decision is already so", async () => {
    const { post, ids } = await setup();
    await post(`/registrations/${ids.ada}/link`, { ideal_logic_id: "ADA-1" });
    const again = await post(`/registrations/${ids.ada}/link`, { ideal_logic_id: "ADA-1" });
    expect(again.headers.get("location")).toContain("saved=unchanged");
  });

  it("is for admins only, and refused while viewing as somebody else", async () => {
    const { post, get, conn, ids, asVolunteer } = await setup();
    const viaCookie = await post(`/registrations/${ids.ada}/link`, { ideal_logic_id: "ADA-1" }, `${IMPERSONATING_COOKIE}=${encodeURIComponent("Bo Birch")}`);
    expect(viaCookie.status).toBe(403);
    expect(await viaCookie.text()).toBe(en.errors.readOnlyImpersonating);
    expect((await get("/registrations", `${IMPERSONATING_COOKIE}=${encodeURIComponent("Bo Birch")}`)).status).toBe(403);

    asVolunteer();
    expect((await get("/registrations")).status).toBe(403);
    expect((await post(`/registrations/${ids.ada}/link`, { ideal_logic_id: "ADA-1" })).status).toBe(403);
    expect((await post(`/registrations/${ids.ada}/none`)).status).toBe(403);
    expect((await post(`/registrations/${ids.ada}/unlink`)).status).toBe(403);
    expect(await decisions(conn, ids.ada)).toEqual([]);
  });

  it("refuses a form from another origin", async () => {
    const { app, ids, conn } = await setup();
    const res = await app.request(`/registrations/${ids.ada}/none`, {
      method: "POST",
      headers: { origin: "http://evil.example" },
      body: new URLSearchParams(),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await decisions(conn, ids.ada)).toEqual([]);
  });
});

describe("the registration on a person's page", () => {
  it("says there is none, then shows the link with who decided and offers to unlink it", async () => {
    const { get, post, conn, ids } = await setup();
    const p = en.people;
    expect(await (await get(`/people/${ids.ada}`)).text()).toContain(p.registrationNone);

    await post(`/registrations/${ids.ada}/link`, { ideal_logic_id: "ADA-1" });
    const linked = await (await get(`/people/${ids.ada}`)).text();
    expect(linked).toContain(p.registrationOf("Ada Ash"));
    expect(linked).toContain("ADA-1");
    expect(linked).toContain(p.registrationEvidenceKinds.staff);
    expect(linked).toContain("Decided by samstaff");
    expect(linked).toContain(p.unlinkRegistration);
    expect(linked).toContain('href="/registrations"');

    const unlinked = await post(`/registrations/${ids.ada}/unlink`, { return: "person" });
    expect(unlinked.status).toBe(200);
    expect(await unlinked.text()).toContain(en.registrations.saved.unlinked("Ada Ash"));
    expect(await decisions(conn, ids.ada)).toEqual([
      ["ADA-1", "staff", "samstaff"],
      [null, "staff", "samstaff"],
    ]);
    expect(await (await get(`/people/${ids.ada}`)).text()).toContain("No registration (decided by samstaff");
  });

  it("lets staff link a person they recorded as having no registration, from the person's page", async () => {
    const { get, post, conn, db, ids } = await setup();
    await post(`/registrations/${ids.bo}/none`);
    const none = await (await get(`/people/${ids.bo}`)).text();
    expect(none).toContain("No registration (decided by samstaff");
    expect(none).toContain(`action="/registrations/${ids.bo}/link"`);
    expect(none).toContain('name="return" value="person"');
    // The person has left the list, so the page is the only way back.
    expect((await listRegistrations(db)).collectors.map((c) => c.person_id)).not.toContain(ids.bo);

    const res = await post(`/registrations/${ids.bo}/link`, { ideal_logic_id: "BIR-1", return: "person" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(en.registrations.saved.linked("Bo Birch", "Bo Birch"));
    expect(await decisions(conn, ids.bo)).toEqual([
      [null, "staff", "samstaff"],
      ["BIR-1", "staff", "samstaff"],
    ]);
    expect(await (await get(`/people/${ids.bo}`)).text()).toContain(en.people.registrationOf("Bo Birch"));
  });

  it("confirms the registration this request saved, even if it was changed before the page loaded", async () => {
    const { get, post, conn, ids } = await setup();
    const res = await post(`/registrations/${ids.ada}/link`, { ideal_logic_id: "ADA-1" });
    // Another staff member links Ada to somebody else before the redirect is followed.
    await conn.run(
      `INSERT INTO person_registration_event (person_id, ideal_logic_id, evidence, decided_by) VALUES (${ids.ada}, 'ASH-2', 'staff', 'other')`,
    );
    const html = await (await get(res.headers.get("location")!)).text();
    expect(html).toContain(en.registrations.saved.linked("Ada Ash", "Ada Ash"));
    expect(html).not.toContain(en.registrations.saved.linked("Ada Ash", "Zed Ash"));
  });
});
