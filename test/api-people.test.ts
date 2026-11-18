import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createKey, KEY_SCOPES } from "../src/app/api-keys.js";
import { createApp } from "../src/app/server.js";
import { readChanges } from "../src/person-change.js";
import { readOverlay } from "../src/person-overlay.js";
import { createMemoryDb, rows, scratchPaths } from "./helpers.js";

/**
 * Where a person belongs, set through the API (beeline-4rta): that a staff
 * key makes the decision the person's page makes, with the same overlay row,
 * store row and history entry, and what the API refuses. Run on the sandbox
 * environment, since development makes everyone staff.
 *
 * Three people: Sam (staff), Vol (a volunteer with an account) and Ada (no
 * account, so reached by her id).
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const ORIGIN = "http://localhost:3054";

async function world() {
  const paths = await scratchPaths();
  const { instance, conn } = await createMemoryDb();
  const person = async (name: string, account?: { uid: number; login: string }) => {
    const [[id]] = (await rows(conn, `INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)) as [[number]];
    if (account !== undefined) {
      await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${account.uid}, '${account.login}')`);
    }
    return Number(id);
  };
  const sam = await person("Sam Staff", { uid: 3, login: "samstaff" });
  const vol = await person("Vol Unteer", { uid: 4, login: "vol" });
  const ada = await person("Ada Collector");
  await conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (${sam}, 'peter')`);
  const db = createKysely(instance);
  const app = createApp({
    ...paths,
    db,
    config: { environment: "sandbox" as const, origin: ORIGIN },
    inat: unusedInat,
    resolveSession: async () => ({ personId: sam, login: "samstaff", inatUserId: BigInt(3), iconUrl: null }),
    conn,
  });
  const keyFor = async (uid: number, scope: string) => {
    const made = await createKey(db, { inatUserId: uid, name: "test", scope, lifetimeDays: 30, offered: KEY_SCOPES });
    if ("problem" in made) throw new Error(made.problem);
    return made.key;
  };
  const send = (key: string, handle: string | number, body: unknown) =>
    app.request(`/api/v1/people/${handle}/membership`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const sendRegistration = (key: string, handle: string | number, body: unknown) =>
    app.request(`/api/v1/people/${handle}/registration`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const belongsTo = async (personId: number) =>
    (
      await rows(
        conn,
        `SELECT p.code FROM person_membership m JOIN program p ON p.entity_id = m.program_id WHERE m.person_id = ${personId}`,
      )
    ).map((r) => r[0]);
  return {
    conn,
    paths,
    send,
    sendRegistration,
    belongsTo,
    people: { sam, vol, ada },
    keys: { staff: await keyFor(3, "staff"), samEdit: await keyFor(3, "edit"), vol: await keyFor(4, "edit") },
  };
}

describe("POST /api/v1/people/:id/membership", () => {
  it("sets where a person belongs: the overlay row, the store and the history, credited to the key's person", async () => {
    const w = await world();
    const res = await w.send(w.keys.staff, w.people.ada, { belongs_to: "OBA", note: "All her samples are in Oregon.", reference: "issue 1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ person_id: w.people.ada, outcome: "saved", was: "", belongs_to: "OBA" });
    expect(await w.belongsTo(w.people.ada)).toEqual(["OBA"]);
    expect(await readOverlay(w.paths.personOverlayPath)).toEqual([
      { person_ref: "name:Ada Collector", field: "home_atlas", value: "OBA", author: "samstaff", reason: "All her samples are in Oregon." },
    ]);
    const entries = (await readChanges(w.paths.personChangesPath)).filter((c) => c.field === "membership");
    expect(entries.map((c) => [c.person_ref, c.old_value, c.new_value, c.author, c.source, c.reason])).toEqual([
      ["name:Ada Collector", "", "OBA", "samstaff", "app", "All her samples are in Oregon."],
    ]);
    // The request is recorded against the key, with its reference.
    expect(await rows(w.conn, `SELECT route, subject, outcome, reference, status FROM api_key_use`)).toEqual([
      ["/api/v1/people/:id/membership", String(w.people.ada), "saved", "issue 1", 200],
    ]);
  });

  it("reaches a person by their iNaturalist login, and writes Master Melittology as the overlay does", async () => {
    const w = await world();
    const res = await w.send(w.keys.staff, "vol", { belongs_to: "MM" });
    expect(await res.json()).toEqual({ person_id: w.people.vol, outcome: "saved", was: "", belongs_to: "MM" });
    expect(await w.belongsTo(w.people.vol)).toEqual(["MM"]);
    expect((await readOverlay(w.paths.personOverlayPath)).map((r) => r.value)).toEqual(["program"]);
  });

  it("answers unchanged, and writes nothing, when the person already belongs there", async () => {
    const w = await world();
    await w.send(w.keys.staff, w.people.ada, { belongs_to: "WaBA" });
    const again = await w.send(w.keys.staff, w.people.ada, { belongs_to: "WaBA", note: "again" });
    expect(await again.json()).toEqual({ person_id: w.people.ada, outcome: "unchanged", was: "WaBA", belongs_to: "WaBA" });
    expect((await readOverlay(w.paths.personOverlayPath)).map((r) => r.reason)).toEqual([""]);
    expect((await readChanges(w.paths.personChangesPath)).filter((c) => c.field === "membership")).toHaveLength(1);
  });

  it("replaces one answer with another, and an empty string goes back to nothing recorded", async () => {
    const w = await world();
    await w.send(w.keys.staff, w.people.ada, { belongs_to: "OBA" });
    const moved = await w.send(w.keys.staff, w.people.ada, { belongs_to: "BC" });
    expect(await moved.json()).toMatchObject({ outcome: "saved", was: "OBA", belongs_to: "BC" });
    expect(await w.belongsTo(w.people.ada)).toEqual(["BC"]);
    const cleared = await w.send(w.keys.staff, w.people.ada, { belongs_to: "" });
    expect(await cleared.json()).toMatchObject({ outcome: "saved", was: "BC", belongs_to: "" });
    expect(await w.belongsTo(w.people.ada)).toEqual([]);
  });

  it("refuses a key that is not a staff key held by staff, before anything is written", async () => {
    const w = await world();
    for (const key of [w.keys.samEdit, w.keys.vol]) {
      const res = await w.send(key, w.people.ada, { belongs_to: "OBA" });
      expect(res.status).toBe(403);
    }
    expect(await w.belongsTo(w.people.ada)).toEqual([]);
    expect(await readOverlay(w.paths.personOverlayPath)).toEqual([]);
  });

  it("refuses a place nobody can belong, a person who does not exist, and a body it does not understand", async () => {
    const w = await world();
    // BLM is a program, but not one the person's page offers.
    for (const code of ["BLM", "program", "Oregon"]) {
      const res = await w.send(w.keys.staff, w.people.ada, { belongs_to: code });
      expect(res.status).toBe(422);
      expect((await res.json()).message).toContain("MM");
    }
    expect((await w.send(w.keys.staff, 999999, { belongs_to: "OBA" })).status).toBe(404);
    expect((await w.send(w.keys.staff, "nobody", { belongs_to: "OBA" })).status).toBe(404);
    expect((await w.send(w.keys.staff, w.people.ada, {})).status).toBe(400);
    expect((await w.send(w.keys.staff, w.people.ada, { belongs_to: "OBA", home_atlas: "OBA" })).status).toBe(400);
    expect((await w.send(w.keys.staff, w.people.ada, { belongs_to: 7 })).status).toBe(400);
    expect(await w.belongsTo(w.people.ada)).toEqual([]);
    expect(await readOverlay(w.paths.personOverlayPath)).toEqual([]);
  });

  it("refuses a person nothing can name: a shared name and no account", async () => {
    const w = await world();
    await w.conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector')`);
    const res = await w.send(w.keys.staff, w.people.ada, { belongs_to: "OBA" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("unresolved");
    expect(await w.belongsTo(w.people.ada)).toEqual([]);
  });
});

/**
 * Which Ideal Logic registration is a person's, set through the API
 * (beeline-w8ab.1). Unlike membership it is written to its own table and not
 * to the overlay, and it works for a person who shares a name and has no
 * account, whom the overlay cannot name.
 */
describe("POST /api/v1/people/:id/registration", () => {
  const linked = (w: Awaited<ReturnType<typeof world>>) =>
    rows(w.conn, `SELECT person_id, ideal_logic_id, evidence, decided_by FROM person_registration ORDER BY person_id`);

  /** Registrations the nightly job has seen; the API links only to one of these. */
  const seen = (w: Awaited<ReturnType<typeof world>>) =>
    w.conn.run(
      `INSERT INTO ideal_logic_registrant (ideal_logic_id, given_name, family_name) VALUES ('QNN6-MX8', 'Ada', 'Bramble'), ('AB12-CDE3', 'Vi', 'Sedge'), ('AC00-XYZ1', 'Ada', 'Collector')`,
    );

  it("links a person to a registration, credited to the key's person, with the reference kept", async () => {
    const w = await world();
    await seen(w);
    const res = await w.sendRegistration(w.keys.staff, w.people.ada, { ideal_logic_id: "AC00-XYZ1", evidence: "register_email", reference: "issue 2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ person_id: w.people.ada, outcome: "saved", was: "", ideal_logic_id: "AC00-XYZ1", registrant: "Ada Collector" });
    expect(await linked(w)).toEqual([[w.people.ada, "AC00-XYZ1", "register_email", "samstaff"]]);
    expect(await rows(w.conn, `SELECT reference FROM person_registration_event`)).toEqual([["issue 2"]]);
    expect(await rows(w.conn, `SELECT route, subject, outcome, reference, status FROM api_key_use`)).toEqual([
      ["/api/v1/people/:id/registration", String(w.people.ada), "saved", "issue 2", 200],
    ]);
    // Nothing goes to the overlay: it is a file whose curated copy is public.
    expect(await readOverlay(w.paths.personOverlayPath)).toEqual([]);
  });

  it("takes staff as the evidence when none is given, answers unchanged the second time, and unlinks on an empty id", async () => {
    const w = await world();
    await seen(w);
    await w.sendRegistration(w.keys.staff, "vol", { ideal_logic_id: "AB12-CDE3" });
    expect(await linked(w)).toEqual([[w.people.vol, "AB12-CDE3", "staff", "samstaff"]]);
    const again = await w.sendRegistration(w.keys.staff, "vol", { ideal_logic_id: "AB12-CDE3" });
    expect(await again.json()).toMatchObject({ outcome: "unchanged", was: "AB12-CDE3" });
    const cleared = await w.sendRegistration(w.keys.staff, "vol", { ideal_logic_id: "" });
    expect(await cleared.json()).toEqual({ person_id: w.people.vol, outcome: "saved", was: "AB12-CDE3", ideal_logic_id: "", registrant: "" });
    expect(await linked(w)).toEqual([]);
  });

  it("refuses register_email evidence when the registration's name is not the person's, and repeats neither name", async () => {
    const w = await world();
    await seen(w);
    const res = await w.sendRegistration(w.keys.staff, w.people.ada, { ideal_logic_id: "AB12-CDE3", evidence: "register_email" });
    expect(res.status).toBe(422);
    const said = JSON.stringify(await res.json());
    expect(said).toContain("not this person's name");
    for (const piece of ["Vi", "Sedge", "AB12-CDE3"]) expect(said).not.toContain(piece);
    expect(await linked(w)).toEqual([]);
  });

  it("links a person who shares a name and has no account", async () => {
    const w = await world();
    await seen(w);
    await w.conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector')`);
    const res = await w.sendRegistration(w.keys.staff, w.people.ada, { ideal_logic_id: "QNN6-MX8" });
    expect(res.status).toBe(200);
    expect(await linked(w)).toEqual([[w.people.ada, "QNN6-MX8", "staff", "samstaff"]]);
  });

  it("refuses evidence only a job can give, something that is not an id, an unknown person, and a key that is not staff", async () => {
    const w = await world();
    for (const evidence of ["handle", "sign_in_email", "a hunch"]) {
      const res = await w.sendRegistration(w.keys.staff, w.people.ada, { ideal_logic_id: "QNN6-MX8", evidence });
      expect(res.status).toBe(422);
    }
    // An address or an email address sent by mistake is refused, not stored.
    for (const id of ["ada@example.org", "12 Clover Lane", "QNN6 MX8"]) {
      const res = await w.sendRegistration(w.keys.staff, w.people.ada, { ideal_logic_id: id });
      expect(res.status).toBe(422);
    }
    expect((await w.sendRegistration(w.keys.staff, 999999, { ideal_logic_id: "QNN6-MX8" })).status).toBe(404);
    expect((await w.sendRegistration(w.keys.staff, w.people.ada, {})).status).toBe(400);
    expect((await w.sendRegistration(w.keys.samEdit, w.people.ada, { ideal_logic_id: "QNN6-MX8" })).status).toBe(403);
    expect((await w.sendRegistration(w.keys.vol, w.people.ada, { ideal_logic_id: "QNN6-MX8" })).status).toBe(403);
    expect(await linked(w)).toEqual([]);
  });
});
