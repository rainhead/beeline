import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import { beesByYear, classify, identificationBatches, taxaFound } from "../src/app/your-bees.js";
import { createApp } from "../src/app/server.js";
import type { InatClient } from "../src/app/auth.js";
import { en } from "../src/app/messages/en.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths, SETTLED_SEASON, CURRENT_SEASON } from "./helpers.js";

/**
 * What experts said each specimen is, as the front page tells it
 * (beeline-xegx, schema/111): a repeat of the same name is not news, a
 * changed name is, and the date is when it was identified rather than when
 * Beeline heard. The cases are the shapes production's store holds: the old
 * Beeline's undated copy of a name that Ecdysis then repeats with its entry
 * time, an expert revising a name in Ecdysis, an expert's sheet that states
 * only a year, and names only the old Beeline ever held.
 */

type Conn = Awaited<ReturnType<typeof createMemoryDb>>["conn"];

const one = async (conn: Conn, query: string): Promise<number> => {
  const [[id]] = (await (await conn.run(query)).getRows()) as [[number]];
  return id;
};

async function fixture() {
  const { instance, conn } = await createMemoryDb();
  const person = (name: string) => one(conn, `INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`);
  const ada = await person("Ada Adams");
  const bo = await person("Bo Barnes");
  const lin = await person("Lin Lee");

  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Apidae')`);
  const apidae = await one(conn, `SELECT entity_id FROM animal WHERE scientific_name = 'Apidae'`);
  await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) VALUES ('genus', 'Bombus', ${apidae})`);
  const bombus = await one(conn, `SELECT entity_id FROM animal WHERE scientific_name = 'Bombus'`);
  await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) VALUES
    ('species', 'Bombus vosnesenskii', ${bombus}), ('species', 'Bombus caliginosus', ${bombus}), ('species', 'Bombus mixtus', ${bombus})`);
  const animal = (name: string) => one(conn, `SELECT entity_id FROM animal WHERE scientific_name = '${name}'`);

  // Ada's sample, one Bo collected with Ada as second collector, and Bo's own.
  const adas = await insertCleanSample(conn, { collector_id: String(ada), sample_number: "'1'" });
  const shared = await insertCleanSample(conn, { collector_id: String(bo), sample_number: "'2'" });
  await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${shared}, ${ada}, 2)`);
  const bos = await insertCleanSample(conn, { collector_id: String(bo), sample_number: "'3'" });
  await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES
    (${adas}, 1, '26000101'), (${adas}, 2, '26000102'), (${adas}, 3, '26000103'), (${adas}, 4, NULL),
    (${shared}, 1, '26000201'), (${bos}, 1, '26000301')`);
  const spec = (n: string) => one(conn, `SELECT entity_id FROM specimen WHERE field_number = '${n}'`);

  let record = 0;
  /** An expert determination, as one of the import channels records it. */
  const expert = async (
    specimen: number,
    name: string,
    channel: "legacy_import" | "ecdysis_import" | "worksheet_import" | "in_app",
    recorded: string,
    extra: { enteredAt?: string; sentAt?: string; on?: string; precision?: "year" | "month"; by?: number; byName?: string } = {},
  ) => {
    const id = await one(
      conn,
      `INSERT INTO determination (specimen_id, animal_id, is_expert, channel, verbatim_identification, determiner_id, determiner_name,
                                  determined_on, determined_on_precision, recorded_at)
       VALUES (${specimen}, ${await animal(name)}, true, '${channel}', ${channel === "legacy_import" ? "NULL" : `'${name}'`},
               ${extra.by ?? "NULL"}, ${extra.byName === undefined ? "NULL" : `'${extra.byName}'`},
               ${extra.on === undefined ? "NULL" : `DATE '${extra.on}'`}, ${extra.precision === undefined ? "NULL" : `'${extra.precision}'`},
               TIMESTAMPTZ '${recorded}') RETURNING entity_id`,
    );
    if (channel === "ecdysis_import") {
      await conn.run(`INSERT INTO ecdysis_identification (record_id, determination_id, entered_at)
                      VALUES ('r${++record}', ${id}, ${extra.enteredAt === undefined ? "NULL" : `TIMESTAMP '${extra.enteredAt}'`})`);
    }
    if (channel === "worksheet_import") {
      await conn.run(`INSERT INTO worksheet_determination (determination_id, file_id, file_name, file_modified_at, sheet, row_number)
                      VALUES (${id}, 'f1', 'Idaho dets', TIMESTAMPTZ '${extra.sentAt}', 'Sheet1', ${++record})`);
    }
    return id;
  };

  return { db: createKysely(instance), conn, ada, bo, lin, animal, spec, expert, adas };
}

const stretches = (conn: Conn, specimen: number) =>
  rows(
    conn,
    `SELECT ei.stretch, a.scientific_name, was.scientific_name, ei.determiner_name, strftime(ei.identified_at, '%Y-%m-%dT%H:%M:%SZ'), ei.is_latest
     FROM expert_identification ei JOIN animal a ON a.entity_id = ei.animal_id
     LEFT JOIN animal was ON was.entity_id = ei.previous_animal_id
     WHERE ei.specimen_id = ${specimen} ORDER BY ei.stretch`,
  );

describe("expert_identification", () => {
  it("counts Ecdysis repeating the old Beeline's name as one identification, with no date to make it news", async () => {
    const { conn, spec, expert } = await fixture();
    const s = await spec("26000101");
    await expert(s, "Bombus vosnesenskii", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(s, "Bombus vosnesenskii", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-08-12 15:00:00", byName: "L. Best" });
    // The old Beeline knew the name at a time it never recorded, so Ecdysis's
    // entry dates only the repeat (Peter, 2026-11-12: no news without a useful date).
    expect(await stretches(conn, s)).toEqual([[1, "Bombus vosnesenskii", null, "L. Best", null, true]]);
    expect(await rows(conn, `SELECT identified_at_is_bound FROM expert_identification WHERE specimen_id = ${s}`)).toEqual([[false]]);
  });

  it("keeps an exact day and an 'on or before' one apart, even on the same date", async () => {
    const { db, ada, spec, expert } = await fixture();
    await expert(await spec("26000101"), "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-11-09 19:00:00" });
    await expert(await spec("26000102"), "Bombus mixtus", "worksheet_import", "2026-11-10 00:34:00Z", { sentAt: "2026-11-09 18:00:00Z" });
    const { batches } = await identificationBatches(db, ada);
    expect(batches.map((b) => b.on_or_before).sort()).toEqual([false, true]);
  });

  it("makes a changed name a new identification that remembers the old one", async () => {
    const { conn, spec, expert } = await fixture();
    const s = await spec("26000102");
    await expert(s, "Bombus caliginosus", "ecdysis_import", "2026-06-02 08:00:00Z", { enteredAt: "2026-06-02 08:00:00" });
    await expert(s, "Bombus vosnesenskii", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 09:30:00" });
    // And back again: a name returning is a change too, not the first stretch resuming.
    await expert(s, "Bombus caliginosus", "ecdysis_import", "2026-11-10 11:00:00Z", { enteredAt: "2026-11-09 16:00:00" });
    expect((await stretches(conn, s)).map((r) => [r[0], r[1], r[2], r[5]])).toEqual([
      [1, "Bombus caliginosus", null, false],
      [2, "Bombus vosnesenskii", "Bombus caliginosus", false],
      [3, "Bombus caliginosus", "Bombus vosnesenskii", true],
    ]);
  });

  it("credits the person and the name from the same determination", async () => {
    const { conn, spec, expert, lin } = await fixture();
    const s = await spec("26000101");
    await expert(s, "Bombus vosnesenskii", "ecdysis_import", "2026-06-02 08:00:00Z", { enteredAt: "2026-06-02 08:00:00", byName: "R. Rivera" });
    await expert(s, "Bombus vosnesenskii", "in_app", "2026-11-05 09:00:00Z", { by: lin });
    expect(await rows(conn, `SELECT determiner_id, determiner_name FROM expert_identification WHERE specimen_id = ${s}`)).toEqual([[null, "R. Rivera"]]);
  });

  it("leaves a name only the old Beeline held undated, since it kept no dates", async () => {
    const { conn, spec, expert } = await fixture();
    const s = await spec("26000103");
    await expert(s, "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    expect(await stretches(conn, s)).toEqual([[1, "Bombus mixtus", null, null, null, true]]);
  });

  it("dates a sheet by the day it states, at noon UTC, and by when it was sent when it states only a year", async () => {
    const { conn, spec, expert } = await fixture();
    const a = await spec("26000101");
    const b = await spec("26000102");
    await expert(a, "Bombus mixtus", "worksheet_import", "2026-11-10 00:34:00Z", { on: "2026-03-05", sentAt: "2026-11-09 18:00:00Z" });
    await expert(b, "Bombus mixtus", "worksheet_import", "2026-11-10 00:34:00Z", { on: "2025-01-01", precision: "year", sentAt: "2026-11-09 18:00:00Z" });
    expect((await stretches(conn, a))[0]![4]).toEqual("2026-03-05T12:00:00Z");
    expect((await stretches(conn, b))[0]![4]).toEqual("2026-11-09T18:00:00Z");
    // Only the second is a bound: the sheet arrived then, and said no more.
    expect(await rows(conn, `SELECT specimen_id = ${b}, identified_at_is_bound FROM expert_identification ORDER BY 1`)).toEqual([[false, false], [true, true]]);
  });

  it("ignores volunteers' determinations, which are not news to the volunteer", async () => {
    const { conn, spec, animal, ada } = await fixture();
    const s = await spec("26000101");
    await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, verbatim_identification, determiner_id, recorded_at)
                    VALUES (${s}, ${await animal("Bombus")}, false, 'in_app', 'Bombus', ${ada}, TIMESTAMPTZ '2026-08-01 10:00:00Z')`);
    expect(await stretches(conn, s)).toEqual([]);
  });
});

describe("identifications in batches (Your bees, and the front page)", () => {
  async function populated() {
    const f = await fixture();
    const { spec, expert, lin, ada, conn, animal } = f;
    // 20 Oct 2026 in Oregon (Ecdysis's entry times are Pacific): one entered
    // late in the evening, which is already the 21st in UTC.
    await expert(await spec("26000101"), "Bombus vosnesenskii", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(await spec("26000101"), "Bombus vosnesenskii", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 23:30:00", byName: "L. Best" });
    await expert(await spec("26000102"), "Bombus caliginosus", "ecdysis_import", "2026-06-02 08:00:00Z", { enteredAt: "2026-06-02 08:00:00", byName: "L. Best" });
    await expert(await spec("26000102"), "Bombus vosnesenskii", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 17:00:00", byName: "L. Best" });
    // Ada's own genus, uploaded to Ecdysis and read back as an expert's, then
    // taken to species the same day as above.
    await expert(await spec("26000103"), "Bombus", "ecdysis_import", "2026-07-01 08:00:00Z", { enteredAt: "2026-07-01 08:00:00", by: ada });
    await expert(await spec("26000103"), "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 18:00:00", byName: "L. Best" });
    // Named in Beeline by Lin, and only the old Beeline knows the shared sample's.
    const unnumbered = await one(conn, `SELECT entity_id FROM specimen WHERE field_number IS NULL`);
    await expert(unnumbered, "Bombus mixtus", "in_app", "2026-09-01 17:00:00Z", { by: lin });
    await expert(await spec("26000201"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    // Bo's own, which is not Ada's business.
    await expert(await spec("26000301"), "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-11-01 12:00:00" });
    void animal;
    return { ...f, unnumbered };
  }

  it("groups by the day in Oregon, counts each year's bees, and says what each identification did", async () => {
    const { db, ada } = await populated();
    for (const inlineLimit of [2_000, 0]) {
      const { batches, undated } = await identificationBatches(db, ada, { inlineLimit });
      expect(batches).toHaveLength(3);
      // Ada's own genus of 1 July, read back from Ecdysis, is no batch of hers.
      // 26000101's name the old Beeline held before Ecdysis repeated it, and
      // 26000201's only the old Beeline knows: both undated, so no news.
      expect(undated).toBe(2);
      expect(batches.map((b) => [b.identified_at.toISOString(), b.on_or_before])).toEqual([
        ["2026-10-21T00:00:00.000Z", false],
        ["2026-09-01T17:00:00.000Z", false],
        ["2026-06-02T15:00:00.000Z", false],
      ]);
      const [oct, sep, jun] = batches;
      expect(oct!.seasons).toEqual([{ season: CURRENT_SEASON, count: 2 }]);
      expect(oct!.kinds.map((k) => [k.kind, k.from, k.to, k.count, k.own])).toEqual(
        expect.arrayContaining([
          ["corrected", null, null, 1, 0],
          ["finer", "genus", "species", 1, 1],
        ]),
      );
      expect(oct!.determiners).toEqual(["L. Best"]);
      expect(oct!.names.find((n) => n.scientific_name === "Bombus mixtus")?.previous?.scientific_name).toBe("Bombus");
      expect(sep!.determiners).toEqual(["Lin Lee"]);
      expect(jun!.kinds.map((k) => k.kind)).toEqual(["first"]);
    }
  });

  it("shows an expert confirming the volunteer's own name, which is not news until then", async () => {
    const { db, ada, spec, expert, lin } = await fixture();
    const s = await spec("26000101");
    await expert(s, "Bombus mixtus", "ecdysis_import", "2026-03-02 08:00:00Z", { enteredAt: "2026-03-01 10:00:00", by: ada });
    await expert(s, "Bombus mixtus", "ecdysis_import", "2026-10-02 08:00:00Z", { enteredAt: "2026-10-01 10:00:00", by: lin });
    const { batches, undated } = await identificationBatches(db, ada);
    expect(undated).toBe(0);
    expect(batches.map((b) => [b.identified_at.toISOString(), b.kinds.map((k) => [k.kind, k.count, k.own])])).toEqual([
      ["2026-10-01T17:00:00.000Z", [["confirmed", 1, 1]]],
    ]);
  });

  it("still sees the confirmation when a repeat naming nobody comes between", async () => {
    const { db, ada, spec, expert, lin } = await fixture();
    const s = await spec("26000101");
    await expert(s, "Bombus mixtus", "ecdysis_import", "2026-03-02 08:00:00Z", { enteredAt: "2026-03-01 10:00:00", by: ada });
    await expert(s, "Bombus mixtus", "ecdysis_import", "2026-05-02 08:00:00Z", { enteredAt: "2026-05-01 10:00:00" });
    await expert(s, "Bombus mixtus", "ecdysis_import", "2026-10-02 08:00:00Z", { enteredAt: "2026-10-01 10:00:00", by: lin });
    const { batches } = await identificationBatches(db, ada);
    expect(batches.flatMap((b) => b.kinds.map((k) => [k.kind, k.own]))).toEqual([["confirmed", 1]]);
  });

  it("leaves an identification of something other than a bee out of the batches and the count", async () => {
    const { db, conn, ada, spec, expert } = await fixture();
    await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Vespidae')`);
    await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) VALUES ('genus', 'Vespula', (SELECT entity_id FROM animal WHERE scientific_name = 'Vespidae'))`);
    await expert(await spec("26000101"), "Vespula", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-01 10:00:00" });
    await expert(await spec("26000102"), "Vespula", "legacy_import", "2026-11-03 22:25:00Z");
    expect(await identificationBatches(db, ada)).toEqual({ batches: [], undated: 0 });
  });

  it("never compares a person with whoever gave an earlier name, so the old Beeline's renaming stays undated", async () => {
    const { conn, spec, expert, lin, ada } = await fixture();
    const s = await spec("26000101");
    await expert(s, "Bombus caliginosus", "ecdysis_import", "2026-03-02 08:00:00Z", { enteredAt: "2026-03-01 10:00:00", by: ada });
    await expert(s, "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(s, "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-01 10:00:00", by: lin });
    // Lin's repeat of the old Beeline's name is part of its stretch, not a confirmation, and that stretch has no date.
    expect((await stretches(conn, s)).map((r) => [r[0], r[1], r[4]])).toEqual([
      [1, "Bombus caliginosus", "2026-03-01T18:00:00Z"],
      [2, "Bombus mixtus", null],
    ]);
  });

  it("leaves a bee an expert later called a wasp out of the batches and the count", async () => {
    const { db, conn, ada, spec, expert } = await fixture();
    await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Vespidae')`);
    await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) VALUES ('genus', 'Vespula', (SELECT entity_id FROM animal WHERE scientific_name = 'Vespidae'))`);
    const s = await spec("26000101");
    await expert(s, "Bombus mixtus", "ecdysis_import", "2026-03-02 08:00:00Z", { enteredAt: "2026-03-01 10:00:00" });
    await expert(s, "Vespula", "legacy_import", "2026-11-03 22:25:00Z");
    expect(await identificationBatches(db, ada)).toEqual({ batches: [], undated: 0 });
  });

  it("does not count the person's own dated name as undated when a repeat naming nobody follows it", async () => {
    const { db, ada, spec, expert } = await fixture();
    const s = await spec("26000101");
    await expert(s, "Bombus mixtus", "ecdysis_import", "2026-03-02 08:00:00Z", { enteredAt: "2026-03-01 10:00:00", by: ada });
    await expert(s, "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    expect(await identificationBatches(db, ada)).toEqual({ batches: [], undated: 0 });
  });

  it("does not count the undated where the front page asks it not to", async () => {
    const { db, ada, spec, expert } = await fixture();
    await expert(await spec("26000101"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    expect((await identificationBatches(db, ada, { countUndated: false })).undated).toBeNull();
    expect((await identificationBatches(db, ada)).undated).toBe(1);
  });

  it("leaves out the person's own name even where it names them only as text", async () => {
    const { db, ada, spec, expert } = await fixture();
    await expert(await spec("26000101"), "Bombus mixtus", "ecdysis_import", "2026-03-02 08:00:00Z", { enteredAt: "2026-03-01 10:00:00", byName: "ada adams" });
    expect((await identificationBatches(db, ada)).batches).toEqual([]);
  });

  it("dates an Ecdysis identification with no entry time only as 'on or before' its load", async () => {
    const { db, ada, spec, expert } = await fixture();
    await expert(await spec("26000101"), "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z");
    expect((await identificationBatches(db, ada)).batches.map((b) => b.on_or_before)).toEqual([true]);
  });

  it("counts a bee renamed twice in a day once, and lists both names", async () => {
    const { db, ada, spec, expert } = await fixture();
    const s = await spec("26000101");
    await expert(s, "Bombus caliginosus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 17:00:00" });
    await expert(s, "Bombus vosnesenskii", "ecdysis_import", "2026-11-05 11:00:00Z", { enteredAt: "2026-10-20 18:00:00" });
    const [day] = (await identificationBatches(db, ada)).batches;
    expect(day!.seasons).toEqual([{ season: CURRENT_SEASON, count: 1 }]);
    expect(day!.kinds.map((k) => [k.kind, k.count])).toEqual(expect.arrayContaining([["first", 1], ["corrected", 1]]));
  });

  it("shows the newest days up to the limit", async () => {
    const { db, ada } = await populated();
    const { batches } = await identificationBatches(db, ada, { maxBatches: 1 });
    expect(batches).toHaveLength(1);
  });

  it("says 'on or before' for a sheet that stated no day, and lists an old Beeline name that states one", async () => {
    const { db, ada, spec, expert } = await fixture();
    await expert(await spec("26000101"), "Bombus mixtus", "worksheet_import", "2026-11-10 00:34:00Z", { sentAt: "2026-11-09 18:00:00Z" });
    await expert(await spec("26000103"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z", { on: "2025-07-01" });
    const { batches } = await identificationBatches(db, ada);
    expect(batches.map((b) => [b.identified_at.toISOString(), b.on_or_before])).toEqual([
      ["2026-11-09T18:00:00.000Z", true],
      ["2025-07-01T12:00:00.000Z", false],
    ]);
  });

  it("counts an old Beeline name that states only a year as undated, not as datable", async () => {
    const { db, ada, spec, expert } = await fixture();
    await expert(await spec("26000101"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z", { on: "2025-01-01", precision: "year" });
    expect(await identificationBatches(db, ada)).toEqual({ batches: [], undated: 1 });
  });

  it("lists the specimens each name was given to, for links to them", async () => {
    const { db, ada, spec, expert } = await fixture();
    await expert(await spec("26000102"), "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 17:00:00" });
    await expert(await spec("26000101"), "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 17:30:00" });
    const [day] = (await identificationBatches(db, ada)).batches;
    expect(day!.names[0]!.specimens.map((s) => s.field_number)).toEqual(["26000101", "26000102"]);
  });

  it("is empty for a person with no specimens", async () => {
    const { db, lin } = await populated();
    expect(await identificationBatches(db, lin)).toEqual({ batches: [], undated: 0 });
  });

  it("tells finer, coarser, corrected and a change in certainty apart", () => {
    const ancestors = new Map([[3, new Set([2, 1])], [4, new Set([2, 1])], [2, new Set([1])]]);
    expect(classify(3, null, null, null, ancestors)).toBe("first");
    expect(classify(3, null, 2, null, ancestors)).toBe("finer");
    expect(classify(2, null, 3, null, ancestors)).toBe("coarser");
    expect(classify(4, null, 3, null, ancestors)).toBe("corrected");
    expect(classify(3, null, 3, "cf.", ancestors)).toBe("certainty");
  });
});

describe("bees by year", () => {
  it("leaves out a specimen identified as something other than a bee", async () => {
    const { db, conn, ada, spec, expert } = await fixture();
    await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Vespidae')`);
    await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) VALUES ('genus', 'Vespula', (SELECT entity_id FROM animal WHERE scientific_name = 'Vespidae'))`);
    await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) VALUES ('species', 'Vespula pensylvanica', (SELECT entity_id FROM animal WHERE scientific_name = 'Vespula'))`);
    await expert(await spec("26000101"), "Vespula pensylvanica", "legacy_import", "2026-11-03 22:25:00Z");
    expect(await beesByYear(db, ada)).toEqual([{ season: CURRENT_SEASON, collected: 4, species: 0, genus: 0, coarser: 0, none: 4 }]);
  });

  it("counts each year's bees by how far the determination of record goes, volunteers' included", async () => {
    const { db, conn, ada, spec, expert, animal } = await fixture();
    const settled = await insertCleanSample(conn, { collector_id: String(ada), sample_number: "'9'", date_start: `DATE '${SETTLED_SEASON}-06-01'`, date_end: `DATE '${SETTLED_SEASON}-06-01'` });
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${settled}, 1, '25000901'), (${settled}, 2, '25000902')`);
    await expert(await spec("26000101"), "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 17:00:00" });
    await expert(await spec("26000102"), "Bombus", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(await spec("25000901"), "Apidae", "legacy_import", "2026-11-03 22:25:00Z");
    await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, verbatim_identification, determiner_id, recorded_at)
                    VALUES (${await spec("25000902")}, ${await animal("Bombus caliginosus")}, false, 'in_app', 'Bombus caliginosus', ${ada}, TIMESTAMPTZ '2026-08-01 10:00:00Z')`);
    // Ada's current-season sample has four specimens and the shared one one.
    expect(await beesByYear(db, ada)).toEqual([
      { season: SETTLED_SEASON, collected: 2, species: 1, genus: 0, coarser: 1, none: 0 },
      { season: CURRENT_SEASON, collected: 5, species: 1, genus: 1, coarser: 0, none: 3 },
    ]);
  });
});

describe("the pages", () => {
  async function app(personId: number, db: ReturnType<typeof createKysely>) {
    const unusedInat: InatClient = {
      authorizeUrl: () => "unused",
      exchangeCode: () => Promise.reject(new Error("not under test")),
      identity: () => Promise.reject(new Error("not under test")),
    };
    return createApp({
      ...(await scratchPaths()),
      db,
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId, login: "ada", iconUrl: null }),
    });
  }

  it("puts the newest days on the front page, without linking to Your bees yet", async () => {
    const f = await fixture();
    await f.expert(await f.spec("26000102"), "Bombus caliginosus", "ecdysis_import", "2026-06-02 08:00:00Z", { enteredAt: "2026-06-02 08:00:00", byName: "L. Best" });
    await f.expert(await f.spec("26000102"), "Bombus vosnesenskii", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 17:00:00", byName: "L. Best" });
    const html = await (await (await app(f.ada, f.db)).request("/")).text();
    const section = html.slice(html.indexOf(en.qc.identifications.heading));
    expect(section).toContain(en.yourBees.batches.identified([en.yourBees.batches.ofSeason(1, CURRENT_SEASON)], 1));
    expect(section).toContain(en.yourBees.batches.kinds([en.yourBees.batches.kind.corrected(1)]));
    expect(html).not.toContain('href="/bees"');
  });

  it("draws Your bees: the chart by year and every day of identifications", async () => {
    const f = await fixture();
    await f.expert(await f.spec("26000101"), "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 17:00:00", byName: "L. Best" });
    const res = await (await app(f.ada, f.db)).request("/bees");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(en.yourBees.byYear.heading);
    expect(html).toContain("<svg");
    expect(html).toContain(en.yourBees.batches.kinds([en.yourBees.batches.kind.first(1)]));
    expect(html).toContain(en.yourBees.byYear.title(CURRENT_SEASON, 5, 1, 0, 0, 4));
  });
});

describe("what you found", () => {
  it("rolls each bee's name up to its genus and family, counting a species once whatever its qualifier", async () => {
    const { db, conn, ada, spec, expert, animal } = await fixture();
    await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('order', 'Hymenoptera')`);
    await expert(await spec("26000101"), "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 17:00:00" });
    await expert(await spec("26000102"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    await conn.run(`UPDATE determination SET qualifier = 'cf.' WHERE specimen_id = ${await spec("26000102")}`);
    await expert(await spec("26000103"), "Bombus", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(await spec("26000201"), "Hymenoptera", "legacy_import", "2026-11-03 22:25:00Z");
    void animal;
    const found = await taxaFound(db, ada);
    expect([found.collected, found.identified, found.families, found.genera, found.species]).toEqual([5, 4, 1, 1, 1]);
    expect(found.byFamily.map((f) => [f.name, f.bees])).toEqual([["Apidae", 3], [null, 1]]);
    const bombus = found.byFamily[0]!.genera[0]!;
    expect([bombus.name, bombus.bees, bombus.toGenusOnly]).toEqual(["Bombus", 3, 1]);
    expect(bombus.species.map((s) => [s.scientific_name, s.qualifier, s.bees])).toEqual(
      expect.arrayContaining([["Bombus mixtus", null, 1], ["Bombus mixtus", "cf.", 1]]),
    );
  });

  it("leaves out what is not a bee, and counts no species for aff. or nr.", async () => {
    const { db, conn, ada, spec, expert } = await fixture();
    await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Vespidae')`);
    await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) VALUES ('genus', 'Vespula', (SELECT entity_id FROM animal WHERE scientific_name = 'Vespidae'))`);
    await expert(await spec("26000101"), "Vespula", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(await spec("26000102"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    await conn.run(`UPDATE determination SET qualifier = 'aff.' WHERE specimen_id = ${await spec("26000102")}`);
    const found = await taxaFound(db, ada);
    expect([found.collected, found.identified, found.notBees, found.families, found.genera, found.species]).toEqual([4, 1, 1, 1, 1, 0]);
    expect(found.byFamily.map((f) => f.name)).toEqual(["Apidae"]);
  });

  it("lists, beside the person's, what others in their atlas have found and they have not", async () => {
    const { db, conn, ada, spec, expert, adas } = await fixture();
    await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Megachilidae')`);
    await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) VALUES ('genus', 'Osmia', (SELECT entity_id FROM animal WHERE scientific_name = 'Megachilidae'))`);
    await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) VALUES ('species', 'Osmia lignaria', (SELECT entity_id FROM animal WHERE scientific_name = 'Osmia'))`);
    const bos = await one(conn, `SELECT sample_id FROM specimen WHERE field_number = '26000301'`);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${bos}, 2, '26000302'), (${bos}, 3, '26000303')`);
    const oba = `(SELECT entity_id FROM program WHERE code = 'OBA')`;
    await conn.run(`INSERT INTO sample_atlas (sample_id, atlas_id) VALUES (${adas}, ${oba}), (${bos}, ${oba})`);
    await expert(await spec("26000101"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    // Bo's: one species Ada has, one of her genus she has not, and one of a family she has none of.
    await expert(await spec("26000301"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(await spec("26000302"), "Bombus vosnesenskii", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(await spec("26000303"), "Osmia lignaria", "legacy_import", "2026-11-03 22:25:00Z");
    const found = await taxaFound(db, ada);
    expect(found.atlas).toEqual({ names: ["Oregon Bee Atlas"], families: 2, genera: 2, species: 3, yours: { families: 1, genera: 1, species: 1 } });
    expect([found.families, found.genera, found.species]).toEqual([1, 1, 1]);
    expect(found.byFamily.map((f) => [f.name, f.bees, f.genera.map((g) => [g.name, g.bees, g.byOthers.map((o) => [o.scientific_name, o.bees])])])).toEqual([
      ["Apidae", 1, [["Bombus", 1, [["Bombus vosnesenskii", 1]]]]],
      ["Megachilidae", 0, [["Osmia", 0, [["Osmia lignaria", 1]]]]],
    ]);
  });

  it("counts toward the atlas only what was collected in it, and places aff. in its genus but not its species", async () => {
    const { db, conn, ada, spec, expert, adas } = await fixture();
    const bos = await one(conn, `SELECT sample_id FROM specimen WHERE field_number = '26000301'`);
    const oba = `(SELECT entity_id FROM program WHERE code = 'OBA')`;
    // Ada's own sample is in the atlas; the one she shares with Bo is not.
    await conn.run(`INSERT INTO sample_atlas (sample_id, atlas_id) VALUES (${adas}, ${oba}), (${bos}, ${oba})`);
    await expert(await spec("26000101"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(await spec("26000201"), "Bombus caliginosus", "legacy_import", "2026-11-03 22:25:00Z");
    // The same species in and out of the atlas is one entry with both bees.
    await expert(await spec("26000102"), "Bombus caliginosus", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(await spec("26000301"), "Bombus vosnesenskii", "legacy_import", "2026-11-03 22:25:00Z");
    await conn.run(`UPDATE determination SET qualifier = 'aff.' WHERE specimen_id = ${await spec("26000301")}`);
    const found = await taxaFound(db, ada);
    // caliginosus was found both in and outside the atlas; vosnesenskii only as aff.
    expect(found.atlas).toEqual({ names: ["Oregon Bee Atlas"], families: 1, genera: 1, species: 2, yours: { families: 1, genera: 1, species: 2 } });
    expect(found.species).toBe(2);
    expect(found.byFamily[0]!.genera[0]!.species.map((x) => [x.scientific_name, x.bees])).toEqual([["Bombus caliginosus", 2], ["Bombus mixtus", 1]]);
    expect(found.byFamily[0]!.genera[0]!.byOthers).toEqual([]);
  });

  it("shows a family others named only to family as a row of its own", async () => {
    const { db, conn, ada, spec, expert, adas } = await fixture();
    await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Megachilidae')`);
    const bos = await one(conn, `SELECT sample_id FROM specimen WHERE field_number = '26000301'`);
    const oba = `(SELECT entity_id FROM program WHERE code = 'OBA')`;
    await conn.run(`INSERT INTO sample_atlas (sample_id, atlas_id) VALUES (${adas}, ${oba}), (${bos}, ${oba})`);
    await expert(await spec("26000101"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(await spec("26000301"), "Megachilidae", "legacy_import", "2026-11-03 22:25:00Z");
    const found = await taxaFound(db, ada);
    expect(found.byFamily.map((f) => [f.name, f.bees, f.genera.length])).toEqual([["Apidae", 1, 1], ["Megachilidae", 0, 0]]);
    expect(found.atlas?.families).toBe(2);
  });

  it("says what the atlas has to a person with nothing identified, and counts bycatch with no table", async () => {
    const f = await fixture();
    const { conn, spec, expert, adas } = f;
    await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('family', 'Vespidae')`);
    const bos = await one(conn, `SELECT sample_id FROM specimen WHERE field_number = '26000301'`);
    const oba = `(SELECT entity_id FROM program WHERE code = 'OBA')`;
    await conn.run(`INSERT INTO sample_atlas (sample_id, atlas_id) VALUES (${adas}, ${oba}), (${bos}, ${oba})`);
    await expert(await spec("26000101"), "Vespidae", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(await spec("26000301"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    const unusedInat: InatClient = {
      authorizeUrl: () => "unused",
      exchangeCode: () => Promise.reject(new Error("not under test")),
      identity: () => Promise.reject(new Error("not under test")),
    };
    const app = createApp({
      ...(await scratchPaths()),
      db: f.db,
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId: f.ada, login: "ada", iconUrl: null }),
    });
    const html = await (await app.request("/bees/taxa")).text();
    expect(html).toContain(en.yourBees.found.atlasHas(1, 1, 1, ["Oregon Bee Atlas"]));
    expect(html).toContain(en.yourBees.found.notBees(1));
  });

  it("is a tab of Your bees, and each tab marks itself as the current page", async () => {
    const f = await fixture();
    await f.expert(await f.spec("26000101"), "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 17:00:00" });
    const unusedInat: InatClient = {
      authorizeUrl: () => "unused",
      exchangeCode: () => Promise.reject(new Error("not under test")),
      identity: () => Promise.reject(new Error("not under test")),
    };
    const app = createApp({
      ...(await scratchPaths()),
      db: f.db,
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId: f.ada, login: "ada", iconUrl: null }),
    });
    const taxa = await (await app.request("/bees/taxa")).text();
    expect(taxa).toContain(en.yourBees.found.summary(1, 1, 1, 1));
    expect(taxa).toMatch(/<a href="\/bees\/taxa" aria-current="page">/);
    const bees = await (await app.request("/bees")).text();
    expect(bees).toMatch(/<a href="\/bees" aria-current="page">/);
    expect(bees).toContain('href="/bees/taxa"');
  });
});
