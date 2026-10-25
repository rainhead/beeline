import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { applySampleOverlay, refreshWaivers } from "../src/apply-sample-overlay.js";
import { applyPersonOverlay } from "../src/apply-person-overlay.js";
import { findingText } from "../src/app/qc-decisions.js";
import { prepareRun } from "../src/print-run.js";
import { parseSampleOverlay, readSampleOverlay, type SampleOverlayRow } from "../src/sample-overlay.js";
import { createMemoryDb, CURRENT_SEASON, currentSeasonDate, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * Staff holds and waivers (beeline-plu, beeline-1kb.9). A hold keeps a sample
 * from printing until an admin lifts it; a waiver lets one blocking flag
 * staff judged fine print, for as long as the flag says what it said. Both
 * are rows in the sample overlay, which a rebuild replays.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

async function person(conn: DuckDBConnection, name: string, login: string, userId: number): Promise<number> {
  const [[id]] = (await (
    await conn.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)
  ).getRows()) as [[number]];
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${userId}, '${login}')`);
  return Number(id);
}

const printable = async (conn: DuckDBConnection, sampleId: number) =>
  (await rows(conn, `SELECT 1 FROM printable_sample WHERE sample_id = ${sampleId}`)).length === 1;

const flags = async (conn: DuckDBConnection, sampleId: number) =>
  await rows(conn, `SELECT rule_name, details FROM sample_qc_finding WHERE sample_id = ${sampleId} ORDER BY rule_name`);

const row = (fields: Partial<SampleOverlayRow> & Pick<SampleOverlayRow, "field" | "value">): SampleOverlayRow => ({
  sample_ref: "inat:998877",
  base_value: "",
  author: "samstaff",
  reason: "",
  ...fields,
});

describe("a hold", () => {
  it("is a blocking flag carrying the note, and lifting it releases the sample", async () => {
    const { conn } = await createMemoryDb();
    const alice = await person(conn, "Alice Adams", "alice", 1);
    const sampleId = await insertCleanSample(conn, { collector_id: String(alice), inat_observation_id: "998877" });
    expect(await printable(conn, sampleId)).toBe(true);

    const held = await applySampleOverlay(conn, [row({ field: "hold", value: "held", reason: "date looks a year off" })]);
    expect(held).toEqual({ applied: 1, unresolved: [] });
    expect(await flags(conn, sampleId)).toEqual([["staff_hold", "date looks a year off"]]);
    expect(await printable(conn, sampleId)).toBe(false);

    await applySampleOverlay(conn, [row({ field: "hold", value: "" })]);
    expect(await flags(conn, sampleId)).toEqual([]);
    expect(await printable(conn, sampleId)).toBe(true);
  });

  it("needs a reason, and one written without is refused rather than applied", async () => {
    const { conn } = await createMemoryDb();
    const alice = await person(conn, "Alice Adams", "alice", 1);
    const sampleId = await insertCleanSample(conn, { collector_id: String(alice), inat_observation_id: "998877" });
    const result = await applySampleOverlay(conn, [row({ field: "hold", value: "held", reason: "  " })]);
    expect(result.unresolved).toEqual([{ sample_ref: "inat:998877", field: "hold", reason: "a hold needs a reason" }]);
    expect(await printable(conn, sampleId)).toBe(true);
  });

  it("cannot itself be waived", async () => {
    const { conn } = await createMemoryDb();
    const alice = await person(conn, "Alice Adams", "alice", 1);
    const sampleId = await insertCleanSample(conn, { collector_id: String(alice), inat_observation_id: "998877" });
    await applySampleOverlay(conn, [row({ field: "hold", value: "held", reason: "wrong county" })]);
    // A row for it reaches the table only if written by hand; the roll-up still ignores it.
    await conn.run(`INSERT INTO sample_qc_waiver (sample_id, rule_name, finding, reason, in_force) VALUES (${sampleId}, 'staff_hold', 'wrong county', 'x', true)`);
    expect(await printable(conn, sampleId)).toBe(false);
  });
});

describe("a waiver", () => {
  async function streetSample() {
    const { conn } = await createMemoryDb();
    const alice = await person(conn, "Alice Adams", "alice", 1);
    // "FS Rd 2" is a forest road the street-address check takes for a street.
    const sampleId = await insertCleanSample(conn, { collector_id: String(alice), inat_observation_id: "998877", locality: "'FS Rd 2'" });
    const [[finding]] = (await rows(
      conn,
      `SELECT concat_ws(' ', details, detail_taxon_name) FROM sample_qc_finding WHERE sample_id = ${sampleId} AND rule_name = 'locality_format'`,
    )) as [[string]];
    return { conn, sampleId, finding };
  }

  it("lets a flag staff judged fine print, while the flag says what it said", async () => {
    const { conn, sampleId, finding } = await streetSample();
    expect(await printable(conn, sampleId)).toBe(false);

    await applySampleOverlay(conn, [row({ field: "waiver:locality_format", value: "waived", base_value: finding, reason: "a forest road" })]);
    expect(await flags(conn, sampleId)).toEqual([]);
    expect(await printable(conn, sampleId)).toBe(true);

    // The record changes and the flag's wording with it: the finding is back
    // once the waivers are next checked, as every promotion does.
    await conn.run(`UPDATE sample SET locality = 'FS Rd 2, past the gate' WHERE entity_id = ${sampleId}`);
    await refreshWaivers(conn);
    expect((await flags(conn, sampleId)).map((f) => f[0])).toEqual(["locality_format"]);
    expect(await printable(conn, sampleId)).toBe(false);
  });

  it("is refused for a flag no waiver may set aside, or one that does not block", async () => {
    const { conn } = await streetSample();
    for (const [field, reason] of [
      ["waiver:missing_required_field", "'missing_required_field' cannot be waived"],
      ["waiver:obscured_no_true_coordinates", "'obscured_no_true_coordinates' cannot be waived"],
      ["waiver:taxon_obscured_awaiting_atlas", "'taxon_obscured_awaiting_atlas' cannot be waived"],
      ["waiver:count_mismatch", "'count_mismatch' does not block printing, so there is nothing to waive"],
      ["waiver:no_such_rule", "'no_such_rule' is not a flag"],
    ] as const) {
      const result = await applySampleOverlay(conn, [row({ field, value: "waived", reason: "because" })]);
      expect(result.unresolved).toEqual([{ sample_ref: "inat:998877", field, reason }]);
    }
    expect(await rows(conn, `SELECT count(*) FROM sample_qc_waiver`)).toEqual([[0n]]);
  });

  it("has no effect on an unwaivable flag even if a row for one reaches the table", async () => {
    const { conn } = await createMemoryDb();
    const alice = await person(conn, "Alice Adams", "alice", 1);
    const sampleId = await insertCleanSample(conn, { collector_id: String(alice), inat_observation_id: "998877", locality: "NULL" });
    const [[rule, finding]] = (await rows(
      conn,
      `SELECT rule_name, concat_ws(' ', details, detail_taxon_name) FROM sample_qc_finding WHERE sample_id = ${sampleId}`,
    )) as [[string, string]];
    expect(rule).toBe("missing_required_field");
    await conn.run(`INSERT INTO sample_qc_waiver (sample_id, rule_name, finding, reason, in_force) VALUES (${sampleId}, '${rule}', '${finding}', 'x', true)`);
    expect(await printable(conn, sampleId)).toBe(false);
  });
});

describe("a waiver on the duplicate-number flag", () => {
  // A sample can be a duplicate both ways at once: another sample of hers
  // has its number that day, and two observations claim it. Found by a
  // review of the branch, where a waiver on one of the two findings hid both.
  async function doubled() {
    const { conn } = await createMemoryDb();
    const alice = await person(conn, "Alice Adams", "alice", 1);
    const day = currentSeasonDate(7, 14);
    const sampleId = await insertCleanSample(conn, { collector_id: String(alice), inat_observation_id: "100", sample_number: "'7'" });
    await insertCleanSample(conn, { collector_id: String(alice), sample_number: "'7'" });
    const obs = (id: number, user: number) =>
      conn.run(`INSERT INTO observation_field (inat_id, user_id, sample_number_raw, specimen_count_raw, observed_on)
                VALUES (${id}, ${user}, '7', '3', DATE '${day}')`);
    await obs(100, 1);
    await obs(101, 1);
    return { conn, sampleId, alice, obs };
  }
  const dupFlags = (conn: DuckDBConnection, sampleId: number) =>
    rows(conn, `SELECT details FROM qc_finding WHERE sample_id = ${sampleId} AND rule_name = 'duplicate_sample_number'`);

  it("is one finding that says both, and the waiver covers exactly what it said", async () => {
    const { conn, sampleId, obs } = await doubled();
    const said = await dupFlags(conn, sampleId);
    expect(said).toHaveLength(1);
    expect(String(said[0]![0])).toMatch(/is on 2 observations: 100, 101; sample number 7 used 2 times/);

    const text = await findingText(conn, sampleId, "duplicate_sample_number");
    await applySampleOverlay(conn, [row({ sample_ref: "inat:100", field: "waiver:duplicate_sample_number", value: "waived", base_value: text!, reason: "two vials" })]);
    expect(await printable(conn, sampleId)).toBe(true);

    // A third observation changes what the flag says; the next check lapses the waiver.
    await obs(102, 1);
    await refreshWaivers(conn);
    expect(await printable(conn, sampleId)).toBe(false);
  });

  it("is rechecked when a person's account is moved, which changes the observations that claim a sample", async () => {
    const { conn, sampleId, obs } = await doubled();
    const text = await findingText(conn, sampleId, "duplicate_sample_number");
    await applySampleOverlay(conn, [row({ sample_ref: "inat:100", field: "waiver:duplicate_sample_number", value: "waived", base_value: text!, reason: "two vials" })]);
    expect(await printable(conn, sampleId)).toBe(true);

    await obs(200, 2);
    await obs(201, 2);
    await obs(202, 2);
    await applyPersonOverlay(conn, [
      { person_ref: "name:Alice Adams", field: "inat_user_id", value: "2 alice2", author: "samstaff", reason: "the other login" },
    ]);
    expect(await printable(conn, sampleId)).toBe(false);
  });
});

describe("the applier", () => {
  it("refuses a field it does not know rather than treating it as a locality", async () => {
    const { conn } = await createMemoryDb();
    const alice = await person(conn, "Alice Adams", "alice", 1);
    const sampleId = await insertCleanSample(conn, { collector_id: String(alice), inat_observation_id: "998877" });
    await applySampleOverlay(conn, [row({ field: "locality", value: "Bald Hill", base_value: "Corvallis" })]);
    const result = await applySampleOverlay(conn, [row({ field: "waiver:" as never, value: "" })]);
    expect(result.unresolved).toEqual([{ sample_ref: "inat:998877", field: "waiver:", reason: "not a field this applier knows" }]);
    expect(await rows(conn, `SELECT locality FROM sample_locality_override WHERE sample_id = ${sampleId}`)).toEqual([["Bald Hill"]]);
  });
});

describe("the overlay's hold and waiver fields", () => {
  const header = "sample_ref,field,base_value,value,author,reason\n";
  it("parse, and a value other than the standing one or empty is refused", () => {
    expect(
      parseSampleOverlay(`${header}inat:1,hold,,held,sam,wrong date\ninat:1,waiver:locality_format,looks like a street address,waived,sam,forest road\n`, "f"),
    ).toHaveLength(2);
    expect(() => parseSampleOverlay(`${header}inat:1,hold,,yes,sam,x\n`, "f")).toThrow(/a hold is 'held' or empty/);
    expect(() => parseSampleOverlay(`${header}inat:1,waiver:Locality,,waived,sam,x\n`, "f")).toThrow(/not a sample overlay field/);
  });
});

describe("the sample page's staff forms", () => {
  async function app(signedInAs: "alice" | "sam", locality = "'Corvallis'") {
    const { instance, conn } = await createMemoryDb();
    const alice = await person(conn, "Alice Adams", "alice", 1);
    const sam = await person(conn, "Sam Staff", "samstaff", 2);
    await conn.run(`INSERT INTO person_admin (person_id) VALUES (${sam})`);
    const sampleId = await insertCleanSample(conn, {
      collector_id: String(alice),
      sample_number: "'A-1'",
      inat_observation_id: "998877",
      locality,
    });
    const dir = await mkdtemp(join(tmpdir(), "beeline-holds-"));
    const paths = {
      sampleOverlayPath: join(dir, "sample-overlay.csv"),
      sampleChangesPath: join(dir, "sample-change.csv"),
      sampleStatePath: join(dir, "sample-state.csv"),
    };
    const people = { alice, sam };
    const application = createApp({
      ...(await scratchPaths()),
      db: createKysely(instance),
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId: people[signedInAs], login: signedInAs === "sam" ? "samstaff" : "alice", iconUrl: null }),
      conn,
      ...paths,
    });
    const post = (path: string, body: Record<string, string>) => application.request(path, { method: "POST", body: new URLSearchParams(body) });
    return { app: application, post, conn, sampleId, sam, ...paths };
  }

  it("hold a sample, show who held it and why, and lift it", async () => {
    const { app: a, post, conn, sampleId, sampleOverlayPath, sampleChangesPath } = await app("sam");
    expect(await (await a.request(`/samples/${sampleId}`)).text()).toContain("Hold back from printing");

    expect((await post(`/samples/${sampleId}/hold`, { note: "" })).status).toBe(400);
    const res = await post(`/samples/${sampleId}/hold`, { note: "date looks a year off" });
    expect(res.status).toBe(302);
    expect(await printable(conn, sampleId)).toBe(false);
    expect(await readSampleOverlay(sampleOverlayPath)).toEqual([
      { sample_ref: "inat:998877", field: "hold", base_value: "", value: "held", author: "samstaff", reason: "date looks a year off" },
    ]);
    const page = await (await a.request(`/samples/${sampleId}`)).text();
    expect(page).toContain("Held by Sam Staff. Reason: date looks a year off");
    expect(page).toContain("Lift the hold");

    expect((await post(`/samples/${sampleId}/hold`, { lift: "1", note: "checked with Alice" })).status).toBe(302);
    expect(await printable(conn, sampleId)).toBe(true);
    // The History panel says who lifted it, and when. A first pass over a
    // store with no snapshot baselines rather than records, so it is the
    // lift, the second decision, that lands in the log.
    expect(await readFile(sampleChangesPath, "utf8")).toMatch(/,hold,date looks a year off,,samstaff,/);
  });

  it("waive a firing flag, list the waiver for everyone, and refuse what may not be waived", async () => {
    const { app: a, post, conn, sampleId } = await app("sam", "'FS Rd 2'");
    const before = await (await a.request(`/samples/${sampleId}`)).text();
    expect(before).toContain("Waive this flag");
    expect(before).toContain('name="rule" value="locality_format"');

    expect((await post(`/samples/${sampleId}/waiver`, { rule: "locality_format", note: "" })).status).toBe(400);
    expect((await post(`/samples/${sampleId}/waiver`, { rule: "missing_required_field", note: "x" })).status).toBe(400);
    expect((await post(`/samples/${sampleId}/waiver`, { rule: "duplicate_sample_number", note: "x" })).status).toBe(400);
    expect((await post(`/samples/${sampleId}/waiver`, { rule: "locality_format", note: "a forest road" })).status).toBe(302);
    expect(await printable(conn, sampleId)).toBe(true);

    const page = await (await a.request(`/samples/${sampleId}`)).text();
    expect(page).toContain("Waived flags");
    expect(page).toContain("Waived by Sam Staff. Reason: a forest road");
    expect(page).toContain("Remove the waiver");

    expect((await post(`/samples/${sampleId}/waiver`, { rule: "locality_format", remove: "1" })).status).toBe(302);
    expect(await printable(conn, sampleId)).toBe(false);
  });

  it("show the collector a hold on their front page and a waiver on their sample", async () => {
    const { app: a, conn, sampleId } = await app("alice", "'FS Rd 2'");
    const [[finding]] = (await rows(
      conn,
      `SELECT concat_ws(' ', details, detail_taxon_name) FROM qc_finding WHERE sample_id = ${sampleId} AND rule_name = 'locality_format'`,
    )) as [[string]];
    await applySampleOverlay(conn, [
      row({ field: "hold", value: "held", reason: "check the county" }),
      row({ field: "waiver:locality_format", value: "waived", base_value: finding, reason: "a forest road" }),
    ]);
    const front = await (await a.request("/")).text();
    expect(front).toContain("Staff are holding this sample back from printing");
    expect(front).toContain("check the county");
    const page = await (await a.request(`/samples/${sampleId}`)).text();
    expect(page).toContain("Waived by Sam Staff. Reason: a forest road");
    expect(page).not.toContain("Remove the waiver");
  });

  it("refuse a malformed flag name on removal too, leaving the file readable", async () => {
    const { post, sampleId, sampleOverlayPath } = await app("sam", "'FS Rd 2'");
    await post(`/samples/${sampleId}/hold`, { note: "check the county" });
    for (const rule of ["", "Locality", "locality_format,x"]) {
      expect((await post(`/samples/${sampleId}/waiver`, { rule, remove: "1" })).status).toBe(400);
    }
    expect((await readSampleOverlay(sampleOverlayPath)).map((r) => r.field)).toEqual(["hold"]);
  });

  it("are not offered to the collector, and refuse them", async () => {
    const { app: a, post, sampleId } = await app("alice", "'FS Rd 2'");
    const page = await (await a.request(`/samples/${sampleId}`)).text();
    expect(page).not.toContain("Hold back from printing");
    expect(page).not.toContain("Waive this flag");
    expect((await post(`/samples/${sampleId}/hold`, { note: "mine" })).status).toBe(403);
    expect((await post(`/samples/${sampleId}/waiver`, { rule: "locality_format", note: "mine" })).status).toBe(403);
  });

  it("name a sample held after its run was prepared, except one from a past season", async () => {
    const { app: a, post, conn, sampleId, sam } = await app("sam");
    const run = await prepareRun(conn, { atlasId: null, personId: sam, now: new Date() });
    expect(run).not.toBeNull();
    await post(`/samples/${sampleId}/hold`, { note: "wrong county" });
    const page = await (await a.request(`/print-runs/${run!.printRunId}`)).text();
    expect(page).toContain("Staff have held a sample in this run back from printing");
    expect(page).toContain("wrong county");

    // The same run, had the sample been collected in a past season: its labels print regardless.
    await conn.run(`UPDATE sample SET date_start = DATE '${CURRENT_SEASON - 1}-07-14', date_end = DATE '${CURRENT_SEASON - 1}-07-14' WHERE entity_id = ${sampleId}`);
    expect(await (await a.request(`/print-runs/${run!.printRunId}`)).text()).not.toContain("Staff have held");
  });
});
