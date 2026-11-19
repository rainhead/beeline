import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import { compareLegacyExport, writeDifferences } from "../src/compare-legacy-export.js";
import { parseCsv } from "../src/corrections.js";
import { writeLegacyExport } from "../src/legacy-export.js";
import { duckdbReader } from "../src/person-change.js";
import { readSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { loadSample } from "../src/app/record.js";
import { setCollectors, type Actor, type CorrectionDeps } from "../src/app/sample-corrections.js";
import { insertCleanSample, rows, scratchPaths, SETTLED_SEASON } from "./helpers.js";
import { promotedStore } from "./promoted-store.js";

/**
 * Staff correct who collected a sample (beeline-kgyd.4.5), against the
 * old-record fixture: the trap sample OBAS-00658 (record eeee5555, collected
 * by Bea Trapper and Ada Collector, in that order), the trap sample
 * OBAS-00657 (record bbbb2222, Bea alone, filed under her login trapline),
 * and Ada's net sample 1 of 14 July, which cites observation 250000001. All
 * are the old Beeline's, so printed, and settled.
 */

async function setup({ separatePrintWriter = true } = {}) {
  const paths = await scratchPaths();
  const { instance, conn } = await promotedStore("occurrences", { appCorrections: paths.correctionsPath });
  const person = async (name: string) =>
    Number(((await rows(conn, `INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)) as [[number]])[0][0]);
  const sam = await person("Sam Staff");
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${sam}, 3, 'samstaff')`);
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${sam})`);
  const cy = await person("Cy Newcomer");
  // A store that was built, as production was, so the change log follows a sample by its id.
  await conn.run("INSERT INTO schema_migration (name) VALUES ('0001-a-store-that-was-built.sql')");
  await recordSampleChanges(duckdbReader(conn), { log: paths.sampleChangesPath, state: paths.sampleStatePath }, { source: "observation_promotion" });
  const deps: CorrectionDeps = {
    db: createKysely(instance),
    conn,
    printWriter: separatePrintWriter ? await instance.connect() : undefined,
    correctionsPath: paths.correctionsPath,
    sampleOverlayPath: paths.sampleOverlayPath,
    samplePaths: { log: paths.sampleChangesPath, state: paths.sampleStatePath },
    syncJobRunning: () => false,
  };
  const staff: Actor = { personId: sam, signedInPersonId: sam, login: "samstaff", staff: true, impersonating: false, via: "api" };
  const idOf = async (name: string) => Number(((await rows(conn, `SELECT entity_id FROM person WHERE display_name = '${name}'`)) as [[number]])[0][0]);
  const sampleOf = async (n: string) => Number(((await rows(conn, `SELECT entity_id FROM sample WHERE sample_number = '${n}'`)) as [[number]])[0][0]);
  return {
    conn,
    deps,
    paths,
    staff,
    people: { ada: await idOf("Ada Collector"), bea: await idOf("Bea Trapper"), cy, sam },
    pair: await sampleOf("OBAS-00658"),
    solo: await sampleOf("OBAS-00657"),
    linked: await sampleOf("1"),
  };
}
type World = Awaited<ReturnType<typeof setup>>;

const listOf = async (conn: DuckDBConnection, id: number) =>
  (await rows(conn, `SELECT p.display_name FROM sample_collector c JOIN person p ON p.entity_id = c.person_id WHERE c.sample_id = ${id} ORDER BY c.position`)).map(
    ([n]) => n,
  );

async function correctionsIn(path: string): Promise<Record<string, string>[]> {
  const [head = [], ...body] = parseCsv(await readFile(path, "utf8"));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const send = (s: World, id: number, collectors: string[], extra: { note?: string; dryRun?: boolean } = {}) =>
  setCollectors(s.deps, s.staff, id, { collectors, note: extra.note ?? "", dryRun: extra.dryRun });

/** The refusal or the outcome, for one line of expectation. */
const answer = async (s: World, id: number, collectors: string[]) => {
  const r = await send(s, id, collectors);
  return r.ok ? r.outcome : r.refusal === "invalid" ? r.problem : r.refusal;
};

const invariantHolds = async (conn: DuckDBConnection) => expect(await rows(conn, `SELECT count(*) FROM sample_primary_collector_invalid`)).toEqual([[0n]]);

describe("staff correcting a sample's collectors", { timeout: 120_000 }, () => {
  it("puts the second collector of an old sample first, as a recordedBy event on its record, in the file and in the store", async () => {
    const s = await setup();
    const result = await send(s, s.pair, ["Ada Collector", "Bea Trapper"], { note: "Ada set the traps" });
    expect(result).toMatchObject({
      ok: true,
      outcome: "saved",
      dry_run: false,
      collectors: [
        { position: 1, person_id: s.people.ada, name: "Ada Collector" },
        { position: 2, person_id: s.people.bea, name: "Bea Trapper" },
      ],
      first_changed: true,
      reprint_needed: 1,
    });
    if (!result.ok) throw new Error("refused");
    expect(result.warnings[0]).toMatch(/^Ada Collector is now the first collector, in place of Bea Trapper/);
    expect(result.warnings.at(-1)).toBe("1 label on paper print the old collectors: ask for a reprint once the change is made.");
    expect(await listOf(s.conn, s.pair)).toEqual(["Ada Collector", "Bea Trapper"]);
    expect((await correctionsIn(s.paths.correctionsPath)).map((e) => [e._id, e.field, e.base_value, e.new_value, e.author, e.reason])).toEqual([
      ["eeee5555", "recordedBy", "Bea Trapper | Ada Collector", "Ada Collector | Bea Trapper", "samstaff", "Ada set the traps"],
    ]);
    // Applied through promotion's own views, which is what the export reads.
    expect(await rows(s.conn, `SELECT status FROM legacy_correction_state WHERE _id = 'eeee5555' AND field = 'recordedBy'`)).toEqual([["applies"]]);
    expect(await rows(s.conn, `SELECT "recordedBy", "firstName" FROM legacy_occurrence_corrected WHERE _id = 'eeee5555'`)).toEqual([
      ["Ada Collector | Bea Trapper", "Bea and Ada"],
    ]);
    await invariantHolds(s.conn);
    // The history follows the sample by its id although the first collector, part of its reference, moved.
    const history = (await readSampleChanges(s.paths.sampleChangesPath)).filter((c) => c.source === "api");
    expect(history.map((c) => [c.field, c.old_value, c.new_value, c.author, c.reason]).sort()).toEqual([
      ["co_collectors", "name:Ada Collector", "name:Bea Trapper", "samstaff", "Ada set the traps"],
      ["collector", "name:Bea Trapper", "name:Ada Collector", "samstaff", "Ada set the traps"],
    ]);
  });

  it("adds and removes collectors after the first, even on a sample an observation cites", async () => {
    const s = await setup();
    expect(await send(s, s.linked, ["Ada Collector", "Bea Trapper"])).toMatchObject({ ok: true, outcome: "saved", first_changed: false });
    expect(await listOf(s.conn, s.linked)).toEqual(["Ada Collector", "Bea Trapper"]);
    expect(await send(s, s.linked, ["Ada Collector"])).toMatchObject({ ok: true, outcome: "saved", first_changed: false });
    expect(await listOf(s.conn, s.linked)).toEqual(["Ada Collector"]);
    await invariantHolds(s.conn);
  });

  it("an added collector sees where the sample was collected though iNaturalist hides it, and a removed one no longer does", async () => {
    const s = await setup();
    await s.conn.run(`UPDATE sample SET geoprivacy = 'obscured' WHERE entity_id = ${s.linked}`);
    const withheldFor = async (personId: number) =>
      (await loadSample(s.deps.db, s.linked, personId, { staff: false, personIds: [personId] }))!.location_withheld;
    expect(await withheldFor(s.people.cy)).toBe(true);
    await send(s, s.linked, ["Ada Collector", "Cy Newcomer"]);
    expect(await withheldFor(s.people.cy)).toBe(false);
    await send(s, s.linked, ["Ada Collector"]);
    expect(await withheldFor(s.people.cy)).toBe(true);
  });

  it("writes a sample entered in Beeline directly, printed or not, with nothing in the corrections file", async () => {
    const s = await setup();
    const entered = await insertCleanSample(s.conn, {
      kind: "'trap'",
      sample_number: "'OBAS-09999'",
      collector_id: String(s.people.bea),
      date_start: `DATE '${SETTLED_SEASON}-06-01'`,
      date_end: `DATE '${SETTLED_SEASON}-06-08'`,
    });
    await s.conn.run(`INSERT INTO sample_entry (sample_id) VALUES (${entered})`);
    expect(await send(s, entered, ["Cy Newcomer", "Bea Trapper"])).toMatchObject({ ok: true, outcome: "saved", first_changed: true, reprint_needed: 0 });
    await s.conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${entered}, 1, 'TEST0001')`);
    expect(await send(s, entered, ["Bea Trapper"])).toMatchObject({ ok: true, outcome: "saved", reprint_needed: 1 });
    expect(await listOf(s.conn, entered)).toEqual(["Bea Trapper"]);
    expect(await correctionsIn(s.paths.correctionsPath)).toEqual([]);
  });

  it("a dry run answers as the save would and writes nothing", async () => {
    const s = await setup();
    const dry = await send(s, s.pair, ["Ada Collector", "Bea Trapper"], { dryRun: true });
    expect(dry).toMatchObject({ ok: true, outcome: "would_save", dry_run: true, first_changed: true, reprint_needed: 1 });
    expect(await listOf(s.conn, s.pair)).toEqual(["Bea Trapper", "Ada Collector"]);
    expect(await correctionsIn(s.paths.correctionsPath)).toEqual([]);
    expect((await readSampleChanges(s.paths.sampleChangesPath)).filter((c) => c.source === "api")).toEqual([]);
  });

  describe("naming the collectors", () => {
    it("takes the list as it reads now as no change, before any name is matched", async () => {
      const s = await setup();
      // A second person whose name folds to Ada's would make "Ada Collector" ambiguous, were it matched.
      await s.conn.run(`INSERT INTO person (display_name) VALUES ('Ada-Collector')`);
      expect(await send(s, s.pair, [" Bea Trapper", "Ada Collector "])).toMatchObject({ ok: true, outcome: "unchanged", reprint_needed: 0 });
      expect(await answer(s, s.pair, ["Ada Collector", "Bea Trapper"])).toBe("saved");
    });

    it("then an exact display name, then the folded name, then a person's id or iNaturalist login", async () => {
      const s = await setup();
      expect(await answer(s, s.solo, ["bea trapper", "inat:adacollects"])).toBe("saved");
      expect(await listOf(s.conn, s.solo)).toEqual(["Bea Trapper", "Ada Collector"]);
      expect(await answer(s, s.solo, ["BEA TRAPPER", String(s.people.cy)])).toBe("saved");
      expect(await listOf(s.conn, s.solo)).toEqual(["Bea Trapper", "Cy Newcomer"]);
      // The same people, written another way, are no change.
      expect(await answer(s, s.solo, ["beatrapper", "cy newcomer"])).toBe("unchanged");
    });
  });

  describe("refusals", () => {
    it("refuses a list that names nobody, somebody Beeline does not know, or one person twice, and writes nothing", async () => {
      const s = await setup();
      expect(await answer(s, s.pair, [])).toBe("At least one collector is needed.");
      expect(await answer(s, s.pair, ["Bea Trapper", "Dee Nobody"])).toMatch(/^Beeline has nobody called Dee Nobody/);
      expect(await answer(s, s.pair, ["Bea Trapper", "bea trapper"])).toBe("Bea Trapper is named twice.");
      expect(await correctionsIn(s.paths.correctionsPath)).toEqual([]);
      // Even on a sample with no collectors at all, whose empty list an empty one would otherwise match.
      const headless = await insertCleanSample(s.conn, { sample_number: "'H-1'" });
      await s.conn.run(`DELETE FROM sample_collector WHERE sample_id = ${headless}`);
      expect(await answer(s, headless, [" "])).toBe("At least one collector is needed.");
    });

    it("says conflict and writes nothing when the sample's number changed while the save waited", async () => {
      const s = await setup();
      const writer = s.deps.printWriter as unknown as { runAndReadAll: (sql: string, ...rest: unknown[]) => Promise<unknown> };
      const read = writer.runAndReadAll.bind(writer);
      let fired = false;
      writer.runAndReadAll = async (sql: string, ...rest: unknown[]) => {
        // The first statement under the lock: the trap form saved a new number just before it.
        if (!fired) {
          fired = true;
          await s.conn.run(`UPDATE sample SET sample_number = 'OBAS-00659' WHERE entity_id = ${s.pair}`);
        }
        return read(sql, ...rest);
      };
      expect(await answer(s, s.pair, ["Ada Collector", "Bea Trapper"])).toBe("conflict");
      writer.runAndReadAll = read;
      expect(await listOf(s.conn, s.pair)).toEqual(["Bea Trapper", "Ada Collector"]);
      expect(await correctionsIn(s.paths.correctionsPath)).toEqual([]);
    });

    it("refuses a new first collector where an observation is tied to the sample through its first collector", async () => {
      const s = await setup();
      // The sample cites one.
      expect(await answer(s, s.linked, ["Bea Trapper", "Ada Collector"])).toBe("observation_tied");
      // An unlinked observation of the new first collector's carries the number on the sample's dates.
      const [[start, end]] = (await rows(s.conn, `SELECT date_start, date_end FROM sample WHERE entity_id = ${s.solo}`)) as [[unknown, unknown]];
      await s.conn.run(
        `INSERT INTO observation_field (inat_id, user_id, sample_number_raw, specimen_count_raw, observed_on)
         VALUES (777001, 100001, 'OBAS-00657', '4', DATE '${String(end).slice(0, 10)}')`,
      );
      expect(String(start) <= String(end)).toBe(true);
      expect(await answer(s, s.solo, ["Ada Collector"])).toBe("observation_tied");
      // Collectors after the first may still change.
      expect(await answer(s, s.solo, ["Bea Trapper", "Ada Collector"])).toBe("saved");
      // And the old first collector's unlinked observation ties it too (sample_mint_match, sample_claiming_observation).
      await s.conn.run(`UPDATE observation_field SET user_id = 100002 WHERE inat_id = 777001`);
      expect(await answer(s, s.solo, ["Cy Newcomer"])).toBe("observation_tied");
      expect(await listOf(s.conn, s.solo)).toEqual(["Bea Trapper", "Ada Collector"]);
    });

    it("asks again under the lock whether an observation is tied, since one may arrive while the save waits", async () => {
      const s = await setup();
      const [[end]] = (await rows(s.conn, `SELECT date_end FROM sample WHERE entity_id = ${s.solo}`)) as [[unknown]];
      const writer = s.deps.printWriter as unknown as { runAndReadAll: (sql: string, ...rest: unknown[]) => Promise<unknown> };
      const read = writer.runAndReadAll.bind(writer);
      let fired = false;
      writer.runAndReadAll = async (sql: string, ...rest: unknown[]) => {
        // The first statement under the lock: Ada's observation of OBAS-00657 has just been synced.
        if (!fired) {
          fired = true;
          await s.conn.run(
            `INSERT INTO observation_field (inat_id, user_id, sample_number_raw, specimen_count_raw, observed_on)
             VALUES (777002, 100001, 'OBAS-00657', '4', DATE '${String(end).slice(0, 10)}')`,
          );
        }
        return read(sql, ...rest);
      };
      expect(await answer(s, s.solo, ["Ada Collector"])).toBe("observation_tied");
      writer.runAndReadAll = read;
      expect(await listOf(s.conn, s.solo)).toEqual(["Bea Trapper"]);
      expect(await correctionsIn(s.paths.correctionsPath)).toEqual([]);
    });

    it("refuses a new first collector who already has a sample with this number on this day", async () => {
      const s = await setup();
      const [[start, end]] = (await rows(s.conn, `SELECT date_start, date_end FROM sample WHERE entity_id = ${s.pair}`)) as [[unknown, unknown]];
      await insertCleanSample(s.conn, {
        kind: "'trap'",
        sample_number: "'OBAS-00658'",
        collector_id: String(s.people.cy),
        date_start: `DATE '${String(start).slice(0, 10)}'`,
        date_end: `DATE '${String(end).slice(0, 10)}'`,
      });
      expect(await answer(s, s.pair, ["Cy Newcomer", "Bea Trapper"])).toBe("number_taken");
      expect(await answer(s, s.pair, ["Bea Trapper", "Cy Newcomer"])).toBe("saved");
    });

    it("refuses a sample whose labels a print run that has not printed holds", async () => {
      const s = await setup();
      await s.conn.run(`INSERT INTO print_run (prepared_by) SELECT min(entity_id) FROM person`);
      await s.conn.run(
        `INSERT INTO printed_label (print_run_id, specimen_id, sheet, cell, location_text, coordinates_text, date_text,
                                    collector_text, method_text, number_text, latitude, longitude, date_start, date_end)
         SELECT (SELECT max(entity_id) FROM print_run), sp.entity_id, 1, 0, 'l', 'c', 'd', 'c', 'm', 'n', 46.0646, -118.343, s.date_start, s.date_end
         FROM specimen sp JOIN sample s ON s.entity_id = sp.sample_id WHERE sp.sample_id = ${s.solo}`,
      );
      expect(await answer(s, s.solo, ["Bea Trapper", "Ada Collector"])).toBe("in_print_run");
      expect(await correctionsIn(s.paths.correctionsPath)).toEqual([]);
    });

    it("is staff's alone, refused while impersonating, and says not found for no sample", async () => {
      const s = await setup();
      const input = { collectors: ["Ada Collector"], note: "" };
      expect(await setCollectors(s.deps, { ...s.staff, staff: false }, s.solo, input)).toEqual({ ok: false, refusal: "not_admin" });
      expect(await setCollectors(s.deps, { ...s.staff, staff: false, impersonating: true }, s.solo, input)).toEqual({ ok: false, refusal: "impersonating" });
      expect(await setCollectors(s.deps, s.staff, 999_999, input)).toEqual({ ok: false, refusal: "not_found" });
      expect(await setCollectors({ ...s.deps, syncJobRunning: () => true }, s.staff, s.solo, input)).toEqual({ ok: false, refusal: "busy" });
      expect(await setCollectors({ ...s.deps, conn: undefined, printWriter: undefined }, s.staff, s.solo, input)).toEqual({ ok: false, refusal: "unavailable" });
      expect(await listOf(s.conn, s.solo)).toEqual(["Bea Trapper"]);
    });
  });

  describe("the write", () => {
    /** Make the print connection fail one kind of statement. */
    const failing = (s: World, pattern: RegExp, error: string, onBegin?: () => Promise<unknown>) => {
      const writer = (s.deps.printWriter ?? s.conn) as unknown as { run: (sql: string, ...rest: unknown[]) => Promise<unknown> };
      const run = writer.run.bind(writer);
      let fired = false;
      writer.run = async (sql: string, ...rest: unknown[]) => {
        if (!fired && pattern.test(sql)) {
          fired = true;
          throw new Error(error);
        }
        const result = await run(sql, ...rest);
        if (onBegin !== undefined && /^BEGIN/.test(sql)) await onBegin();
        return result;
      };
      return () => (writer.run = run);
    };

    it("a failure after the old list is deleted leaves the old list whole", async () => {
      const s = await setup();
      const restore = failing(s, /^INSERT INTO sample_collector/, "boom: the write fails part-way");
      await expect(send(s, s.pair, ["Ada Collector", "Bea Trapper"])).rejects.toThrow(/boom/);
      restore();
      expect(await listOf(s.conn, s.pair)).toEqual(["Bea Trapper", "Ada Collector"]);
      expect(await rows(s.conn, `SELECT count(*) FROM legacy_app_correction`)).toEqual([[0n]]);
      await invariantHolds(s.conn);
    });

    it("rolls back a list that would have no head", async () => {
      const s = await setup();
      // A writer that puts everyone at position 2 stands for any mistake that leaves the list headless.
      const writer = s.deps.printWriter as unknown as { run: (sql: string, params?: unknown[]) => Promise<unknown> };
      const run = writer.run.bind(writer);
      writer.run = (sql: string, params?: unknown[]) =>
        /^INSERT INTO sample_collector/.test(sql) ? run(sql, [params![0], params![1], 2]) : run(sql, params);
      await expect(send(s, s.solo, ["Ada Collector"])).rejects.toThrow(/exactly one first collector/);
      writer.run = run;
      expect(await listOf(s.conn, s.solo)).toEqual(["Bea Trapper"]);
      await invariantHolds(s.conn);
    });

    it("is its own transaction on the print connection: another request's write while it is open survives its rollback", async () => {
      const s = await setup();
      const restore = failing(s, /^INSERT INTO sample_collector/, "boom", () =>
        s.conn.run(`UPDATE person SET display_name = 'Sam Staffer' WHERE display_name = 'Sam Staff'`),
      );
      await expect(send(s, s.pair, ["Ada Collector", "Bea Trapper"])).rejects.toThrow(/boom/);
      restore();
      expect(await rows(s.conn, `SELECT count(*) FROM person WHERE display_name = 'Sam Staffer'`)).toEqual([[1n]]);
    });

    it("on an old sample that loses a write conflict says the change is recorded and not applied, and a repeat applies it once", async () => {
      const s = await setup();
      const restore = failing(s, /^DELETE FROM sample_collector/, "TransactionContext Error: Conflict on update!");
      expect(await answer(s, s.solo, ["Bea Trapper", "Ada Collector"])).toBe("not_applied");
      restore();
      expect(await listOf(s.conn, s.solo)).toEqual(["Bea Trapper"]);
      expect(await answer(s, s.solo, ["Bea Trapper", "Ada Collector"])).toBe("saved");
      expect(await listOf(s.conn, s.solo)).toEqual(["Bea Trapper", "Ada Collector"]);
      expect(await correctionsIn(s.paths.correctionsPath)).toHaveLength(1);
    });

    it("on a sample with no old records that loses a write conflict says nothing was done", async () => {
      const s = await setup();
      const minted = await insertCleanSample(s.conn, { sample_number: "'M-2'", collector_id: String(s.people.ada) });
      const restore = failing(s, /^DELETE FROM sample_collector/, "TransactionContext Error: Conflict on update!");
      expect(await answer(s, minted, ["Ada Collector", "Cy Newcomer"])).toBe("busy");
      restore();
      expect(await listOf(s.conn, minted)).toEqual(["Ada Collector"]);
    });

    it("runs on the app's connection where there is no print connection", async () => {
      const s = await setup({ separatePrintWriter: false });
      expect(await answer(s, s.pair, ["Ada Collector", "Bea Trapper"])).toBe("saved");
      expect(await listOf(s.conn, s.pair)).toEqual(["Ada Collector", "Bea Trapper"]);
    });
  });

  describe("the legacy-format export and its comparison", () => {
    const exported = async (s: World) => {
      const dir = await mkdtemp(join(tmpdir(), "sample-collectors-"));
      const path = join(dir, "occurrences.csv");
      await writeLegacyExport(s.conn, path);
      await compareLegacyExport(s.conn, path, []);
      const differences = join(dir, "differences.csv");
      await writeDifferences(s.conn, [], differences);
      return {
        record: async (id: string) =>
          (
            await rows(
              s.conn,
              `SELECT "recordedBy", "firstName", "lastName", "firstNameInitial", "userLogin", "userId"
               FROM read_csv('${path}', header = true, all_varchar = true)
               WHERE "fieldNumber" = (SELECT "fieldNumber" FROM legacy_occurrence WHERE _id = '${id}')`,
            )
          )[0],
        kinds: async (id: string) =>
          rows(
            s.conn,
            `SELECT "column", kind FROM read_csv('${differences}', header = true, all_varchar = true)
             WHERE field_number = (SELECT "fieldNumber" FROM legacy_occurrence WHERE _id = '${id}')
               AND "column" IN ('recordedBy', 'firstName', 'lastName', 'firstNameInitial', 'userLogin', 'userId') ORDER BY 1`,
          ),
      };
    };

    it("writes the corrected collectors, and the comparison calls every collector column that moved a staff correction", async () => {
      const s = await setup();
      await send(s, s.solo, ["Ada Collector", "Bea Trapper"]);
      const out = await exported(s);
      expect((await out.record("bbbb2222"))?.slice(0, 1)).toEqual(["Ada Collector | Bea Trapper"]);
      expect((await out.record("bbbb2222"))?.slice(4)).toEqual(["adacollects", "100001"]);
      const kinds = await out.kinds("bbbb2222");
      expect(kinds.length).toBeGreaterThan(0);
      expect(kinds.filter(([, kind]) => kind !== "staff_correction")).toEqual([]);
    });

    it("never writes the old collector's login on a record whose first collector has none", async () => {
      const s = await setup();
      await send(s, s.solo, ["Cy Newcomer"]);
      const out = await exported(s);
      // Bea filed the record under trapline; Cy has no iNaturalist account, so the record has no login now.
      expect(await out.record("bbbb2222")).toEqual(["Cy Newcomer", null, null, null, null, null]);
      expect((await out.kinds("bbbb2222")).filter(([, kind]) => kind !== "staff_correction")).toEqual([]);
    });

    it("keeps the old record's own login where the first collector stays and has no account", async () => {
      const s = await setup();
      await s.conn.run(`DELETE FROM inat_account WHERE person_id = ${s.people.bea}`);
      await send(s, s.solo, ["Bea Trapper", "Cy Newcomer"]);
      const out = await exported(s);
      expect((await out.record("bbbb2222"))?.slice(4)).toEqual(["trapline", "100002"]);
      expect((await out.kinds("bbbb2222")).filter(([column]) => column === "userLogin" || column === "userId")).toEqual([]);
    });

    it("keeps the login of a first collector who stays, however their name is spelled now", async () => {
      const s = await setup();
      // Bea was renamed on her page since promotion, and has no account in Beeline: the record's own login is still hers.
      await s.conn.run(`UPDATE person SET display_name = 'Bea Trapper-Jones' WHERE entity_id = ${s.people.bea}`);
      await s.conn.run(`DELETE FROM inat_account WHERE person_id = ${s.people.bea}`);
      await send(s, s.solo, ["Bea Trapper-Jones", "Cy Newcomer"]);
      const out = await exported(s);
      expect(await out.record("bbbb2222")).toEqual(["Bea Trapper-Jones | Cy Newcomer", "Bea | ", "Trapper | ", "B. | ", "trapline", "100002"]);
      expect((await out.kinds("bbbb2222")).filter(([column]) => column === "userLogin" || column === "userId")).toEqual([]);
    });

    it("leaves every record nobody corrected exactly as it was", async () => {
      const s = await setup();
      const dir = await mkdtemp(join(tmpdir(), "sample-collectors-"));
      const before = join(dir, "before.csv");
      const after = join(dir, "after.csv");
      await writeLegacyExport(s.conn, before);
      await send(s, s.solo, ["Cy Newcomer"]);
      await writeLegacyExport(s.conn, after);
      // The corrected record's line, by its field number, is the only one that may differ.
      const [[fieldNumber]] = (await rows(s.conn, `SELECT "fieldNumber" FROM legacy_occurrence WHERE _id = 'bbbb2222'`)) as [[string]];
      const others = async (path: string) => {
        const lines = (await readFile(path, "utf8")).split("\n");
        return lines.filter((line) => !line.includes(`,${fieldNumber},`)).join("\n");
      };
      expect((await readFile(before, "utf8")).split("\n").filter((l) => l.includes(`,${fieldNumber},`))).toHaveLength(1);
      expect(await others(after)).toBe(await others(before));
      expect((await readFile(after, "utf8")) === (await readFile(before, "utf8"))).toBe(false);
    });
  });
});
