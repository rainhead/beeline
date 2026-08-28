import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import { insertCleanSample } from "./helpers.js";
import { createMemoryDb } from "./helpers.js";
import { createApp } from "../src/app/server.js";
import { readOverlay, type PersonOverlayRow } from "../src/person-overlay.js";
import { seedAdmins } from "../src/app/db.js";
import type { InatClient } from "../src/app/auth.js";

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

/**
 * The roster screen. Sandbox, not development, because development makes
 * everyone an admin and the gate is half of what these tests check.
 */
async function rosterApp(signedIn: { personId: number; admin: boolean }) {
  const { instance, conn } = await createMemoryDb();
  await conn.run(`INSERT INTO person (entity_id, display_name, given_name, family_name)
                  VALUES (1, 'Ada Collector', 'Ada', 'Collector'),
                         (2, 'Bo Netter', 'Bo', 'Netter'),
                         (3, 'Staff Person', 'Staff', 'Person')`);
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login)
                  VALUES (1, 111, 'adacollects'), (3, 333, 'staffer')`);
  if (signedIn.admin) await conn.run(`INSERT INTO person_admin (person_id) VALUES (${signedIn.personId})`);

  const dir = await mkdtemp(join(tmpdir(), "roster-"));
  const overlayPath = join(dir, "person-overlay.csv");
  const db = createKysely(instance);
  const app = createApp({
    db,
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: signedIn.personId, login: "whoever", iconUrl: null }),
    personOverlayPath: overlayPath,
    conn,
  });
  return { app, db, conn, overlayPath };
}

const post = (app: Awaited<ReturnType<typeof rosterApp>>["app"], path: string, body: Record<string, string>) =>
  app.request(path, {
    method: "POST",
    headers: { origin: "http://localhost:3054", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

describe("the roster screen", () => {
  let ctx: Awaited<ReturnType<typeof rosterApp>>;
  beforeEach(async () => {
    ctx = await rosterApp({ personId: 3, admin: true });
  });

  it("is admin-only, like the rest of the staff surface", async () => {
    const volunteer = await rosterApp({ personId: 1, admin: false });
    expect((await volunteer.app.request("/people")).status).toBe(403);
    expect((await volunteer.app.request("/people/1")).status).toBe(403);
    expect((await post(volunteer.app, "/people/1/admin", { admin: "yes" })).status).toBe(403);
    // And a volunteer is not invited: the nav does not offer it.
    expect(await (await volunteer.app.request("/glossary")).text()).not.toContain(`href="/people"`);
  });

  it("lists everyone, including the people who cannot sign in", async () => {
    const body = await (await ctx.app.request("/people")).text();
    expect(body).toContain("Ada Collector");
    expect(body).toContain("Bo Netter");
    expect(body).toContain("adacollects");
    // Bo has no account, which is the whole reason to show them.
    expect(body).toContain("No account");
  });

  it("is a listing of people, with no column about our own checking", async () => {
    // beeline-eyk: 'Evidence' meant something to the one person doing the
    // checking and nothing to anyone else. The columns are about people.
    const body = await (await ctx.app.request("/people")).text();
    expect(body).not.toContain("Evidence");
    expect(body).not.toContain("binding");
    for (const column of ["Person", "iNaturalist account", "Samples", "Belongs to", "Admin"]) {
      expect(body).toContain(`<th>${column}</th>`);
    }
  });

  it("drops the checking apparatus entirely when there is nothing to check against", async () => {
    // No legacy staging — which is also this screen after cutover. Not a
    // banner explaining that verdicts are unavailable: no verdicts, no
    // filter, nothing but people.
    const body = await (await ctx.app.request("/people")).text();
    expect(body).not.toContain("Only accounts that look wrong");
    expect(body).not.toContain("do not match");
  });

  /**
   * With staging attached there is something to weigh an account against, and
   * the two shapes of wrong have to be visible without a column of their own.
   */
  describe("when an account can be weighed against the records behind it", () => {
    beforeEach(async () => {
      await ctx.conn.run(`CREATE TABLE legacy_person_map AS
        SELECT * FROM (VALUES (1, 'Ada', 'Collector'), (3, 'Staff', 'Person'))
        t(person_id, fn, ln)`);
      // Ada's account is the one her records use. Staff Person is bound to an
      // account one record mentions while forty use another — the Andony shape
      // (beeline-eft), and the whole reason this screen weighs anything.
      await ctx.conn.run(`CREATE TABLE legacy_occurrence AS
        SELECT * FROM (VALUES
          ('Ada', 'Collector', 'adacollects', '111', 5),
          ('Staff', 'Person', 'staffer', '333', 1),
          ('Staff', 'Person', 'busierlogin', '999', 40))
        t(firstName, lastName, userLogin, userId, copies),
        LATERAL range(copies)`);
    });

    it("says so on the row that is wrong, and says nothing on the ones that are not", async () => {
      const body = await (await ctx.app.request("/people")).text();
      expect(body).toContain("probably the wrong account");
      // Ada's binding is fine, and a listing of people is quiet about that.
      expect(body).not.toContain("backed");
      expect(body.match(/probably the wrong account/g)).toHaveLength(1);
    });

    it("counts them above the table, since the listing no longer sorts them first", async () => {
      // Ordered as a roster, so a wrong account on page 8 would otherwise be
      // invisible to anyone who did not already know to go looking.
      const body = await (await ctx.app.request("/people")).text();
      expect(body).toContain("1 person has an account that does not match");
      expect(body).toContain(`href="/people?suspect=1"`);
    });

    it("filters to exactly those, and stops counting once it has", async () => {
      const body = await (await ctx.app.request("/people?suspect=1")).text();
      expect(body).toContain("Staff Person");
      expect(body).not.toContain(">Ada Collector<");
      expect(body).not.toContain("does not match"); // the invitation, once taken
    });

    it("spells the doubt out where somebody acts on it", async () => {
      // The row carries a chip; the person's own page carries the sentence,
      // with the number that makes it a judgement rather than an assertion.
      const body = await (await ctx.app.request("/people/3")).text();
      expect(body).toContain("Only 1 of their records uses this account. 40 use busierlogin instead.");
    });
  });

  /**
   * A household shares one iNaturalist login, and inat_user_id is unique, so
   * only one of them can hold it. The other's row is blank where the truth is
   * "signs in as the other one" — Robert Pederson, 1,087 samples and no way
   * in, beside Gretchen who holds pandg (beeline-eyk).
   */
  it("says whose account an unbound person's records point at", async () => {
    await ctx.conn.run(`INSERT INTO person (entity_id, display_name) VALUES (4, 'Partner Pederson')`);
    await ctx.conn.run(`CREATE TABLE legacy_person_map AS
      SELECT * FROM (VALUES (1, 'Ada', 'Collector'), (4, 'Partner', 'Pederson')) t(person_id, fn, ln)`);
    await ctx.conn.run(`CREATE TABLE legacy_occurrence AS
      SELECT * FROM (VALUES ('Partner', 'Pederson', 'adacollects', '111', 9)) t(firstName, lastName, userLogin, userId, copies),
      LATERAL range(copies)`);

    const body = await (await ctx.app.request("/people?q=Partner")).text();
    expect(body).toContain("No account");
    expect(body).toContain("Their records use adacollects, which is Ada Collector&#39;s.");

    // And at length where somebody would act on it.
    const person = await (await ctx.app.request("/people/4")).text();
    expect(person).toContain("9 of their records use adacollects, which is Ada Collector&#39;s");
    expect(person).toContain("a shared login only one person can hold");
  });

  it("shows when they last collected and when they were last here", async () => {
    // Two readings of the same question — is this person still active — and
    // neither is derivable from the other: somebody can collect for years
    // without signing in, and sign in without having collected since 2019.
    await insertCleanSample(ctx.conn, {
      collector_id: "1",
      date_start: "DATE '2025-08-12'",
      date_end: "DATE '2025-08-12'",
    });
    const body = await (await ctx.app.request("/people?q=Ada")).text();
    expect(body).toContain("<th>Last sample</th>");
    expect(body).toContain("<th>Last seen</th>");
    expect(body).toContain("Aug 12, 2025");
  });

  it("has no answer for last seen rather than a wrong one, with no private store", async () => {
    // createMemoryDb attaches no private store, which is also a CLI run or a
    // restore. An em dash, not a crash and not today's date.
    const body = await (await ctx.app.request("/people?q=Bo")).text();
    expect(body).toContain("<th>Last seen</th>");
    expect((await ctx.app.request("/people")).status).toBe(200);
  });

  it("searches by name and by login", async () => {
    expect(await (await ctx.app.request("/people?q=netter")).text()).toContain("Bo Netter");
    expect(await (await ctx.app.request("/people?q=netter")).text()).not.toContain(">Ada Collector<");
    expect(await (await ctx.app.request("/people?q=adacollects")).text()).toContain("Ada Collector");
  });

  /**
   * A person is reachable by login as well as by entity_id, and links prefer
   * the login. Neither handle is permanent, but an entity_id is a per-store
   * sequence draw (ADR 0002) that a rebuild redraws — /people/722436 was Steve
   * Lang in one promotion of the sandbox and Robert Pederson in the next —
   * while a login changes only when its owner changes it (beeline-eyk).
   */
  describe("addressing a person", () => {
    it("resolves a login, and the numeric id still works", async () => {
      const byLogin = await ctx.app.request("/people/adacollects");
      expect(byLogin.status).toBe(200);
      expect(await byLogin.text()).toContain("Ada Collector");
      // Old links keep working; nothing about this is a migration.
      const byId = await ctx.app.request("/people/1");
      expect(byId.status).toBe(200);
      expect(await byId.text()).toContain("Ada Collector");
    });

    it("matches a login case-insensitively, since a typed URL will not be cased", async () => {
      expect((await ctx.app.request("/people/AdaCollects")).status).toBe(200);
    });

    it("links to the login where there is one, and to the id where there is not", async () => {
      const body = await (await ctx.app.request("/people")).text();
      expect(body).toContain(`href="/people/adacollects"`);
      // Bo Netter has no account, so there is no login to prefer.
      expect(body).toContain(`href="/people/2"`);
    });

    it("posts back to the handle the page was asked for", async () => {
      // Rebinding an account can change the handle underneath the form, so the
      // action has to be the one the URL used, not the one it will become.
      const body = await (await ctx.app.request("/people/adacollects")).text();
      expect(body).toContain(`action="/people/adacollects/account"`);
      const res = await post(ctx.app, "/people/adacollects/admin", { admin: "yes", reason: "by login" });
      expect(res.status).toBe(200);
      const admins = await ctx.db.selectFrom("person_admin").select("person_id").execute();
      expect(admins.map((a) => a.person_id)).toContain(1);
    });

    it("404s an unknown login rather than falling back to somebody", async () => {
      expect((await ctx.app.request("/people/nobodyhere")).status).toBe(404);
    });
  });

  it("returns 404 for a person who is not there, rather than an empty page", async () => {
    expect((await ctx.app.request("/people/9999")).status).toBe(404);
  });

  it("records every decision in the overlay AND applies it, in that order", async () => {
    const res = await post(ctx.app, "/people/1/admin", { admin: "yes", reason: "runs the atlas" });
    expect(res.status).toBe(200);

    // Applied to the store...
    const admins = await ctx.db.selectFrom("person_admin").select("person_id").execute();
    expect(admins.map((a) => a.person_id)).toContain(1);

    // ...and durable, keyed by a name a rebuild reproduces rather than by the
    // entity_id, which is a per-store sequence draw.
    const saved = await readOverlay(ctx.overlayPath);
    expect(saved).toEqual([
      { person_ref: "name:Ada Collector", field: "admin", value: "yes", author: "whoever", reason: "runs the atlas" },
    ]);
  });

  it("records who granted admin, not the mechanism that carried it", async () => {
    await post(ctx.app, "/people/1/admin", { admin: "yes", reason: "runs the atlas" });
    const grant = await ctx.db.selectFrom("person_admin").where("person_id", "=", 1).selectAll().executeTakeFirst();
    expect(grant!.granted_by).toBe("whoever"); // the signed-in author, not 'overlay'
  });

  it("rebinds an account, keeping the login beside the id in the record", async () => {
    await post(ctx.app, "/people/1/account", {
      inat_user_id: "429964",
      login: "amelathopoulos",
      reason: "3,019 records file under it",
    });
    const account = await ctx.db.selectFrom("inat_account").where("person_id", "=", 1).selectAll().executeTakeFirst();
    expect(Number(account!.inat_user_id)).toBe(429964);
    expect(account!.login).toBe("amelathopoulos");
    expect((await readOverlay(ctx.overlayPath))[0]!.value).toBe("429964 amelathopoulos");
  });

  it("refuses a binding another person holds, and says why instead of failing quietly", async () => {
    const res = await post(ctx.app, "/people/1/account", { inat_user_id: "333", login: "staffer", reason: "" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("already bound");
    // Person 1 keeps the account they had.
    const account = await ctx.db.selectFrom("inat_account").where("person_id", "=", 1).selectAll().executeTakeFirst();
    expect(Number(account!.inat_user_id)).toBe(111);
  });

  it("unbinds, which is how someone stops being able to sign in", async () => {
    await post(ctx.app, "/people/1/account", { inat_user_id: "", reason: "wrong person" });
    expect(await ctx.db.selectFrom("inat_account").where("person_id", "=", 1).selectAll().executeTakeFirst()).toBeUndefined();
  });

  it("sets a home atlas, and refuses a code no atlas has", async () => {
    await post(ctx.app, "/people/1/membership", { home_atlas: "WaBA", reason: "" });
    const home = await ctx.db.selectFrom("person_membership").where("person_id", "=", 1).selectAll().executeTakeFirst();
    expect(home?.kind).toBe("atlas");
    const bad = await post(ctx.app, "/people/1/membership", { home_atlas: "ZZ", reason: "" });
    expect(await bad.text()).toContain("no atlas with code");
  });

  // Absence has to keep meaning one thing: clearing is "nobody has said",
  // and the program is somebody saying "no member atlas" (beeline-lcl).
  it("records belonging to the program itself, which is not the same as clearing it", async () => {
    await post(ctx.app, "/people/1/membership", { home_atlas: "program", reason: "collects in Nevada" });
    const row = await ctx.db.selectFrom("person_membership").where("person_id", "=", 1).selectAll().executeTakeFirst();
    expect(row).toMatchObject({ kind: "program", atlas_id: null });

    await post(ctx.app, "/people/1/membership", { home_atlas: "", reason: "asked too soon" });
    expect(
      await ctx.db.selectFrom("person_membership").where("person_id", "=", 1).selectAll().executeTakeFirst(),
    ).toBeUndefined();
  });

  it("saves name parts, and clears the label override with a blank", async () => {
    await post(ctx.app, "/people/1/names", {
      display_name: "Ada Collector",
      given_name: "Ada",
      family_name: "Collector-Smith",
      label_name: "",
      reason: "married",
    });
    const person = await ctx.db.selectFrom("person").where("entity_id", "=", 1).selectAll().executeTakeFirst();
    expect(person!.family_name).toBe("Collector-Smith");
    expect(person!.label_name).toBeNull();
  });

  it("revoking your own admin rights takes effect on the next request", async () => {
    // The roster is the one screen that can lock its user out; better that it
    // simply works than that it pretends to and leaves a stale session admin.
    await post(ctx.app, "/people/3/admin", { admin: "no", reason: "stepping back" });
    expect((await ctx.app.request("/people")).status).toBe(403);
  });

  it("writes a file promotion can replay verbatim", async () => {
    await post(ctx.app, "/people/1/admin", { admin: "yes", reason: "" });
    const text = await readFile(ctx.overlayPath, "utf8");
    expect(text.split("\n")[0]).toBe("person_ref,field,value,author,reason");
  });
});

describe("the admin bootstrap seed", () => {
  const store = async () => {
    const { instance, conn } = await createMemoryDb();
    await conn.run(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Ada Collector')`);
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (1, 111, 'adacollects')`);
    return { db: createKysely(instance), conn };
  };
  const decision = (field: string, value = "no", ref = "name:Ada Collector"): PersonOverlayRow =>
    ({ person_ref: ref, field, value, author: "staffer", reason: "" }) as PersonOverlayRow;

  it("lets a store nobody has granted anything in", async () => {
    const { db } = await store();
    expect(await seedAdmins(db, ["adacollects"], [])).toBe(1);
  });

  it("leaves someone who already holds it alone, and says so by seeding nobody", async () => {
    const { db, conn } = await store();
    await conn.run(`INSERT INTO person_admin (person_id) VALUES (1)`);
    expect(await seedAdmins(db, ["adacollects"], [])).toBe(0);
  });

  it("does not resurrect a revocation of this person", async () => {
    // The table alone cannot tell "never granted" from "deliberately revoked".
    // The overlay can, because every decision lands there first — so revoking
    // someone on the checked-in list stays revoked across a restart.
    const { db } = await store();
    expect(await seedAdmins(db, ["adacollects"], [decision("admin")])).toBe(0);
    expect(await seedAdmins(db, ["adacollects"], [decision("admin", "no", "inat:111")])).toBe(0);
  });

  it("is not put off by decisions about anything else", async () => {
    const { db } = await store();
    expect(await seedAdmins(db, ["adacollects"], [decision("home_atlas")])).toBe(1);
  });

  it("skips a login with no account rather than failing the boot", async () => {
    const { db } = await store();
    expect(await seedAdmins(db, ["adacollects", "nobody-here"], [])).toBe(1);
  });

  // What locked the sandbox out on 2026-08-28. db:reseed does not carry
  // person_admin, so a reseeded store rebuilds the roster from the overlay
  // alone — and the only admin decision anyone had written was a grant to one
  // new staff member. Her row alone made the table non-empty and the overlay
  // non-silent, which under the old all-or-nothing guard disabled the
  // bootstrap for everyone who had only ever been in it.
  it("re-grants the checked-in list after a reseed leaves somebody else's grant standing", async () => {
    const { db, conn } = await store();
    await conn.run(`INSERT INTO person (entity_id, display_name) VALUES (2, 'Nora Jacobi')`);
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (2, 222, 'norajacobi')`);
    // Promotion applied her grant; nobody else has a row.
    await conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (2, 'rainhead')`);
    expect(await seedAdmins(db, ["adacollects"], [decision("admin", "yes", "name:Nora Jacobi")])).toBe(1);
    const rows = await db.selectFrom("person_admin").select("person_id").orderBy("person_id").execute();
    expect(rows.map((r) => r.person_id)).toEqual([1, 2]);
  });

  // The same bug's quietest symptom: an account backfilled after the seed ran
  // meant that person was never an admin at all, because the roster was no
  // longer empty and the seed refused to top it up.
  it("tops up someone whose account arrived after the first seed", async () => {
    const { db, conn } = await store();
    await conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (1, 'seed')`);
    await conn.run(`INSERT INTO person (entity_id, display_name) VALUES (3, 'Caleb Lankford')`);
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (3, 333, 'clankford')`);
    expect(await seedAdmins(db, ["adacollects", "clankford"], [])).toBe(1);
    const rows = await db.selectFrom("person_admin").select("person_id").orderBy("person_id").execute();
    expect(rows.map((r) => r.person_id)).toEqual([1, 3]);
  });
});

// beeline-oyl. Staff grant it, not the person represented — who by definition
// cannot sign in, which is the whole reason the grant exists.
describe("granting one person reach over another", () => {
  let ctx: Awaited<ReturnType<typeof rosterApp>>;
  beforeEach(async () => {
    ctx = await rosterApp({ personId: 3, admin: true });
  });

  it("records the grant in the overlay and applies it to the store", async () => {
    const res = await post(ctx.app, "/people/adacollects/delegate", {
      acts_for: "name:Bo Netter",
      reason: "one household, one login",
    });
    expect(res.status).toBe(200);

    const written = await readOverlay(ctx.overlayPath);
    expect(written).toContainEqual(
      expect.objectContaining({
        person_ref: "name:Ada Collector",
        field: "acts_for",
        value: "name:Bo Netter",
        author: "whoever",
        reason: "one household, one login",
      }) as unknown as PersonOverlayRow,
    );
    const applied = await ctx.conn.run(
      `SELECT p.display_name FROM person_delegate d JOIN person p ON p.entity_id = d.acts_for_id
       WHERE d.person_id = 1`,
    );
    expect((await applied.getRows()).flat()).toEqual(["Bo Netter"]);
  });

  it("shows the current grant back in the form, in the words the overlay uses", async () => {
    await post(ctx.app, "/people/adacollects/delegate", { acts_for: "name:Bo Netter", reason: "" });
    const page = await (await ctx.app.request("/people/adacollects")).text();
    expect(page).toContain('value="name:Bo Netter"');
  });

  it("revokes every grant on an empty field", async () => {
    await post(ctx.app, "/people/adacollects/delegate", { acts_for: "name:Bo Netter", reason: "" });
    await post(ctx.app, "/people/adacollects/delegate", { acts_for: "", reason: "moved out" });
    const rows = await (await ctx.conn.run(`SELECT count(*) FROM person_delegate`)).getRows();
    expect(rows.flat()).toEqual([0n]);
  });

  it("reports a reference that names nobody instead of guessing", async () => {
    const res = await post(ctx.app, "/people/adacollects/delegate", {
      acts_for: "name:Nobody At All",
      reason: "",
    });
    // The apostrophes come back HTML-escaped, which is the point of rendering
    // the reason rather than interpolating it.
    expect(await res.text()).toContain("no person named &#39;Nobody At All&#39;");
  });
});
