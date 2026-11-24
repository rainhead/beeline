import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Kysely } from "kysely";
import { createKysely } from "../src/db.js";
import type { Database } from "../src/model.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { parseCsv, upsertCorrections } from "../src/corrections.js";
import { readSampleChanges as correctionsLog } from "../src/sample-change.js";
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

const conflict = () => new Error("TransactionContext Error: Conflict on update!");

/** A query builder whose execute loses a write conflict, however it was built up. */
function losingBuilder<T extends object>(builder: T): T {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === "execute") return async () => Promise.reject(conflict());
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const next = (value as (...a: unknown[]) => unknown).apply(target, args);
        return next !== null && typeof next === "object" ? losingBuilder(next) : next;
      };
    },
  });
}

/**
 * A Kysely whose first use of `what` loses a write conflict, as a store write
 * racing another does: a transaction for a sample with old records, an
 * `updateTable` for one entered in Beeline.
 */
function losingOnce(db: Kysely<Database>, what: "transaction" | "updateTable"): Kysely<Database> {
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === what && !fired) {
        fired = true;
        if (what === "transaction") return () => ({ execute: async () => Promise.reject(conflict()) });
        return (...args: unknown[]) => losingBuilder((target.updateTable as (...a: unknown[]) => object)(...args));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Kysely<Database>;
}

async function methodApp(signedInAs: "staff" | "collector", opts: { observation?: boolean; losesOnce?: "transaction" | "updateTable" } = {}) {
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
  const db = opts.losesOnce ? losingOnce(createKysely(instance), opts.losesOnce) : createKysely(instance);
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
    const res = await post(collector.app, `/samples/${collector.sampleId}/method`, { protocol: "pan trap", date_end: collector.later(2) });
    expect(res.status).toBe(403);
  });

  it("makes it a trap sample with the method and end date given, and records it against every old record", async () => {
    const { app, conn, sampleId, start, later, correctionsPath, sampleChangesPath } = await methodApp("staff");
    const [[records]] = (await rows(conn, `SELECT count(*) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[bigint]];
    const end = later(2);
    const res = await post(app, `/samples/${sampleId}/method`, { protocol: " pan trap ", date_end: end, note: "the trap records say so" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/samples/${sampleId}`);
    expect(await sampleRow(conn, sampleId)).toEqual(["trap", "pan trap", start, end]);

    const events = await correctionsIn(correctionsPath);
    const [y, mo, d] = end.split("-").map((p) => String(Number(p)));
    expect(events.filter((e) => e.field === "samplingProtocol")).toHaveLength(Number(records));
    for (const [field, value] of [["samplingProtocol", "pan trap"], ["day2", d], ["month2", mo], ["year2", y]] as const) {
      const of = events.filter((e) => e.field === field);
      expect(of).toHaveLength(Number(records));
      for (const e of of) expect(e).toMatchObject({ new_value: value, author: "samstaff", reason: "the trap records say so" });
    }
    // Who changed what, in the sample's own history.
    const history = await readFile(sampleChangesPath, "utf8");
    expect(history).toContain("samstaff");
    expect(history).toContain("pan trap");

    // The page now says trap, with the method's words.
    const page = await (await app.request(`/samples/${sampleId}`)).text();
    expect(page).toContain(en.record.sample.methodTrap);
    expect(page).toContain("pan trap");
  });

  it("makes it a net sample of one day again when the end date is taken away", async () => {
    const { app, conn, sampleId, start, later } = await methodApp("staff");
    await post(app, `/samples/${sampleId}/method`, { protocol: "pan trap", date_end: later(2) });
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
      const res = await post(app, `/samples/${sampleId}/method`, { protocol: "pan trap", date_end: dateEnd });
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
    await post(app, `/samples/${sampleId}/method`, { ...opened, protocol: "pan trap", date_end: "" });
    // Another, on a form opened before that, sets only the end date: the method they were shown goes unsaid.
    const end = later(2);
    expect((await post(app, `/samples/${sampleId}/method`, { ...opened, protocol: shown, date_end: end })).status).toBe(302);
    expect((await sampleRow(conn, sampleId))?.slice(0, 2)).toEqual(["trap", "pan trap"]);
    // And a change to the method from that old form is refused, not written over the first.
    const res = await post(app, `/samples/${sampleId}/method`, { ...opened, protocol: "vane trap", date_end: end });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(t.conflict);
    expect((await sampleRow(conn, sampleId))?.[1]).toBe("pan trap");
  });

  it("keeps the corrections file and the sample agreeing when two saves arrive together", async () => {
    const { app, conn, sampleId, correctionsPath } = await methodApp("staff");
    await Promise.all(
      ["pan trap", "vane trap", "vane trap"].map((protocol) => post(app, `/samples/${sampleId}/method`, { protocol, date_end: "" })),
    );
    const [[live]] = (await rows(conn, `SELECT protocol FROM sample WHERE entity_id = ${sampleId}`)) as [[string]];
    const written = (await correctionsIn(correctionsPath)).filter((e) => e.field === "samplingProtocol").map((e) => e.new_value);
    expect(new Set(written)).toEqual(new Set([live]));
  });

  it("says a change that lost a write conflict is not applied yet, and saving it again applies it once", async () => {
    const { app, conn, sampleId, later, correctionsPath } = await methodApp("staff", { losesOnce: "transaction" });
    const before = await sampleRow(conn, sampleId);
    const [[records]] = (await rows(conn, `SELECT count(*) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[bigint]];
    const body = { protocol: "pan trap", date_end: later(2) };
    const lost = await post(app, `/samples/${sampleId}/method`, body);
    expect(lost.status).toBe(409);
    expect(await lost.text()).toBe(en.sampleEdit.notApplied);
    // The file holds the change; the sample does not, and nothing will put it there on its own.
    expect((await correctionsIn(correctionsPath)).filter((e) => e.field === "samplingProtocol")).toHaveLength(Number(records));
    expect(await sampleRow(conn, sampleId)).toEqual(before);
    const again = await post(app, `/samples/${sampleId}/method`, body);
    expect(again.status).toBe(302);
    expect((await sampleRow(conn, sampleId))![1]).toBe("pan trap");
    expect((await correctionsIn(correctionsPath)).filter((e) => e.field === "samplingProtocol")).toHaveLength(Number(records));
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
      body: new URLSearchParams({ protocol: "pan trap", date_end: later(2) }),
    });
    expect(res.status).toBe(403);
    expect((await sampleRow(conn, sampleId))?.[1]).not.toBe("pan trap");
  });

  it("is what a rebuild from the corrections file makes of the sample", async () => {
    const { app, conn, sampleId, later, correctionsPath } = await methodApp("staff");
    await post(app, `/samples/${sampleId}/method`, { protocol: "pan trap", date_end: later(2) });
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
    await post(app, `/samples/${sampleId}/method`, { protocol: "vane trap", date_end: end });

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
      expect(r[col("samplingProtocol")]).toBe("vane trap");
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
        const res = await post(app, `/samples/${sampleId}/method`, { protocol: "pan trap", ...dates });
        expect(res.status).toBe(400);
        expect(await res.text()).toBe(problem);
      }
      expect(await sampleRow(conn, sampleId)).toEqual(before);
    });

    it("is what a rebuild from the corrections file makes of the sample", async () => {
      const { app, conn, sampleId, later, correctionsPath } = await methodApp("staff", { observation: false });
      await post(app, `/samples/${sampleId}/method`, { protocol: "pan trap", date_start: later(-3), date_end: later(-1) });
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
      expect(await blank.text()).toBe(t.unlistedMethod("bottle trap, malaise trap, pan and vane traps, pan trap, trap nest, vane trap"));
      expect(await rows(conn, `SELECT protocol, sampling_effort FROM sample WHERE entity_id = ${entered}`)).toEqual([["pan trap", "6 pan traps"]]);
    });

    it("says a change to an entered sample that lost a write conflict is not applied, and saving again applies it", async () => {
      const { app, conn, correctionsPath } = await methodApp("staff", { losesOnce: "transaction" });
      const entered = await insertCleanSample(conn, {
        kind: "'trap'",
        sample_number: "'OBAS-09998'",
        date_start: `DATE '${currentSeasonDate(6, 1)}'`,
        date_end: `DATE '${currentSeasonDate(6, 8)}'`,
        protocol: "'blue vane trap'",
      });
      await conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${entered})`);
      await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${entered}, 1, 'TEST0002')`);
      const body = { protocol: "pan trap", date_start: currentSeasonDate(6, 1), date_end: currentSeasonDate(6, 8) };
      const lost = await post(app, `/samples/${entered}/method`, body);
      expect(lost.status).toBe(409);
      expect(await lost.text()).toBe(en.sampleEdit.notApplied);
      expect((await sampleRow(conn, entered))![1]).toBe("blue vane trap");
      expect((await post(app, `/samples/${entered}/method`, body)).status).toBe(302);
      expect((await sampleRow(conn, entered))![1]).toBe("pan trap");
      expect(await correctionsIn(correctionsPath)).toEqual([]);
    });
  });

  it("refuses a sample with no old records, and offers it no pencil", async () => {
    const { app, conn } = await methodApp("staff");
    const fresh = await insertCleanSample(conn, { sample_number: "'B-1'" });
    expect(await (await app.request(`/samples/${fresh}`)).text()).not.toContain(`/samples/${fresh}/method`);
    const res = await post(app, `/samples/${fresh}/method`, { protocol: "pan trap", date_end: "" });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(t.noOldRecords);
  });
});

describe("the method is chosen from the list (beeline-ni5m.15)", { timeout: 120_000 }, () => {
  const ALL = "aerial net, bottle trap, malaise trap, pan and vane traps, pan trap, trap nest, vacuum, vane trap";
  const TRAPS = "bottle trap, malaise trap, pan and vane traps, pan trap, trap nest, vane trap";
  const stored = async (conn: DuckDBConnection, id: number) =>
    (await rows(conn, `SELECT s.protocol, m.method_code, m.trap_count FROM sample s LEFT JOIN sample_method m ON m.sample_id = s.entity_id WHERE s.entity_id = ${id}`))[0];
  const mismatches = async (conn: DuckDBConnection) => (await rows(conn, `SELECT count(*) FROM sample_method_out_of_step`))[0]![0];

  it("on a sample from old records writes the code as the corrected text of every record, and as the method, together", async () => {
    const { app, conn, sampleId, later, correctionsPath, sampleChangesPath } = await methodApp("staff");
    const [[records]] = (await rows(conn, `SELECT count(*) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[bigint]];
    expect(await stored(conn, sampleId)).toEqual(["aerial net", "aerial net", null]);
    const res = await post(app, `/samples/${sampleId}/method`, { protocol: "vacuum", date_end: "" });
    expect(res.status).toBe(302);
    expect(await stored(conn, sampleId)).toEqual(["vacuum", "vacuum", null]);
    expect((await correctionsIn(correctionsPath)).filter((e) => e.field === "samplingProtocol" && e.new_value === "vacuum")).toHaveLength(Number(records));
    expect(await mismatches(conn)).toBe(0n);
    // The history names the method and who changed it.
    const history = await readFile(sampleChangesPath, "utf8");
    expect(history).toMatch(/,method,aerial net,vacuum,/);
    expect(history).toContain("samstaff");
  });

  it("refuses words that are not on the list, naming the methods, and changes nothing", async () => {
    const { app, conn, sampleId, correctionsPath } = await methodApp("staff");
    const before = await stored(conn, sampleId);
    for (const protocol of ["pan traps", "Vane trap", "something else", ""]) {
      const res = await post(app, `/samples/${sampleId}/method`, { "base:protocol": "aerial net", protocol, date_end: "" });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe(`Choose one of the listed methods: ${ALL}.`);
    }
    expect(await stored(conn, sampleId)).toEqual(before);
    expect(await correctionsIn(correctionsPath)).toEqual([]);
  });

  it("keeps a method as written that is not on the list when the form is saved as it stands, and replaces it with a listed method", async () => {
    const { app, conn, sampleId } = await methodApp("staff");
    await conn.run(`UPDATE sample SET protocol = 'pantrap' WHERE entity_id = ${sampleId}`);
    await conn.run(`UPDATE sample_method SET method_code = 'pan trap' WHERE sample_id = ${sampleId}`);
    const page = await (await app.request(`/samples/${sampleId}`)).text();
    expect(page).toContain(en.record.sample.methodEdit.protocolAsWritten("pantrap"));
    expect(page).toContain(`<option value="vane trap">vane trap</option>`);
    // Saved as it stands, with another field changed: the method as written stays.
    expect((await post(app, `/samples/${sampleId}/method`, { "base:protocol": "pantrap", protocol: "pantrap", date_end: "" })).status).toBe(302);
    expect(await stored(conn, sampleId)).toEqual(["pantrap", "pan trap", null]);
    expect((await post(app, `/samples/${sampleId}/method`, { "base:protocol": "pantrap", protocol: "bottle trap", date_end: "" })).status).toBe(302);
    expect(await stored(conn, sampleId)).toEqual(["bottle trap", "bottle trap", null]);
    expect(await mismatches(conn)).toBe(0n);
  });

  it("offers an entered sample only the methods that are traps, and refuses aerial net for it", async () => {
    const { app, conn } = await methodApp("staff");
    const entered = await insertCleanSample(conn, {
      kind: "'trap'",
      sample_number: "'OBAS-09997'",
      date_start: `DATE '${currentSeasonDate(6, 1)}'`,
      date_end: `DATE '${currentSeasonDate(6, 8)}'`,
      protocol: "'vane trap'",
      sampling_effort: "'6 vane traps'",
    });
    await conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${entered})`);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${entered}, 1, 'TEST0003')`);
    const page = await (await app.request(`/samples/${entered}`)).text();
    expect(page).toContain(`<option value="pan trap">pan trap</option>`);
    expect(page).not.toContain(`<option value="aerial net">`);
    expect(page).not.toContain(`<option value="vacuum">`);
    const res = await post(app, `/samples/${entered}/method`, { "base:protocol": "vane trap", protocol: "aerial net", date_start: currentSeasonDate(6, 1), date_end: "" });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(`Choose one of the listed methods: ${TRAPS}.`);
    // A trap method is taken, and the count stays beside it.
    expect((await post(app, `/samples/${entered}/method`, { "base:protocol": "vane trap", protocol: "malaise trap", date_start: currentSeasonDate(6, 1), date_end: "" })).status).toBe(302);
    expect(await stored(conn, entered)).toEqual(["malaise trap", "malaise trap", 6]);
    expect(await mismatches(conn)).toBe(0n);
  });

  it("gives a sample with no method one, where it had none", async () => {
    const { app, conn, sampleId } = await methodApp("staff");
    await conn.run(`DELETE FROM sample_method WHERE sample_id = ${sampleId}`);
    await conn.run(`UPDATE sample SET protocol = NULL WHERE entity_id = ${sampleId}`);
    expect((await rows(conn, `SELECT count(*) FROM sample_without_method WHERE sample_id = ${sampleId}`))[0]![0]).toBe(1n);
    expect((await post(app, `/samples/${sampleId}/method`, { "base:protocol": "", protocol: "pan trap", date_end: "" })).status).toBe(302);
    expect(await stored(conn, sampleId)).toEqual(["pan trap", "pan trap", null]);
    expect((await rows(conn, `SELECT count(*) FROM sample_without_method`))[0]![0]).toBe(0n);
  });

  describe("the trap count goes with the method", () => {
    const sixVane = async () => {
      const w = await methodApp("staff");
      await w.conn.run(`UPDATE sample SET protocol = '6 vane traps' WHERE entity_id = ${w.sampleId}`);
      await w.conn.run(`UPDATE sample_method SET method_code = 'vane trap', trap_count = 6 WHERE sample_id = ${w.sampleId}`);
      await recordSampleChanges(duckdbReader(w.conn), { log: w.sampleChangesPath, state: w.sampleStatePath }, { source: "reconcile" });
      return w;
    };
    const effortOf = async (conn: DuckDBConnection, id: number) => (await rows(conn, `SELECT sampling_effort FROM sample WHERE entity_id = ${id}`))[0]![0];

    it("is kept where the new method is a trap, and written as the effort the forms write", async () => {
      const w = await sixVane();
      expect((await post(w.app, `/samples/${w.sampleId}/method`, { "base:protocol": "6 vane traps", protocol: "pan trap", date_end: "" })).status).toBe(302);
      expect(await stored(w.conn, w.sampleId)).toEqual(["pan trap", "pan trap", 6]);
      expect(await effortOf(w.conn, w.sampleId)).toBe("6 pan traps");
      expect(await mismatches(w.conn)).toBe(0n);
    });

    it("goes where the new method is not a trap, with the effort that stated it, and the history shows it with its author", async () => {
      const w = await sixVane();
      expect((await post(w.app, `/samples/${w.sampleId}/method`, { "base:protocol": "6 vane traps", protocol: "aerial net", date_end: "" })).status).toBe(302);
      expect(await stored(w.conn, w.sampleId)).toEqual(["aerial net", "aerial net", null]);
      expect(await effortOf(w.conn, w.sampleId)).toBeNull();
      expect(await mismatches(w.conn)).toBe(0n);
      const history = (await correctionsLog(w.sampleChangesPath)).filter((e) => e.sample_id === String(w.sampleId));
      expect(history.map((e) => [e.field, e.old_value, e.new_value, e.author])).toEqual(
        expect.arrayContaining([
          ["method", "vane trap", "aerial net", "samstaff"],
          ["trap_count", "6", "", "samstaff"],
          ["protocol", "6 vane traps", "aerial net", "samstaff"],
        ]),
      );
    });

    it("gives a sample with no method row one with no count, and no effort", async () => {
      const w = await methodApp("staff");
      await w.conn.run(`DELETE FROM sample_method WHERE sample_id = ${w.sampleId}`);
      await w.conn.run(`UPDATE sample SET protocol = NULL, sampling_effort = NULL WHERE entity_id = ${w.sampleId}`);
      expect((await post(w.app, `/samples/${w.sampleId}/method`, { "base:protocol": "", protocol: "pan trap", date_end: "" })).status).toBe(302);
      expect(await stored(w.conn, w.sampleId)).toEqual(["pan trap", "pan trap", null]);
      expect(await effortOf(w.conn, w.sampleId)).toBeNull();
      expect(await mismatches(w.conn)).toBe(0n);
    });
  });
});

describe("the Method form reads the dates, and kind follows the method (beeline-ni5m.15, stage three)", { timeout: 120_000 }, () => {
  const eventFields = async (path: string) => (await correctionsIn(path)).map((e) => e.field ?? "").sort();

  it("keeps a net sample that spans days a net sample and shows its end; a one-day sample shows none", async () => {
    const { app, conn, sampleId, start, later } = await methodApp("staff");
    const end = later(2);
    expect((await post(app, `/samples/${sampleId}/method`, { protocol: "aerial net", date_end: end })).status).toBe(302);
    expect(await sampleRow(conn, sampleId)).toEqual(["net", "aerial net", start, end]);
    const page = await (await app.request(`/samples/${sampleId}`)).text();
    expect(page).toMatch(new RegExp(`name="date_end"[^>]*value="${end}"`));
    expect(page).toContain(`name="base:date_end" value="${end}"`);
    // Taking the end away is one day again, and the form then shows none.
    await post(app, `/samples/${sampleId}/method`, { protocol: "aerial net", date_end: "" });
    expect(await sampleRow(conn, sampleId)).toEqual(["net", "aerial net", start, start]);
    expect(await (await app.request(`/samples/${sampleId}`)).text()).toContain(`name="base:date_end" value=""`);
  });

  it("changes the kind with the method and not with the dates", async () => {
    const { app, conn, sampleId, start } = await methodApp("staff");
    await post(app, `/samples/${sampleId}/method`, { protocol: "vane trap", date_end: "" });
    expect(await sampleRow(conn, sampleId)).toEqual(["trap", "vane trap", start, start]);
    await post(app, `/samples/${sampleId}/method`, { protocol: "aerial net", date_end: "" });
    expect(await sampleRow(conn, sampleId)).toEqual(["net", "aerial net", start, start]);
    expect(await rows(conn, `SELECT * FROM sample_kind_method_mismatch`)).toEqual([]);
  });

  it("writes nothing for an end equal to the start of a one-day sample", async () => {
    const { app, sampleId, start, correctionsPath } = await methodApp("staff");
    const res = await post(app, `/samples/${sampleId}/method`, { protocol: "aerial net", date_end: start });
    expect(res.status).toBe(302);
    expect(await correctionsIn(correctionsPath)).toEqual([]);
  });

  it("moving the start of a one-day sample writes no end events where its records state no end", async () => {
    const { app, conn, sampleId, later, correctionsPath } = await methodApp("staff", { observation: false });
    await conn.run(
      `UPDATE legacy_occurrence SET day2 = NULL, month2 = NULL, year2 = NULL WHERE _id IN (SELECT _id FROM legacy_specimen_number WHERE sample_id = ${sampleId})`,
    );
    const moved = later(-1);
    expect((await post(app, `/samples/${sampleId}/method`, { protocol: "aerial net", date_start: moved, date_end: "" })).status).toBe(302);
    const fields = await eventFields(correctionsPath);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.filter((f) => f.endsWith("2"))).toEqual([]);
    expect(await rows(conn, `SELECT CAST(date_end AS VARCHAR) FROM sample WHERE entity_id = ${sampleId}`)).toEqual([[moved]]);
  });

  it("moving the start of a one-day sample blanks the end of records that stated one", async () => {
    const { app, conn, sampleId, later, correctionsPath } = await methodApp("staff", { observation: false });
    await conn.run(
      `UPDATE legacy_occurrence SET day2 = day, month2 = month, year2 = year WHERE _id IN (SELECT _id FROM legacy_specimen_number WHERE sample_id = ${sampleId})`,
    );
    const [[records]] = (await rows(conn, `SELECT count(*) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[bigint]];
    expect((await post(app, `/samples/${sampleId}/method`, { protocol: "aerial net", date_start: later(-1), date_end: "" })).status).toBe(302);
    const events = await correctionsIn(correctionsPath);
    for (const f of ["day2", "month2", "year2"]) {
      const of = events.filter((e) => e.field === f);
      expect(of).toHaveLength(Number(records));
      for (const e of of) expect(e.new_value).toBe("");
    }
  });

  it("clearing the end of a multi-day sample whose records disagree blanks the record that stated one, and writes nothing to the one that did not", async () => {
    const { app, conn, sampleId, start, later, correctionsPath } = await methodApp("staff");
    const ids = ((await rows(conn, `SELECT _id FROM legacy_specimen_number WHERE sample_id = ${sampleId} ORDER BY _id`)) as string[][]).map((r) => r[0]!);
    expect(ids.length).toBeGreaterThan(1);
    const end = later(2);
    const [ey, emo, ed] = end.split("-").map((p) => String(Number(p)));
    await conn.run(`UPDATE sample SET date_end = DATE '${end}' WHERE entity_id = ${sampleId}`);
    await conn.run(`UPDATE legacy_occurrence SET day2 = '${ed}', month2 = '${emo}', year2 = '${ey}' WHERE _id = '${ids[0]}'`);
    await conn.run(`UPDATE legacy_occurrence SET day2 = NULL, month2 = NULL, year2 = NULL WHERE _id IN (${ids.slice(1).map((i) => `'${i}'`).join(", ")})`);
    expect((await post(app, `/samples/${sampleId}/method`, { protocol: "aerial net", date_end: "" })).status).toBe(302);
    expect(await sampleRow(conn, sampleId)).toEqual(["net", "aerial net", start, start]);
    const events = (await correctionsIn(correctionsPath)).filter((e) => (e.field ?? "").endsWith("2"));
    expect(new Set(events.map((e) => e._id))).toEqual(new Set([ids[0]]));
    expect(events.map((e) => e.new_value)).toEqual(["", "", ""]);
  });

  it("compares against a correction the file holds that the store does not, from a save that was not applied", async () => {
    const { app, conn, sampleId, later, correctionsPath } = await methodApp("staff");
    expect((await post(app, `/samples/${sampleId}/method`, { protocol: "aerial net", date_end: later(2) })).status).toBe(302);
    const [[id]] = (await rows(conn, `SELECT min(_id) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[string]];
    // A later save reached the file and lost its store transaction: the file says month 8, the store still says the start's month.
    await upsertCorrections(correctionsPath, [{ _id: id, field: "month2", base_value: "", new_value: "8", author: "x", reason: "lost" }]);
    expect((await post(app, `/samples/${sampleId}/method`, { protocol: "aerial net", date_end: later(3) })).status).toBe(302);
    const mine = (await correctionsIn(correctionsPath)).filter((e) => e._id === id && e.field === "month2");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.new_value).toBe(String(Number(later(3).slice(5, 7))));
  });

  it("accepts a date range alone on a net sample whose series number another trap sample holds, and refuses a trap method for it", async () => {
    const { app, conn, sampleId, later } = await methodApp("staff");
    await conn.run(`UPDATE sample SET sample_number = 'OBAS-00099' WHERE entity_id = ${sampleId}`);
    await insertCleanSample(conn, { sample_number: "'OBAS-00099'", kind: "'trap'", date_start: `DATE '${later(40)}'`, date_end: `DATE '${later(41)}'` });
    expect((await post(app, `/samples/${sampleId}/method`, { protocol: "aerial net", date_end: later(2) })).status).toBe(302);
    expect((await sampleRow(conn, sampleId))?.[0]).toBe("net");
    const refused = await post(app, `/samples/${sampleId}/method`, { protocol: "vane trap", date_end: later(2) });
    expect(await refused.text()).toContain("OBAS-00099");
    expect((await sampleRow(conn, sampleId))?.[0]).toBe("net");
  });

  it("refuses the collector's edit that gives a net sample a trap method when another trap sample holds its series number", async () => {
    const { app, conn, sampleId, later } = await methodApp("collector", { observation: false });
    await conn.run(`UPDATE sample SET sample_number = 'OBAS-00098' WHERE entity_id = ${sampleId}`);
    await insertCleanSample(conn, { sample_number: "'OBAS-00098'", kind: "'trap'", date_start: `DATE '${later(40)}'`, date_end: `DATE '${later(41)}'` });
    const res = await post(app, `/samples/${sampleId}/edit`, { "base:protocol": "aerial net", protocol: "vane trap" });
    expect(await res.text()).toContain("OBAS-00098");
    expect(await rows(conn, `SELECT protocol, kind FROM sample WHERE entity_id = ${sampleId}`)).toEqual([["aerial net", "net"]]);
  });

});
