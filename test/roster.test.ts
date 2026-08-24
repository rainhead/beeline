import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import { createMemoryDb } from "./helpers.js";
import { createApp } from "../src/app/server.js";
import { readOverlay } from "../src/person-overlay.js";
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
    expect(body).toContain("No iNaturalist account");
  });

  it("says so when it has no legacy records to weigh bindings against", async () => {
    const body = await (await ctx.app.request("/people")).text();
    expect(body).toContain("cannot be weighed");
  });

  it("searches by name and by login", async () => {
    expect(await (await ctx.app.request("/people?q=netter")).text()).toContain("Bo Netter");
    expect(await (await ctx.app.request("/people?q=netter")).text()).not.toContain(">Ada Collector<");
    expect(await (await ctx.app.request("/people?q=adacollects")).text()).toContain("Ada Collector");
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
    const home = await ctx.db.selectFrom("person_home_atlas").where("person_id", "=", 1).selectAll().executeTakeFirst();
    expect(home).toBeDefined();
    const bad = await post(ctx.app, "/people/1/membership", { home_atlas: "ZZ", reason: "" });
    expect(await bad.text()).toContain("no atlas with code");
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

  it("merges, then sends you back to the roster because the page is gone", async () => {
    const res = await post(ctx.app, "/people/2/merge", { merge_into: "Ada Collector", reason: "same person" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/people");
    expect(await ctx.db.selectFrom("person").where("entity_id", "=", 2).selectAll().executeTakeFirst()).toBeUndefined();
    expect((await readOverlay(ctx.overlayPath))[0]).toMatchObject({
      person_ref: "name:Bo Netter",
      field: "merged_into",
      value: "name:Ada Collector",
    });
  });

  it("reports a merge target that names nobody, and merges nothing", async () => {
    const res = await post(ctx.app, "/people/2/merge", { merge_into: "Nobody Here", reason: "" });
    expect(await res.text()).toContain("no person named");
    expect(await ctx.db.selectFrom("person").where("entity_id", "=", 2).selectAll().executeTakeFirst()).toBeDefined();
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
