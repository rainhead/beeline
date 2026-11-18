import { beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Kysely } from "kysely";
import { createKysely } from "../src/db.js";
import type { Database } from "../src/model.js";
import type { Registrant } from "../src/ideal-logic.js";
import { decideRegistration, describeRegistrants, recordRegistrants } from "../src/registrations.js";
import { createMemoryDb, rows } from "./helpers.js";

/**
 * What Beeline keeps of Ideal Logic's registrations and whom it links
 * (src/registrations.ts, schema/014). Everybody here is invented. The cases
 * are the ones the real data of 2026-11-18 held: a handle typed correctly, a
 * handle typed as a display name, a couple registered once under a joint
 * first name, a registrant who shares a collector's name and nothing else,
 * and several hundred people who registered and have no relation to Beeline.
 */

let conn: DuckDBConnection;
let db: Kysely<Database>;
const id: Record<string, number> = {};

const registrant = (over: Partial<Registrant> & Pick<Registrant, "id" | "givenName" | "familyName">): Registrant => ({
  atlases: [],
  inatHandle: null,
  email: `${over.id}@example.org`,
  address: { street: "1 Private Road", city: "Corvallis", stateProvince: "OR", postalCode: "97330", country: "USA" },
  ...over,
});

beforeEach(async () => {
  const made = await createMemoryDb();
  conn = made.conn;
  db = createKysely(made.instance);
  await conn.run(
    `INSERT INTO person (display_name) VALUES ('Ada Bramble'), ('Bo Sedge'), ('Cy Yarrow'), ('Dot Yarrow'), ('Eve Aster')`,
  );
  for (const [entityId, name] of await rows(conn, `SELECT entity_id, display_name FROM person`)) {
    id[String(name).split(" ")[0]!] = Number(entityId);
  }
  // Cy and Dot Yarrow are a household: one login, which only one can hold.
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login) VALUES
       (${id.Ada}, 1, 'adabramble'), (${id.Bo}, 2, 'bosedge'), (${id.Cy}, 3, 'yarrows')`,
  );
});

const links = () => rows(conn, `SELECT person_id, ideal_logic_id, evidence, decided_by FROM person_registration ORDER BY person_id`);
const kept = () => rows(conn, `SELECT ideal_logic_id, atlases, inat_handle FROM ideal_logic_registrant ORDER BY ideal_logic_id`);
const JOB = { decidedBy: "ideal-logic-registrants" };
/** Registrations an earlier night's fetch kept, as (id, given name, family name). */
const seen = async (...registrations: Array<[string, string, string]>) => {
  for (const [idealLogicId, given, family] of registrations) {
    await conn.run(`INSERT INTO ideal_logic_registrant (ideal_logic_id, given_name, family_name) VALUES ('${idealLogicId}', '${given}', '${family}')`);
  }
};

describe("the nightly fetch", () => {
  test("links a person whose login was typed at registration under their own name, whatever its case", async () => {
    const out = await recordRegistrants(db, [registrant({ id: "A-1", givenName: "Ada", familyName: "Bramble", inatHandle: "AdaBramble", atlases: ["OBA"] })], JOB);
    expect(await links()).toEqual([[id.Ada, "A-1", "handle", "ideal-logic-registrants"]]);
    expect(out).toEqual({ seen: 1, kept: 1, firstSeen: 1, linked: 1, unlinked: 0 });
  });

  test("does not link on the handle when the name is somebody else's: one login, two people in the house", async () => {
    await recordRegistrants(db, [registrant({ id: "D-1", givenName: "Dot", familyName: "Yarrow", inatHandle: "yarrows" })], JOB);
    expect(await links()).toEqual([]);
    // Kept, for staff: it names a handle, and its name is a person's.
    expect(await kept()).toEqual([["D-1", null, "yarrows"]]);
  });

  test("does not link on a name alone", async () => {
    const out = await recordRegistrants(db, [registrant({ id: "E-1", givenName: "Eve", familyName: "Aster" })], JOB);
    expect(await links()).toEqual([]);
    expect(out).toMatchObject({ kept: 1, linked: 0, unlinked: 1 });
  });

  test("does not link on a handle that is no login here", async () => {
    await recordRegistrants(db, [registrant({ id: "B-1", givenName: "Bo", familyName: "Sedge", inatHandle: "bo_sedge" })], JOB);
    expect(await links()).toEqual([]);
  });

  test("keeps no row for a registrant with no atlas, no handle and nobody's name", async () => {
    const out = await recordRegistrants(db, [registrant({ id: "Z-1", givenName: "Zed", familyName: "Stranger" })], JOB);
    expect(await kept()).toEqual([]);
    expect(out).toEqual({ seen: 1, kept: 0, firstSeen: 0, linked: 0, unlinked: 0 });
  });

  test("keeps a registrant Beeline does not know who named an atlas, with the atlases in the order given", async () => {
    await recordRegistrants(db, [registrant({ id: "N-1", givenName: "Nan", familyName: "Newcomer", atlases: ["WaBA", "OBA"] })], JOB);
    expect(await kept()).toEqual([["N-1", "WaBA;OBA", null]]);
  });

  test("stores no email address and no home address, in any column of either table", async () => {
    await recordRegistrants(db, [registrant({ id: "A-1", givenName: "Ada", familyName: "Bramble", inatHandle: "adabramble" })], JOB);
    const everything = [
      ...(await rows(conn, `SELECT * FROM ideal_logic_registrant`)),
      ...(await rows(conn, `SELECT * FROM person_registration_event`)),
    ]
      .flat()
      .map(String)
      .join("\n");
    expect(everything).toContain("adabramble");
    for (const piece of ["example.org", "Private Road", "Corvallis", "97330"]) expect(everything).not.toContain(piece);
  });

  test("a second night changes what changed, keeps the first night's date, and links nobody twice", async () => {
    const first = registrant({ id: "A-1", givenName: "Ada", familyName: "Bramble", inatHandle: "adabramble" });
    await recordRegistrants(db, [first], JOB);
    await conn.run(`UPDATE ideal_logic_registrant SET first_seen_at = TIMESTAMP '2026-01-01 00:00:00', last_seen_at = TIMESTAMP '2026-01-01 00:00:00'`);
    const out = await recordRegistrants(db, [{ ...first, atlases: ["OBA"] }], JOB);
    expect(out).toEqual({ seen: 1, kept: 1, firstSeen: 0, linked: 0, unlinked: 0 });
    expect(await rows(conn, `SELECT atlases, first_seen_at = TIMESTAMP '2026-01-01 00:00:00', last_seen_at > TIMESTAMP '2026-01-01 00:00:00' FROM ideal_logic_registrant`)).toEqual([
      ["OBA", true, true],
    ]);
    expect(await rows(conn, `SELECT count(*) FROM person_registration_event`)).toEqual([[1n]]);
  });

  test("a registration that has left Ideal Logic keeps its row and its last date", async () => {
    await recordRegistrants(db, [registrant({ id: "N-1", givenName: "Nan", familyName: "Newcomer", atlases: ["OBA"] })], JOB);
    await conn.run(`UPDATE ideal_logic_registrant SET last_seen_at = TIMESTAMP '2026-01-01 00:00:00'`);
    await recordRegistrants(db, [], JOB);
    expect(await rows(conn, `SELECT ideal_logic_id, last_seen_at = TIMESTAMP '2026-01-01 00:00:00' FROM ideal_logic_registrant`)).toEqual([["N-1", true]]);
  });

  test("a row that stops qualifying is kept and goes on being dated, so a stale date means gone from Ideal Logic", async () => {
    const nan = registrant({ id: "N-1", givenName: "Nan", familyName: "Newcomer", atlases: ["OBA"] });
    await recordRegistrants(db, [nan], JOB);
    await conn.run(`UPDATE ideal_logic_registrant SET last_seen_at = TIMESTAMP '2026-01-01 00:00:00'`);
    // She cleared her atlas: no atlas, no handle, nobody's name.
    const out = await recordRegistrants(db, [{ ...nan, atlases: [] }], JOB);
    expect(out.kept).toBe(1);
    expect(await rows(conn, `SELECT atlases, last_seen_at > TIMESTAMP '2026-01-01 00:00:00' FROM ideal_logic_registrant`)).toEqual([[null, true]]);
  });

  test("a person with two registrations that both qualify is linked to neither, whichever comes first", async () => {
    const first = registrant({ id: "A-1", givenName: "Ada", familyName: "Bramble", inatHandle: "adabramble" });
    const second = registrant({ id: "A-2", givenName: "Ada", familyName: "Bramble", inatHandle: "AdaBramble" });
    for (const order of [
      [first, second],
      [second, first],
    ]) {
      const out = await recordRegistrants(db, order, JOB);
      expect(out.linked).toBe(0);
      expect(await links()).toEqual([]);
    }
  });

  test("a login two people hold links neither", async () => {
    await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Bramble')`);
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) SELECT max(entity_id), 9, 'AdaBramble' FROM person`);
    await recordRegistrants(db, [registrant({ id: "A-1", givenName: "Ada", familyName: "Bramble", inatHandle: "adabramble" })], JOB);
    expect(await links()).toEqual([]);
  });

  test("a name with no ASCII letters agrees with nothing, since it folds to nothing", async () => {
    await conn.run(`INSERT INTO person (display_name) VALUES ('李 雷')`);
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) SELECT max(entity_id), 8, 'lilei' FROM person`);
    await recordRegistrants(db, [registrant({ id: "L-1", givenName: "韓", familyName: "梅梅", inatHandle: "lilei" })], JOB);
    expect(await links()).toEqual([]);
  });

  test("the same id twice in one fetch is recorded once and does not fail the run", async () => {
    const ada = registrant({ id: "A-1", givenName: "Ada", familyName: "Bramble", inatHandle: "adabramble" });
    const out = await recordRegistrants(db, [ada, { ...ada, atlases: ["OBA"] }], JOB);
    expect(out).toEqual({ seen: 2, kept: 1, firstSeen: 1, linked: 1, unlinked: 0 });
    expect(await kept()).toEqual([["A-1", "OBA", "adabramble"]]);
  });

  test("leaves a person staff have unlinked unlinked", async () => {
    await seen(["OLD-1", "Ada", "Bramble"]);
    await decideRegistration(db, { personId: id.Ada!, idealLogicId: "OLD-1", evidence: "staff", decidedBy: "peter" });
    await decideRegistration(db, { personId: id.Ada!, idealLogicId: null, evidence: "staff", decidedBy: "peter" });
    const out = await recordRegistrants(db, [registrant({ id: "A-1", givenName: "Ada", familyName: "Bramble", inatHandle: "adabramble" })], JOB);
    expect(await links()).toEqual([]);
    expect(out.linked).toBe(0);
  });

  test("leaves alone a person staff have said has no registration, before any link was made", async () => {
    expect(await decideRegistration(db, { personId: id.Ada!, idealLogicId: null, evidence: "staff", decidedBy: "peter" })).toEqual({
      ok: true,
      outcome: "saved",
      was: null,
      registrant: null,
    });
    const out = await recordRegistrants(db, [registrant({ id: "A-1", givenName: "Ada", familyName: "Bramble", inatHandle: "adabramble" })], JOB);
    expect(out.linked).toBe(0);
    expect(await links()).toEqual([]);
  });

  test("keeps a linked registration even when it names no atlas, no handle and nobody's name", async () => {
    // A couple registered once, under a joint first name no person has.
    await seen(["Y-1", "Cy and Dot", "Yarrow"]);
    await decideRegistration(db, { personId: id.Cy!, idealLogicId: "Y-1", evidence: "staff", decidedBy: "peter" });
    const out = await recordRegistrants(db, [registrant({ id: "Y-1", givenName: "Cy and Dot", familyName: "Yarrow" })], JOB);
    expect(await kept()).toEqual([["Y-1", null, null]]);
    expect(out).toMatchObject({ kept: 1, firstSeen: 0, unlinked: 0 });
  });

  test("never links a registration that staff already linked to somebody else", async () => {
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id.Dot}, 4, 'dotyarrow')`);
    await seen(["Y-1", "Dot", "Yarrow"]);
    await decideRegistration(db, { personId: id.Cy!, idealLogicId: "Y-1", evidence: "staff", decidedBy: "peter" });
    const out = await recordRegistrants(db, [registrant({ id: "Y-1", givenName: "Dot", familyName: "Yarrow", inatHandle: "dotyarrow" })], JOB);
    expect(out.linked).toBe(0);
    expect(await links()).toEqual([[id.Cy, "Y-1", "staff", "peter"]]);
  });

  test("says what it did in counts", () => {
    expect(describeRegistrants({ seen: 826, kept: 440, firstSeen: 3, linked: 2, unlinked: 161 })).toBe(
      "826 registrations in Ideal Logic; 440 kept; 3 seen for the first time; 2 linked to a person by handle and name; 161 linked to nobody",
    );
    expect(describeRegistrants({ seen: 826, kept: 440, firstSeen: 0, linked: 0, unlinked: 161 })).toBe(
      "826 registrations in Ideal Logic; 440 kept; 161 linked to nobody",
    );
  });
});

describe("a decision about one person", () => {
  beforeEach(async () => {
    await seen(["Y-1", "Cy and Dot", "Yarrow"], ["B-1", "Bo", "Sedge"], ["B-2", "Bo", "Sedge"]);
  });

  test("two people may share a registration: a household registers once", async () => {
    await decideRegistration(db, { personId: id.Cy!, idealLogicId: "Y-1", evidence: "staff", decidedBy: "peter" });
    await decideRegistration(db, { personId: id.Dot!, idealLogicId: "Y-1", evidence: "staff", decidedBy: "peter" });
    expect(await links()).toEqual([
      [id.Cy, "Y-1", "staff", "peter"],
      [id.Dot, "Y-1", "staff", "peter"],
    ]);
  });

  test("the latest decision is the answer, the earlier ones are still there, and the answer names the registrant", async () => {
    expect(await decideRegistration(db, { personId: id.Bo!, idealLogicId: "B-1", evidence: "register_email", decidedBy: "peter", reference: "issue 1" })).toEqual({
      ok: true,
      outcome: "saved",
      was: null,
      registrant: "Bo Sedge",
    });
    expect(await decideRegistration(db, { personId: id.Bo!, idealLogicId: "B-2", evidence: "staff", decidedBy: "arthur" })).toEqual({
      ok: true,
      outcome: "saved",
      was: "B-1",
      registrant: "Bo Sedge",
    });
    expect(await links()).toEqual([[id.Bo, "B-2", "staff", "arthur"]]);
    expect(await rows(conn, `SELECT ideal_logic_id, evidence, decided_by, reference FROM person_registration_event ORDER BY entity_id`)).toEqual([
      ["B-1", "register_email", "peter", "issue 1"],
      ["B-2", "staff", "arthur", null],
    ]);
  });

  test("evidence from a register email is checked against the name held now; staff's is not", async () => {
    // B-1 is Bo Sedge's registration; Ada Bramble is another person.
    expect(await decideRegistration(db, { personId: id.Ada!, idealLogicId: "B-1", evidence: "register_email", decidedBy: "peter" })).toEqual({
      ok: false,
      refusal: "name_differs",
    });
    expect(await rows(conn, `SELECT count(*) FROM person_registration_event`)).toEqual([[0n]]);
    expect(await decideRegistration(db, { personId: id.Ada!, idealLogicId: "B-1", evidence: "staff", decidedBy: "peter" })).toMatchObject({
      ok: true,
      outcome: "saved",
    });
    expect(await links()).toEqual([[id.Ada, "B-1", "staff", "peter"]]);
  });

  test("saying what is already so records nothing", async () => {
    await decideRegistration(db, { personId: id.Bo!, idealLogicId: "B-1", evidence: "staff", decidedBy: "peter" });
    expect(await decideRegistration(db, { personId: id.Bo!, idealLogicId: "B-1", evidence: "staff", decidedBy: "arthur" })).toMatchObject({ outcome: "unchanged", was: "B-1" });
    await decideRegistration(db, { personId: id.Bo!, idealLogicId: null, evidence: "staff", decidedBy: "peter" });
    expect(await decideRegistration(db, { personId: id.Bo!, idealLogicId: null, evidence: "staff", decidedBy: "arthur" })).toMatchObject({ outcome: "unchanged", was: null });
    expect(await rows(conn, `SELECT count(*) FROM person_registration_event`)).toEqual([[2n]]);
  });

  test("saying a person nobody has decided about has no registration is recorded, once", async () => {
    expect(await decideRegistration(db, { personId: id.Eve!, idealLogicId: null, evidence: "staff", decidedBy: "arthur" })).toMatchObject({ outcome: "saved", was: null });
    expect(await decideRegistration(db, { personId: id.Eve!, idealLogicId: null, evidence: "staff", decidedBy: "arthur" })).toMatchObject({ outcome: "unchanged" });
    expect(await rows(conn, `SELECT ideal_logic_id FROM person_registration_event`)).toEqual([[null]]);
    expect(await links()).toEqual([]);
  });

  test("unlinking leaves the person with no registration, and linking again restores one", async () => {
    await decideRegistration(db, { personId: id.Bo!, idealLogicId: "B-1", evidence: "staff", decidedBy: "peter" });
    await decideRegistration(db, { personId: id.Bo!, idealLogicId: null, evidence: "staff", decidedBy: "peter" });
    expect(await links()).toEqual([]);
    await decideRegistration(db, { personId: id.Bo!, idealLogicId: "B-2", evidence: "staff", decidedBy: "peter" });
    expect(await links()).toEqual([[id.Bo, "B-2", "staff", "peter"]]);
  });

  test("refuses a person who is not here, and a registration Beeline has not seen", async () => {
    expect(await decideRegistration(db, { personId: 999999, idealLogicId: "B-1", evidence: "staff", decidedBy: "peter" })).toEqual({ ok: false, refusal: "unknown_person" });
    for (const idealLogicId of ["B-9", "b-1", "bo@example.org"]) {
      expect(await decideRegistration(db, { personId: id.Bo!, idealLogicId, evidence: "staff", decidedBy: "peter" })).toEqual({
        ok: false,
        refusal: "unknown_registration",
      });
    }
    expect(await rows(conn, `SELECT count(*) FROM person_registration_event`)).toEqual([[0n]]);
  });
});
