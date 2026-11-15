import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { parseCsv } from "../src/corrections.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { en } from "../src/app/messages/en.js";
import { IMPERSONATING_COOKIE } from "../src/app/acting.js";
import { writeLegacyExport } from "../src/legacy-export.js";
import { duckdbReader } from "../src/person-change.js";
import { recordSampleChanges } from "../src/sample-change.js";
import { createMemoryDb, currentSeasonDate, FIXTURE_INPUTS, insertCleanSample, rows, scratchPaths } from "./helpers.js";
import { promotedStore } from "./promoted-store.js";

/**
 * Staff correcting how a sample from the old Beeline was collected, from the
 * Method row of its page (beeline-p8y1): the case is Pat Wheeler's 2021 trap
 * samples, which Beeline published as netted on one day because the copy
 * promotion kept was the one printed from the observation, with the old
 * Beeline's default "aerial net". Here a net sample of the legacy fixture,
 * given an observation as hers have, stands in for one.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;
const t = en.record.sample.methodEdit;

async function methodApp(signedInAs: "staff" | "collector", opts: { observation?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "beeline-method-"));
  const paths = {
    correctionsPath: join(dir, "corrections.csv"),
    sampleOverlayPath: join(dir, "sample-overlay.csv"),
    sampleChangesPath: join(dir, "sample-change.csv"),
    sampleStatePath: join(dir, "sample-state.csv"),
  };
  const { instance, conn } = await promotedStore("occurrences", { appCorrections: paths.correctionsPath });
  // A net sample built from more than one old record, linked to an observation.
  const [[sampleId, collector]] = (await rows(
    conn,
    `SELECT s.entity_id, min(pc.person_id) FROM sample s
     JOIN legacy_specimen_number n ON n.sample_id = s.entity_id
     JOIN sample_primary_collector pc ON pc.sample_id = s.entity_id
     WHERE s.kind = 'net' GROUP BY s.entity_id HAVING count(*) > 1 ORDER BY s.entity_id LIMIT 1`,
  )) as [[number, number]];
  // Linked to an observation, as Pat Wheeler's are, unless the test wants one iNaturalist does not hold.
  await conn.run(`UPDATE sample SET inat_observation_id = ${opts.observation === false ? "NULL" : "93297897"} WHERE entity_id = ${sampleId}`);
  const [[staff]] = (await rows(conn, `INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)) as [[number]];
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);
  // A store that was built, as production was, so the change log believes
  // its sample ids and follows a sample whose start date moves (src/sample-change.ts, idsBelong).
  await conn.run("INSERT INTO schema_migration (name) VALUES ('0001-a-store-that-was-built.sql')");
  // The store as it stood, so the edit is recorded as a change rather than
  // taken for the first snapshot.
  await recordSampleChanges(duckdbReader(conn), { log: paths.sampleChangesPath, state: paths.sampleStatePath }, { source: "observation_promotion" });
  const db = createKysely(instance);
  const app = createApp({
    ...(await scratchPaths()),
    db,
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () =>
      signedInAs === "staff"
        ? { personId: Number(staff), login: "samstaff", iconUrl: null }
        : { personId: Number(collector), login: "collector", iconUrl: null },
    conn,
    ...paths,
  });
  const [[start]] = (await rows(conn, `SELECT CAST(date_start AS VARCHAR) FROM sample WHERE entity_id = ${sampleId}`)) as [[string]];
  const later = (days: number) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return { app, conn, sampleId: Number(sampleId), start, later, ...paths };
}

/** The corrections file's rows, by column name. */
async function correctionsIn(path: string): Promise<Record<string, string>[]> {
  const [head = [], ...body] = parseCsv(await readFile(path, "utf8"));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const post = (app: { request: (p: string, init?: RequestInit) => Promise<Response> | Response }, path: string, body: Record<string, string>) =>
  app.request(path, { method: "POST", body: new URLSearchParams(body) });

const sampleRow = async (conn: DuckDBConnection, id: number) =>
  (await rows(conn, `SELECT kind, protocol, CAST(date_start AS VARCHAR), CAST(date_end AS VARCHAR) FROM sample WHERE entity_id = ${id}`))[0];

// Each test promotes the legacy fixture, one or three times, which beside the
// rest of the suite takes longer than the default limit.
describe("staff correcting how a sample from the old Beeline was collected", { timeout: 120_000 }, () => {
  it("offers staff the pencil on the Method row, and not the collector", async () => {
    const staff = await methodApp("staff");
    const page = await (await staff.app.request(`/samples/${staff.sampleId}`)).text();
    expect(page).toContain(`/samples/${staff.sampleId}/method`);
    expect(page).toContain(t.open);
    const collector = await methodApp("collector");
    expect(await (await collector.app.request(`/samples/${collector.sampleId}`)).text()).not.toContain(`/samples/${collector.sampleId}/method`);
    const res = await post(collector.app, `/samples/${collector.sampleId}/method`, { protocol: "pan traps", date_end: collector.later(2) });
    expect(res.status).toBe(403);
  });

  it("makes it a trap sample with the method and end date given, and records it against every old record", async () => {
    const { app, conn, sampleId, start, later, correctionsPath, sampleChangesPath } = await methodApp("staff");
    const [[records]] = (await rows(conn, `SELECT count(*) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[bigint]];
    const end = later(2);
    const res = await post(app, `/samples/${sampleId}/method`, { protocol: " pan traps ", date_end: end, note: "the trap records say so" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/samples/${sampleId}`);
    expect(await sampleRow(conn, sampleId)).toEqual(["trap", "pan traps", start, end]);

    const events = await correctionsIn(correctionsPath);
    const [y, mo, d] = end.split("-").map((p) => String(Number(p)));
    expect(events.filter((e) => e.field === "samplingProtocol")).toHaveLength(Number(records));
    for (const [field, value] of [["samplingProtocol", "pan traps"], ["day2", d], ["month2", mo], ["year2", y]] as const) {
      const of = events.filter((e) => e.field === field);
      expect(of).toHaveLength(Number(records));
      for (const e of of) expect(e).toMatchObject({ new_value: value, author: "samstaff", reason: "the trap records say so" });
    }
    // Who changed what, in the sample's own history.
    const history = await readFile(sampleChangesPath, "utf8");
    expect(history).toContain("samstaff");
    expect(history).toContain("pan traps");

    // The page now says trap, with the method's words.
    const page = await (await app.request(`/samples/${sampleId}`)).text();
    expect(page).toContain(en.record.sample.methodTrap);
    expect(page).toContain("pan traps");
  });

  it("makes it a net sample of one day again when the end date is taken away", async () => {
    const { app, conn, sampleId, start, later } = await methodApp("staff");
    await post(app, `/samples/${sampleId}/method`, { protocol: "pan traps", date_end: later(2) });
    await post(app, `/samples/${sampleId}/method`, { protocol: "aerial net", date_end: "" });
    expect(await sampleRow(conn, sampleId)).toEqual(["net", "aerial net", start, start]);
  });

  it("writes nothing when nothing changed", async () => {
    const { app, conn, sampleId, correctionsPath } = await methodApp("staff");
    const [[protocol]] = (await rows(conn, `SELECT coalesce(protocol, '') FROM sample WHERE entity_id = ${sampleId}`)) as [[string]];
    const res = await post(app, `/samples/${sampleId}/method`, { protocol, date_end: "" });
    expect(res.status).toBe(302);
    expect(await correctionsIn(correctionsPath)).toEqual([]);
  });

  it("refuses an end date it cannot read, one before the start, and one not yet come", async () => {
    const { app, conn, sampleId, start, later } = await methodApp("staff");
    const before = await sampleRow(conn, sampleId);
    const cases: [string, string][] = [
      [`${Number(start.slice(0, 4)) + 1}-02-30`, t.problems.date],
      ["16/4/2021", t.problems.date],
      [later(-1), t.problems.before_start],
      ["2999-01-01", t.problems.future],
    ];
    for (const [dateEnd, problem] of cases) {
      const res = await post(app, `/samples/${sampleId}/method`, { protocol: "pan traps", date_end: dateEnd });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe(problem);
    }
    expect(await sampleRow(conn, sampleId)).toEqual(before);
  });

  it("leaves a field a form left open did not touch, and refuses one it changed over a newer save", async () => {
    const { app, conn, sampleId, later } = await methodApp("staff");
    const [[shown]] = (await rows(conn, `SELECT coalesce(protocol, '') FROM sample WHERE entity_id = ${sampleId}`)) as [[string]];
    const opened = { "base:protocol": shown, "base:date_end": "" };
    // One staff member corrects the method.
    await post(app, `/samples/${sampleId}/method`, { ...opened, protocol: "pan traps", date_end: "" });
    // Another, on a form opened before that, sets only the end date: the method they were shown goes unsaid.
    const end = later(2);
    expect((await post(app, `/samples/${sampleId}/method`, { ...opened, protocol: shown, date_end: end })).status).toBe(302);
    expect((await sampleRow(conn, sampleId))?.slice(0, 2)).toEqual(["trap", "pan traps"]);
    // And a change to the method from that old form is refused, not written over the first.
    const res = await post(app, `/samples/${sampleId}/method`, { ...opened, protocol: "vane traps", date_end: end });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(t.conflict);
    expect((await sampleRow(conn, sampleId))?.[1]).toBe("pan traps");
  });

  it("keeps the corrections file and the sample agreeing when two saves arrive together", async () => {
    const { app, conn, sampleId, correctionsPath } = await methodApp("staff");
    await Promise.all(
      ["pan traps", "vane traps", "blue vane traps"].map((protocol) => post(app, `/samples/${sampleId}/method`, { protocol, date_end: "" })),
    );
    const [[live]] = (await rows(conn, `SELECT protocol FROM sample WHERE entity_id = ${sampleId}`)) as [[string]];
    const written = (await correctionsIn(correctionsPath)).filter((e) => e.field === "samplingProtocol").map((e) => e.new_value);
    expect(new Set(written)).toEqual(new Set([live]));
  });

  it("is refused to staff looking as the collector", async () => {
    const { app, conn, sampleId, later } = await methodApp("staff");
    const [[name]] = (await rows(
      conn,
      `SELECT p.display_name FROM sample_primary_collector pc JOIN person p ON p.entity_id = pc.person_id WHERE pc.sample_id = ${sampleId}`,
    )) as [[string]];
    const res = await app.request(`/samples/${sampleId}/method`, {
      method: "POST",
      headers: { cookie: `${IMPERSONATING_COOKIE}=${encodeURIComponent(name)}` },
      body: new URLSearchParams({ protocol: "pan traps", date_end: later(2) }),
    });
    expect(res.status).toBe(403);
    expect((await sampleRow(conn, sampleId))?.[1]).not.toBe("pan traps");
  });

  it("is what a rebuild from the corrections file makes of the sample", async () => {
    const { app, conn, sampleId, later, correctionsPath } = await methodApp("staff");
    await post(app, `/samples/${sampleId}/method`, { protocol: "pan traps", date_end: later(2) });
    const [[record]] = (await rows(conn, `SELECT min(_id) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[string]];
    const rebuild = async () => {
      const rebuilt = await createMemoryDb();
      await loadLegacyStaging(rebuilt.conn, FIXTURE);
      await promoteLegacy(rebuilt.conn, { ...FIXTURE_INPUTS, appCorrections: correctionsPath });
      const [[again]] = (await rows(rebuilt.conn, `SELECT sample_id FROM legacy_specimen_number WHERE _id = '${record}'`)) as [[number]];
      return sampleRow(rebuilt.conn, Number(again));
    };
    expect(await rebuild()).toEqual(await sampleRow(conn, sampleId));
    // And taken back to a net sample of one day, which the file must say too.
    await post(app, `/samples/${sampleId}/method`, { protocol: "aerial net", date_end: "" });
    expect((await sampleRow(conn, sampleId))?.[0]).toBe("net");
    expect(await rebuild()).toEqual(await sampleRow(conn, sampleId));
  });

  it("reaches the export of a sample whose old records disagreed, and settles the disagreement", async () => {
    const { app, conn, sampleId, later } = await methodApp("staff");
    // One of the sample's records says it was trapped and ended later; the
    // export writes each record's own method and end date while they disagree.
    const [[odd]] = (await rows(conn, `SELECT min(_id) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[string]];
    const [y, m, d] = later(1).split("-").map((p) => String(Number(p)));
    await conn.run(`UPDATE legacy_occurrence SET "samplingProtocol" = 'pan traps', day2 = '${d}', month2 = '${m}', year2 = '${y}' WHERE _id = '${odd}'`);
    await conn.run(`INSERT INTO sample_promotion_finding (sample_id, rule_name, details) VALUES (${sampleId}, 'within_sample_disagreement', 'protocol: aerial net, pan traps')`);
    const end = later(3);
    await post(app, `/samples/${sampleId}/method`, { protocol: "blue vane traps", date_end: end });

    const path = join(await mkdtemp(join(tmpdir(), "beeline-method-export-")), "occurrences.csv");
    await writeLegacyExport(conn, path);
    const [head = [], ...body] = parseCsv(await readFile(path, "utf8"));
    const col = (name: string) => head.indexOf(name);
    const numbers = new Set(
      ((await rows(conn, `SELECT field_number FROM specimen WHERE sample_id = ${sampleId}`)) as [string][]).map(([n]) => n),
    );
    const mine = body.filter((r) => numbers.has(r[col("fieldNumber")] ?? ""));
    expect(mine.length).toBe(numbers.size);
    const [ey, , ed] = end.split("-").map((p) => String(Number(p)));
    for (const r of mine) {
      expect(r[col("samplingProtocol")]).toBe("blue vane traps");
      expect(r[col("day2")]).toBe(ed);
      expect(r[col("year2")]).toBe(ey);
    }
    // The method's disagreement is settled; the fixture's one over the place is not this form's.
    expect(await rows(conn, `SELECT details FROM sample_promotion_finding WHERE sample_id = ${sampleId} ORDER BY 1`)).toEqual([
      ["locality: Corvallis | Philomath"],
    ]);
  });

  describe("the start date, where iNaturalist does not hold it (beeline-0wbq)", () => {
    it("is offered only on a sample with no observation", async () => {
      const linked = await methodApp("staff");
      const withObservation = await (await linked.app.request(`/samples/${linked.sampleId}`)).text();
      expect(withObservation).toContain(t.dateEnd);
      expect(withObservation).not.toContain(`name="date_start"`);
      const res = await post(linked.app, `/samples/${linked.sampleId}/method`, { protocol: "aerial net", date_end: "", date_start: linked.later(-3) });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe(t.problems.start_observation);

      const unlinked = await methodApp("staff", { observation: false });
      expect(await (await unlinked.app.request(`/samples/${unlinked.sampleId}`)).text()).toContain(`name="date_start"`);
    });

    it("moves the sample and every old record's start, and a net sample's end with it", async () => {
      const { app, conn, sampleId, later, correctionsPath, sampleChangesPath } = await methodApp("staff", { observation: false });
      const [[records]] = (await rows(conn, `SELECT count(*) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[bigint]];
      const [[protocol]] = (await rows(conn, `SELECT coalesce(protocol, '') FROM sample WHERE entity_id = ${sampleId}`)) as [[string]];
      const start = later(-3);
      const res = await post(app, `/samples/${sampleId}/method`, { protocol, date_end: "", date_start: start, note: "the field book says so" });
      expect(res.status).toBe(302);
      expect(await sampleRow(conn, sampleId)).toEqual(["net", protocol || null, start, start]);

      const events = await correctionsIn(correctionsPath);
      const [y, mo, d] = start.split("-").map((p) => String(Number(p)));
      for (const [field, value] of [["day", d], ["month", mo], ["year", y]] as const) {
        const of = events.filter((e) => e.field === field);
        expect(of).toHaveLength(Number(records));
        for (const e of of) expect(e).toMatchObject({ new_value: value, author: "samstaff", reason: "the field book says so" });
      }
      // Only the start was corrected: a net sample's end is its start, and its records say nothing of an end.
      expect(events.filter((e) => ["day2", "month2", "year2", "samplingProtocol"].includes(e.field ?? ""))).toEqual([]);
      expect(await readFile(sampleChangesPath, "utf8")).toContain(start);
    });

    it("refuses a start it cannot read, one after the end, and one not yet come", async () => {
      const { app, conn, sampleId, later } = await methodApp("staff", { observation: false });
      const before = await sampleRow(conn, sampleId);
      const cases: [Record<string, string>, string][] = [
        [{ date_start: "16/4/2021", date_end: "" }, t.problems.start_date],
        [{ date_start: later(3), date_end: later(1) }, t.problems.before_start],
        [{ date_start: "2999-01-01", date_end: "" }, t.problems.start_future],
      ];
      for (const [dates, problem] of cases) {
        const res = await post(app, `/samples/${sampleId}/method`, { protocol: "pan traps", ...dates });
        expect(res.status).toBe(400);
        expect(await res.text()).toBe(problem);
      }
      expect(await sampleRow(conn, sampleId)).toEqual(before);
    });

    it("is what a rebuild from the corrections file makes of the sample", async () => {
      const { app, conn, sampleId, later, correctionsPath } = await methodApp("staff", { observation: false });
      await post(app, `/samples/${sampleId}/method`, { protocol: "pan traps", date_start: later(-3), date_end: later(-1) });
      const [[record]] = (await rows(conn, `SELECT min(_id) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[string]];
      const rebuilt = await createMemoryDb();
      await loadLegacyStaging(rebuilt.conn, FIXTURE);
      await promoteLegacy(rebuilt.conn, { ...FIXTURE_INPUTS, appCorrections: correctionsPath });
      const [[again]] = (await rows(rebuilt.conn, `SELECT sample_id FROM legacy_specimen_number WHERE _id = '${record}'`)) as [[number]];
      expect(await sampleRow(rebuilt.conn, Number(again))).toEqual(await sampleRow(conn, sampleId));
    });

    it("changes a trap sample entered in Beeline directly, once its own form no longer opens", async () => {
      const { app, conn, correctionsPath } = await methodApp("staff");
      const entered = await insertCleanSample(conn, {
        kind: "'trap'",
        sample_number: "'OBAS-09999'",
        date_start: `DATE '${currentSeasonDate(6, 1)}'`,
        date_end: `DATE '${currentSeasonDate(6, 8)}'`,
        protocol: "'blue vane trap'",
        sampling_effort: "'6 blue vane traps'",
      });
      await conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${entered})`);
      // A specimen no run minted a number for is on paper (printed_sample,
      // schema/101), which is what closes the trap form.
      await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${entered}, 1, 'TEST0001')`);
      const page = await (await app.request(`/samples/${entered}`)).text();
      expect(page).toContain(`/samples/${entered}/method`);
      expect(page).toContain(t.hintEntered.replaceAll("'", "&#39;"));

      const start = currentSeasonDate(5, 30);
      const res = await post(app, `/samples/${entered}/method`, { protocol: "blue vane trap", date_start: start, date_end: "" });
      expect(res.status).toBe(302);
      // A trap sample stays one; with no end given it ends on the day it started.
      expect(await sampleRow(conn, entered)).toEqual(["trap", "blue vane trap", start, start]);
      expect(await correctionsIn(correctionsPath)).toEqual([]);
      // A new method keeps the trap count, as the trap form writes it.
      await post(app, `/samples/${entered}/method`, { protocol: "pan trap", date_start: start, date_end: "" });
      expect(await rows(conn, `SELECT protocol, sampling_effort FROM sample WHERE entity_id = ${entered}`)).toEqual([["pan trap", "6 pan traps"]]);
      // And a blank method is refused, so the count is never lost.
      const blank = await post(app, `/samples/${entered}/method`, { protocol: "", date_start: start, date_end: "" });
      expect(blank.status).toBe(400);
      expect(await blank.text()).toBe(t.problems.method_required);
      expect(await rows(conn, `SELECT protocol, sampling_effort FROM sample WHERE entity_id = ${entered}`)).toEqual([["pan trap", "6 pan traps"]]);
    });
  });

  it("refuses a sample with no old records, and offers it no pencil", async () => {
    const { app, conn } = await methodApp("staff");
    const fresh = await insertCleanSample(conn, { sample_number: "'B-1'" });
    expect(await (await app.request(`/samples/${fresh}`)).text()).not.toContain(`/samples/${fresh}/method`);
    const res = await post(app, `/samples/${fresh}/method`, { protocol: "pan traps", date_end: "" });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(t.noOldRecords);
  });
});
