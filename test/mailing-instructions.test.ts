import { describe, expect, it } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { en } from "../src/app/messages/en.js";
import { createApp } from "../src/app/server.js";
import { createKysely } from "../src/db.js";
import { checkNote, decideMailing } from "../src/mailing-instructions.js";
import { createMemoryDb, rows, scratchPaths } from "./helpers.js";

/**
 * Whether a person's labels are mailed or kept in the lab (beeline-w8ab.4):
 * the function that records it, and the form on the person's page. The API
 * route is tested with the other routes about people, in api-people.test.ts,
 * and the address file in print-run-addresses.test.ts. Everyone is invented.
 */

async function world() {
  const { instance, conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Ada Collector'), (2, 'Sam Staff'), (3, 'Vi Volunteer')`);
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (1, 111, 'ada')`);
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (2)`);
  return { instance, conn, db: createKysely(instance) };
}

const events = (conn: Awaited<ReturnType<typeof world>>["conn"]) =>
  rows(conn, `SELECT person_id, instruction, note, decided_by, reference FROM person_mailing_event ORDER BY entity_id`);
const now = (conn: Awaited<ReturnType<typeof world>>["conn"]) =>
  rows(conn, `SELECT person_id, instruction, note, decided_by FROM person_mailing_instruction ORDER BY person_id`);

describe("checking a note", () => {
  it("allows a plain note and refuses what could hold an address", () => {
    expect(checkNote("ENT 499, picked up in class")).toBeNull();
    expect(checkNote("Room 204, then 1234 steps")).toBeNull();
    expect(checkNote("ada@example.org")).toBe("has_at_sign");
    expect(checkNote("12345")).toBe("has_long_number");
    expect(checkNote("Corvallis OR 97330")).toBe("has_long_number");
    expect(checkNote("x".repeat(200))).toBeNull();
    expect(checkNote("x".repeat(201))).toBe("too_long");
  });
});

describe("deciding whether labels are mailed", () => {
  it("records keeping them in the lab, with the note, who decided and the reference", async () => {
    const { db, conn } = await world();
    const got = await decideMailing(db, { personId: 1, instruction: "keep_in_lab", note: " ENT 499, picked up in class ", decidedBy: "samstaff", reference: "issue 7" });
    expect(got).toEqual({ ok: true, outcome: "saved", was: "mail" });
    expect(await events(conn)).toEqual([[1, "keep_in_lab", "ENT 499, picked up in class", "samstaff", "issue 7"]]);
    expect(await now(conn)).toEqual([[1, "keep_in_lab", "ENT 499, picked up in class", "samstaff"]]);
  });

  it("records nothing for mail where nobody has decided, since mailing is the default", async () => {
    const { db, conn } = await world();
    expect(await decideMailing(db, { personId: 1, instruction: "mail", decidedBy: "samstaff" })).toEqual({
      ok: true,
      outcome: "unchanged",
      was: "mail",
    });
    expect(await events(conn)).toEqual([]);
  });

  it("records nothing for what is already so, and records a new note", async () => {
    const { db, conn } = await world();
    const keep = (note: string | null) => decideMailing(db, { personId: 1, instruction: "keep_in_lab", note, decidedBy: "samstaff" });
    await keep("ENT 499");
    expect(await keep("ENT 499")).toMatchObject({ outcome: "unchanged", was: "keep_in_lab" });
    expect(await keep("ENT 500")).toMatchObject({ outcome: "saved", was: "keep_in_lab" });
    expect(await keep(null)).toMatchObject({ outcome: "saved" });
    expect(await keep("")).toMatchObject({ outcome: "unchanged" });
    expect((await events(conn)).map((e) => e[2])).toEqual(["ENT 499", "ENT 500", null]);
    expect(await now(conn)).toEqual([[1, "keep_in_lab", null, "samstaff"]]);
  });

  it("puts a person back to mailing by recording it, and the view then has no row for them", async () => {
    const { db, conn } = await world();
    await decideMailing(db, { personId: 1, instruction: "keep_in_lab", note: "ENT 499", decidedBy: "samstaff" });
    expect(await decideMailing(db, { personId: 1, instruction: "mail", note: "ignored", decidedBy: "samstaff" })).toEqual({
      ok: true,
      outcome: "saved",
      was: "keep_in_lab",
    });
    expect(await now(conn)).toEqual([]);
    // The note belongs to keeping in the lab: it is not stored with mail.
    expect((await events(conn)).map((e) => [e[1], e[2]])).toEqual([["keep_in_lab", "ENT 499"], ["mail", null]]);
  });

  it("refuses an unknown person and a bad note, and stores nothing", async () => {
    const { db, conn } = await world();
    expect(await decideMailing(db, { personId: 99, instruction: "keep_in_lab", decidedBy: "samstaff" })).toEqual({ ok: false, refusal: "unknown_person" });
    for (const [note, why] of [
      ["write to ada@example.org", "has_at_sign"],
      ["97330", "has_long_number"],
      ["x".repeat(201), "too_long"],
    ] as const) {
      expect(await decideMailing(db, { personId: 1, instruction: "keep_in_lab", note, decidedBy: "samstaff" })).toEqual({ ok: false, refusal: "bad_note", why });
    }
    expect(await events(conn)).toEqual([]);
  });
});

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const ORIGIN = "http://localhost:3054";

async function page(asPerson: number) {
  const { instance, conn, db } = await world();
  const app = createApp({
    ...(await scratchPaths()),
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: ORIGIN },
    inat: unusedInat,
    resolveSession: async () => ({ personId: asPerson, login: "samstaff", iconUrl: null }),
    conn,
  });
  const post = (path: string, body: Record<string, string>, cookie?: string) =>
    app.request(path, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: new URLSearchParams(body),
    });
  return { app, conn, db, post };
}

describe("the Labels card on a person's page", () => {
  const p = en.people;

  it("says the labels are mailed until somebody decides otherwise", async () => {
    const { app } = await page(2);
    const body = await (await app.request("/people/ada")).text();
    expect(body).toContain(p.labelsHeading);
    expect(body).toContain(p.labelsNowMail);
    expect(body).toContain(p.labelsKeep);
    // The hint says never to write an address.
    expect(body).toContain("Never write an address or an email address here");
  });

  it("keeps their labels in the lab with a note, then shows the choice, who made it and the note", async () => {
    const { app, conn, post } = await page(2);
    const res = await post("/people/ada/mailing", { instruction: "keep_in_lab", note: "ENT 499, picked up in class" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(p.labelsSavedKeep);
    expect(await events(conn)).toEqual([[1, "keep_in_lab", "ENT 499, picked up in class", "samstaff", null]]);
    const body = await (await app.request("/people/ada")).text();
    expect(body).toContain("Kept in the lab. Decided by samstaff");
    expect(body).toContain("ENT 499, picked up in class");
    expect(body).toContain(`<option value="keep_in_lab" selected`);

    expect(await (await post("/people/ada/mailing", { instruction: "keep_in_lab", note: "ENT 499, picked up in class" })).text()).toContain(p.labelsUnchanged);
    expect(await (await post("/people/ada/mailing", { instruction: "mail" })).text()).toContain(p.labelsSavedMail);
    expect(await now(conn)).toEqual([]);
  });

  it("refuses a note that could be an address, says why, and stores nothing", async () => {
    const { conn, post } = await page(2);
    const res = await post("/people/ada/mailing", { instruction: "keep_in_lab", note: "ada@example.org" });
    const body = await res.text();
    expect(body).toContain(p.labelsNoteProblem.has_at_sign);
    expect(await events(conn)).toEqual([]);
    expect(await (await post("/people/1/mailing", { instruction: "keep_in_lab", note: "97330" })).text()).toContain(
      p.labelsNoteProblem.has_long_number,
    );
    expect(await events(conn)).toEqual([]);
  });

  it("refuses a choice that is neither, and a person nobody has heard of", async () => {
    const { conn, post } = await page(2);
    expect(await (await post("/people/ada/mailing", { instruction: "burn" })).text()).toContain("mail");
    expect((await post("/people/999/mailing", { instruction: "keep_in_lab" })).status).toBe(404);
    expect(await events(conn)).toEqual([]);
  });

  it("is for admins, and refused while viewing Beeline as somebody else", async () => {
    const volunteer = await page(3);
    expect((await volunteer.post("/people/ada/mailing", { instruction: "keep_in_lab" })).status).toBe(403);
    expect(await events(volunteer.conn)).toEqual([]);

    const staff = await page(2);
    const as = `${IMPERSONATING_COOKIE}=${encodeURIComponent("Ada Collector")}`;
    const res = await staff.post("/people/ada/mailing", { instruction: "keep_in_lab" }, as);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(en.errors.readOnlyImpersonating);
    expect(await events(staff.conn)).toEqual([]);
  });
});
