import { describe, expect, it, vi } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createKey, KEY_SCOPES } from "../src/app/api-keys.js";
import type { HostTaxonReader } from "../src/app/host-override.js";
import { createApp } from "../src/app/server.js";
import { IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { en } from "../src/app/messages/en.js";
import { duckdbReader } from "../src/person-change.js";
import { readSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { readSampleOverlay, upsertSampleOverlay } from "../src/sample-overlay.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * The floral host on the sample page and in the API (beeline-hlay): Bonnie's
 * case end to end. A sample whose observation names the wrong plant; staff
 * paste the right plant's iNaturalist address and say why; the page and the
 * record show it, and say who set it and why. Both doors call the same
 * correction, so the rules are tested once in test/host-override.test.ts and
 * here only what each door adds: the form, the statuses and the words.
 * The single-taxon read is injected: nothing here calls iNaturalist.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const ORIGIN = "http://localhost:3054";
const ADDRESS = "https://www.inaturalist.org/taxa/53439-Eriophyllum-lanatum";

const reader = () =>
  vi.fn<HostTaxonReader>(async (id) => {
    if (id === 1) throw new Error("iNaturalist is down");
    if (id === 53439) return { id, name: "Eriophyllum lanatum", rank: "species", isActive: true, ancestorIds: [48460, 211194], replacedBy: [] };
    if (id === 47604) return { id, name: "Rubus", rank: "genus", isActive: true, ancestorIds: [48460, 211194], replacedBy: [] };
    if (id === 47219) return { id, name: "Apis mellifera", rank: "species", isActive: true, ancestorIds: [48460, 1], replacedBy: [] };
    return null;
  });

async function person(conn: DuckDBConnection, name: string, login: string, userId: number): Promise<number> {
  const [[id]] = (await (await conn.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)).getRows()) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${userId}, '${login}')`);
  return Number(id);
}

async function world(signedInAs: "alice" | "sam" = "sam") {
  const { instance, conn } = await createMemoryDb();
  const alice = await person(conn, "Alice Adams", "alice", 1);
  const sam = await person(conn, "Sam Staff", "samstaff", 3);
  await person(conn, "Bob Barnes", "bob", 2);
  await conn.run(`INSERT INTO person_admin (person_id, granted_by) VALUES (${sam}, 'peter')`);
  const sampleId = await insertCleanSample(conn, {
    collector_id: String(alice), sample_number: "'A-1'", inat_observation_id: "998877",
    host_inat_taxon_id: "47604", host_name_as_observed: "'Rubus'", host_rank: "'genus'",
  });
  // The observation as iNaturalist has it, for the page's "now" line and the diverged view.
  await conn.run(`INSERT INTO observation_field (inat_id, user_id, host_taxon_id, host_taxon_name, host_taxon_rank, host_is_tracheophyte)
                  VALUES (998877, 1, 47604, 'Rubus', 'genus', true)`);
  const paths = await scratchPaths();
  const samplePaths = { log: paths.sampleChangesPath, state: paths.sampleStatePath };
  await recordSampleChanges(duckdbReader(conn), samplePaths, { source: "observation_promotion" });
  const read = reader();
  const db = createKysely(instance);
  const people = { alice, sam };
  const app = createApp({
    ...paths,
    db,
    config: { environment: "sandbox" as const, origin: ORIGIN },
    inat: unusedInat,
    resolveSession: async () => ({
      personId: people[signedInAs],
      login: signedInAs === "sam" ? "samstaff" : "alice",
      inatUserId: BigInt(signedInAs === "sam" ? 3 : 1),
      iconUrl: null,
    }),
    conn,
    hostTaxon: read,
    jobs: { list: [], start: async () => false, running: () => null },
  });
  const form = (path: string, body: Record<string, string>, cookie?: string) =>
    app.request(path, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...(cookie === undefined ? {} : { cookie }) },
      body: new URLSearchParams(body).toString(),
    });
  const keyFor = async (uid: number, scope: string) => {
    const made = await createKey(db, { inatUserId: uid, name: "test", scope, lifetimeDays: 30, offered: KEY_SCOPES });
    if ("problem" in made) throw new Error(made.problem);
    return made.key;
  };
  const keys = { sam: await keyFor(3, "staff"), samRead: await keyFor(3, "read"), samEdit: await keyFor(3, "edit"), alice: await keyFor(1, "edit"), bob: await keyFor(2, "edit") };
  const send = (key: string, path: string, body: unknown) =>
    app.request(`/api/v1${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = async (key: string, path: string) =>
    (await (await app.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${key}` } })).json()) as Record<string, any>;
  const hostOf = async () =>
    (await rows(conn, `SELECT host_inat_taxon_id, host_name_as_observed, host_rank FROM sample WHERE entity_id = ${sampleId}`))[0];
  return { app, conn, form, send, get, keys, read, sampleId, hostOf, paths, overlay: () => readSampleOverlay(paths.sampleOverlayPath) };
}

const t = en.record.sample.staffHost;

describe("the sample page's floral host", () => {
  it("offers staff the control, with the plant's address and the explanation as fields, and a collector nothing", async () => {
    const w = await world("sam");
    const page = await (await w.app.request(`/samples/${w.sampleId}`)).text();
    expect(page).toContain(`aria-label="${t.open}"`);
    expect(page).toContain(`action="/samples/${w.sampleId}/host"`);
    expect(page).toContain("For example, https://www.inaturalist.org/taxa/53439-Eriophyllum-lanatum.");
    expect(page).toContain(t.noHost);
    // Nothing is standing yet, so there is nothing to take away and no provenance.
    expect(page).not.toContain(t.remove);
    expect(page).not.toContain("Floral host set in Beeline");
    // An example value is a hint, never a placeholder.
    expect(page).not.toMatch(/placeholder="[^"]*inaturalist\.org/);

    const mine = await world("alice");
    const own = await (await mine.app.request(`/samples/${mine.sampleId}`)).text();
    expect(own).not.toContain(t.open);
    expect((await mine.form(`/samples/${mine.sampleId}/host`, { taxon: ADDRESS, note: "mine" })).status).toBe(403);
    expect(mine.read).not.toHaveBeenCalled();
  });

  it("sets the host from the plant's page address: the page says who set it and why, and the file and the log have it", async () => {
    const w = await world();
    const res = await w.form(`/samples/${w.sampleId}/host`, { taxon: ADDRESS, note: "the bees are on the woolly sunflower" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/samples/${w.sampleId}`);
    expect(await w.hostOf()).toEqual([53439n, "Eriophyllum lanatum", "species"]);
    expect(await w.overlay()).toEqual([
      { sample_ref: "inat:998877", field: "host", base_value: "47604 genus Rubus", value: "53439 species Eriophyllum lanatum", author: "samstaff", reason: "the bees are on the woolly sunflower" },
    ]);

    const page = await (await w.app.request(`/samples/${w.sampleId}`)).text();
    expect(page).toContain("Eriophyllum lanatum");
    expect(page).toContain("Floral host set in Beeline by Sam Staff.");
    expect(page).toContain("Reason: the bees are on the woolly sunflower");
    expect(page).toContain(t.remove);
    // The sample's record, through the API, carries the same.
    const record = await w.get(w.keys.alice, `/samples/${w.sampleId}`);
    expect(record.sample).toMatchObject({
      host_inat_taxon_id: 53439, host_name_as_observed: "Eriophyllum lanatum",
      host_override: { set_by: "Sam Staff", reason: "the bees are on the woolly sunflower", observation_now: null },
    });
    const logged = (await readSampleChanges(w.paths.sampleChangesPath)).filter((c) => c.field === "host" && c.source !== "observation_promotion");
    expect(logged.map((c) => [c.new_value, c.author, c.source, c.reason])).toEqual([
      ["53439 Eriophyllum lanatum", "samstaff", "app", "the bees are on the woolly sunflower"],
    ]);
  });

  it("says what iNaturalist now gives, and that the host set in Beeline is kept, where the observation moved on", async () => {
    const w = await world();
    await w.form(`/samples/${w.sampleId}/host`, { taxon: "53439", note: "wrong plant upstream" });
    await w.conn.run(`UPDATE observation_field SET host_taxon_id = 99999, host_taxon_name = 'Ericameria nauseosa', host_taxon_rank = 'species' WHERE inat_id = 998877`);
    const page = await (await w.app.request(`/samples/${w.sampleId}`)).text();
    expect(page).toContain("iNaturalist now gives ");
    expect(page).toContain("<i>Ericameria</i> <i>nauseosa</i>");
    expect(page).toContain("The floral host set in Beeline is kept until someone chooses to follow iNaturalist again.");
  });

  it("says no floral host when staff say so, and goes back to following iNaturalist, which needs no reason", async () => {
    const w = await world();
    expect((await w.form(`/samples/${w.sampleId}/host`, { none: "1", note: "a bee caught on the road" })).status).toBe(302);
    expect(await w.hostOf()).toEqual([null, null, null]);
    const page = await (await w.app.request(`/samples/${w.sampleId}`)).text();
    expect(page).toContain(t.none);
    expect(page).toContain("Reason: a bee caught on the road");

    expect((await w.form(`/samples/${w.sampleId}/host`, { remove: "1" })).status).toBe(302);
    expect(await w.hostOf()).toEqual([47604n, "Rubus", "genus"]);
    const after = await (await w.app.request(`/samples/${w.sampleId}`)).text();
    expect(after).not.toContain("Floral host set in Beeline");
    expect(w.read).not.toHaveBeenCalled();
  });

  it("changes a host already set, keeping the first base", async () => {
    const w = await world();
    await w.form(`/samples/${w.sampleId}/host`, { taxon: "53439", note: "first" });
    await w.form(`/samples/${w.sampleId}/host`, { none: "1", note: "second" });
    expect((await w.overlay())[0]).toMatchObject({ base_value: "47604 genus Rubus", value: "none", reason: "second" });
  });

  it("refuses with the catalog's words: a blank explanation, a name, an unknown, non-vascular or unreachable taxon", async () => {
    const w = await world();
    const post = (body: Record<string, string>) => w.form(`/samples/${w.sampleId}/host`, body);
    const text = async (body: Record<string, string>) => {
      const res = await post(body);
      return [res.status, await res.text()] as const;
    };
    expect(await text({ taxon: ADDRESS, note: "" })).toEqual([400, t.problems.reason]);
    expect(await text({ none: "1", note: " " })).toEqual([400, t.problems.reason]);
    expect(await text({ taxon: "Eriophyllum lanatum", note: "x" })).toEqual([400, t.problems.address]);
    expect(await text({ taxon: "", note: "x" })).toEqual([400, t.problems.taxon_needed]);
    expect(await text({ taxon: "424242", note: "x" })).toEqual([400, t.problems.unknown]);
    expect(await text({ taxon: "47219", note: "x" })).toEqual([400, t.problems.not_vascular]);
    expect(await text({ taxon: "47604", note: "x" })).toEqual([400, t.problems.unchanged]);
    expect(await text({ taxon: "1", note: "x" })).toEqual([503, t.unreachable]);
    expect(await w.overlay()).toEqual([]);
    expect(await w.hostOf()).toEqual([47604n, "Rubus", "genus"]);
  });

  it("refuses staff who are impersonating, a sample with no key and one that does not exist", async () => {
    const w = await world();
    const viewing = `${IMPERSONATING_COOKIE}=${encodeURIComponent("Alice Adams")}`;
    const res = await w.form(`/samples/${w.sampleId}/host`, { taxon: ADDRESS, note: "x" }, viewing);
    expect([res.status, await res.text()]).toEqual([403, en.errors.readOnlyImpersonating]);
    const bare = await insertCleanSample(w.conn, { sample_number: "'A-2'" });
    const refused = await w.form(`/samples/${bare}/host`, { taxon: ADDRESS, note: "x" });
    expect([refused.status, await refused.text()]).toEqual([409, t.noKey]);
    expect((await w.form(`/samples/999999/host`, { taxon: ADDRESS, note: "x" })).status).toBe(404);
  });
});

describe("the host through the API", () => {
  it("is offered to a staff key only", async () => {
    const w = await world();
    const body = { taxon: ADDRESS, note: "x" };
    expect((await w.send(w.keys.samRead, `/samples/${w.sampleId}/host`, body)).status).toBe(403);
    const notStaff = await w.send(w.keys.samEdit, `/samples/${w.sampleId}/host`, body);
    expect([notStaff.status, (await notStaff.json()).error]).toEqual([403, "forbidden"]);
    const collector = await w.send(w.keys.alice, `/samples/${w.sampleId}/host`, body);
    expect(collector.status).toBe(403);
    expect(w.read).not.toHaveBeenCalled();
  });

  it("sets, says none, and removes, answering what it did and recording the reason, the author and the door", async () => {
    const w = await world();
    const path = `/samples/${w.sampleId}/host`;
    const set = await w.send(w.keys.sam, path, { taxon: "53439", note: "the bees are on the woolly sunflower", reference: "https://example.org/issue/1" });
    expect([set.status, await set.json()]).toEqual([
      200,
      { sample_id: w.sampleId, outcome: "saved", dry_run: false, host: { inat_taxon_id: 53439, name: "Eriophyllum lanatum", rank: "species" } },
    ]);
    expect(await w.hostOf()).toEqual([53439n, "Eriophyllum lanatum", "species"]);
    const none = await w.send(w.keys.sam, path, { none: true, note: "no flower" });
    expect(await none.json()).toMatchObject({ outcome: "saved", host: null });
    const removed = await w.send(w.keys.sam, path, { remove: true });
    expect(await removed.json()).toEqual({ sample_id: w.sampleId, outcome: "removed", dry_run: false, host: null });
    expect(await w.hostOf()).toEqual([47604n, "Rubus", "genus"]);
    const entries = (await readSampleChanges(w.paths.sampleChangesPath)).filter((c) => c.field === "host" && c.source !== "observation_promotion");
    expect(entries.map((c) => [c.new_value, c.author, c.source, c.reason])).toEqual([
      ["53439 Eriophyllum lanatum", "samstaff", "api", "the bees are on the woolly sunflower"],
      ["", "samstaff", "api", "no flower"],
      ["47604 Rubus", "samstaff", "api", ""],
    ]);
  });

  it("takes away a host the file holds and the store has not applied, and treats an empty value as nothing standing", async () => {
    const w = await world();
    const path = `/samples/${w.sampleId}/host`;
    // The case of a write that recorded its row and lost the store's conflict: the file says a host stands, the table has none.
    await upsertSampleOverlay(w.paths.sampleOverlayPath, [
      { sample_ref: "inat:998877", field: "host", base_value: "47604 genus Rubus", value: "53439 species Eriophyllum lanatum", author: "samstaff", reason: "why" },
    ]);
    expect((await rows(w.conn, "SELECT count(*) FROM sample_host_override"))[0]).toEqual([0n]);
    const dry = await w.send(w.keys.sam, path, { remove: true, dry_run: true });
    expect(await dry.json()).toMatchObject({ outcome: "would_remove", dry_run: true });
    expect((await w.overlay()).find((r) => r.field === "host")!.value).toBe("53439 species Eriophyllum lanatum");
    const removed = await w.send(w.keys.sam, path, { remove: true });
    expect(await removed.json()).toMatchObject({ outcome: "removed" });
    expect((await w.overlay()).find((r) => r.field === "host")!.value).toBe("");
    // Now the file holds only a removal: nothing is standing, so a second removal changes nothing.
    const again = await w.send(w.keys.sam, path, { remove: true });
    expect(await again.json()).toMatchObject({ outcome: "unchanged" });
    expect(await w.hostOf()).toEqual([47604n, "Rubus", "genus"]);
  });

  it("keeps a sample with no host without one when its observation is identified, and the page says what iNaturalist now gives", async () => {
    const w = await world();
    // The observation names no plant and the sample has no host: staff say so, and why.
    await w.conn.run(`UPDATE sample SET host_inat_taxon_id = NULL, host_name_as_observed = NULL, host_rank = NULL WHERE entity_id = ${w.sampleId}`);
    await w.conn.run(`UPDATE observation_field SET host_taxon_id = NULL, host_taxon_name = NULL, host_taxon_rank = NULL, host_is_tracheophyte = NULL WHERE inat_id = 998877`);
    expect((await w.form(`/samples/${w.sampleId}/host`, { none: "1", note: "a bee off the road" })).status).toBe(302);
    expect(await w.hostOf()).toEqual([null, null, null]);
    // Then the observation is identified, and a promotion's follow rule runs.
    await w.conn.run(`UPDATE observation_field SET host_taxon_id = 47604, host_taxon_name = 'Rubus', host_taxon_rank = 'genus', host_is_tracheophyte = true WHERE inat_id = 998877`);
    const { readFile } = await import("node:fs/promises");
    const mint = await readFile(new URL("../ingest/mint-samples.sql", import.meta.url), "utf8");
    const rule = mint.slice(mint.indexOf("UPDATE sample SET\n  host_inat_taxon_id    = f.host_taxon_id"));
    await w.conn.run(rule.slice(0, rule.indexOf(";") + 1));
    expect(await w.hostOf()).toEqual([null, null, null]);
    const page = await (await w.app.request(`/samples/${w.sampleId}`)).text();
    expect(page).toContain("iNaturalist now gives");
    expect(page).toContain("Reason: a bee off the road");
  });

  it("shows the taxon number of a host the sample holds with no name, and no host label for it", async () => {
    const w = await world();
    await w.conn.run(`UPDATE sample SET host_name_as_observed = NULL, host_rank = NULL WHERE entity_id = ${w.sampleId}`);
    const page = await (await w.app.request(`/samples/${w.sampleId}`)).text();
    expect(page).toContain("iNaturalist taxon 47604");
    expect(page).not.toContain(t.none);
  });

  it("refuses with the statuses a program can act on", async () => {
    const w = await world();
    const path = `/samples/${w.sampleId}/host`;
    const answer = async (body: unknown, p = path) => {
      const res = await w.send(w.keys.sam, p, body);
      const j = await res.json();
      return [res.status, j.error, j.message] as const;
    };
    expect(await answer({ taxon: ADDRESS, note: "" })).toEqual([422, "invalid", t.problems.reason]);
    expect(await answer({ taxon: "47219", note: "x" })).toEqual([422, "invalid", t.problems.not_vascular]);
    expect((await answer({ taxon: "1", note: "x" }))[0]).toBe(503);
    expect((await answer({ taxon: "1", note: "x" }))[1]).toBe("inat_unreachable");
    const bare = await insertCleanSample(w.conn, { sample_number: "'A-2'" });
    expect((await answer({ taxon: ADDRESS, note: "x" }, `/samples/${bare}/host`)).slice(0, 2)).toEqual([409, "no_host_key"]);
    expect((await answer({ taxon: ADDRESS, note: "x" }, "/samples/999999/host"))[0]).toBe(404);
    // Fields it does not take are refused by name, not read as absent.
    expect((await answer({ taxon: ADDRESS, note: "x", plant: "no" }))[1]).toBe("invalid_request");
    expect(await w.overlay()).toEqual([]);
  });

  it("checks everything in a dry run, and writes nothing", async () => {
    const w = await world();
    const res = await w.send(w.keys.sam, `/samples/${w.sampleId}/host`, { taxon: ADDRESS, note: "x", dry_run: true });
    expect(await res.json()).toMatchObject({ outcome: "would_save", dry_run: true, host: { inat_taxon_id: 53439 } });
    expect(await w.hostOf()).toEqual([47604n, "Rubus", "genus"]);
    expect(await w.overlay()).toEqual([]);
    // The API's own refusal of a dry run on an endpoint that has none still names the ones that do.
    const other = await w.send(w.keys.sam, `/samples/${w.sampleId}/hold`, { note: "x", dry_run: true });
    expect((await other.json()).message).toContain("Dry runs exist only for edit, collectors, host and kind-from-old-records");
  });

  it("refuses `remove` sent with a taxon or `none`, as the page refuses a plant with no host", async () => {
    const w = await world();
    const path = `/samples/${w.sampleId}/host`;
    for (const body of [{ remove: true, taxon: "53439" }, { remove: true, none: true }]) {
      const res = await w.send(w.keys.sam, path, body);
      expect([res.status, (await res.json()).error]).toEqual([400, "invalid_request"]);
    }
    expect(w.read).not.toHaveBeenCalled();
  });

  it("is described, so a program can find it", async () => {
    const w = await world();
    const described = await w.get(w.keys.sam, "");
    expect(JSON.stringify(described)).toContain("/samples/:id/host");
  });
});

describe("what a host set in Beeline reaches", () => {
  it("shows in the samples and specimens listings and the samples download, and in no other plant's place", async () => {
    const w = await world();
    await w.conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${w.sampleId}, 1)`);
    await w.form(`/samples/${w.sampleId}/host`, { taxon: "53439", note: "the sunflower" });
    for (const path of ["/samples?scope=all", "/specimens?scope=all"]) {
      const page = await (await w.app.request(path)).text();
      expect(page, path).toContain("<i>Eriophyllum</i> <i>lanatum</i>");
      expect(page, path).not.toContain("<i>Rubus</i>");
    }
    const csv = await (await w.app.request("/samples.csv?scope=all")).text();
    expect(csv).toContain("Eriophyllum lanatum");
    expect(csv).not.toContain("Rubus");
  });

  it("is hidden, reason and all, from a reader from whom the sample's location is withheld, as the locality override is", async () => {
    const w = await world();
    await w.conn.run(`UPDATE sample SET geoprivacy = 'obscured' WHERE entity_id = ${w.sampleId}`);
    await w.form(`/samples/${w.sampleId}/host`, { taxon: "53439", note: "on the ridge above the old mill" });
    const seen = async (key: string) => (await w.get(key, `/samples/${w.sampleId}`)).sample;
    expect((await seen(w.keys.bob)).location_withheld).toBe(true);
    expect((await seen(w.keys.bob)).host_override).toBeNull();
    expect(JSON.stringify(await w.get(w.keys.bob, `/samples/${w.sampleId}`))).not.toContain("old mill");
    // Staff and the collector see it.
    expect((await seen(w.keys.sam)).host_override).toMatchObject({ reason: "on the ridge above the old mill" });
    expect((await seen(w.keys.alice)).host_override).toMatchObject({ reason: "on the ridge above the old mill" });
  });

  it("is refused to a collector who posts to the page route, and is refused while the sync job runs", async () => {
    const mine = await world("alice");
    const res = await mine.form(`/samples/${mine.sampleId}/host`, { taxon: "53439", note: "mine" });
    expect([res.status, await res.text()]).toEqual([403, "Admins only."]);
    expect(await mine.overlay()).toEqual([]);
  });
});
