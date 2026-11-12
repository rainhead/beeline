import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import { beesByYear, classify, identificationBatches } from "../src/app/your-bees.js";
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
  it("counts Ecdysis repeating the old Beeline's name as one identification, dated and credited by Ecdysis", async () => {
    const { conn, spec, expert } = await fixture();
    const s = await spec("26000101");
    await expert(s, "Bombus vosnesenskii", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(s, "Bombus vosnesenskii", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-08-12 15:00:00", byName: "L. Best" });
    expect(await stretches(conn, s)).toEqual([[1, "Bombus vosnesenskii", null, "L. Best", "2026-08-12T15:00:00Z", true]]);
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
    // 20 Oct 2026 in Oregon: two identifications, one entered late in the
    // evening, which is already the 21st in UTC.
    await expert(await spec("26000101"), "Bombus vosnesenskii", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(await spec("26000101"), "Bombus vosnesenskii", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-21 06:30:00", byName: "L. Best" });
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
      const { batches, days, undated } = await identificationBatches(db, ada, Number.POSITIVE_INFINITY, inlineLimit);
      expect(days).toBe(3);
      expect(undated).toBe(1);
      // Ada's own genus of 1 July, read back from Ecdysis, is no batch of hers.
      expect(batches.map((b) => b.identified_at.toISOString())).toEqual(["2026-10-20T17:00:00.000Z", "2026-09-01T17:00:00.000Z", "2026-06-02T08:00:00.000Z"]);
      const [oct, sep, jun] = batches;
      expect(oct!.seasons).toEqual([{ season: CURRENT_SEASON, count: 3 }]);
      expect(oct!.kinds.map((k) => [k.kind, k.from, k.to, k.count, k.own])).toEqual(
        expect.arrayContaining([
          ["first", null, null, 1, 0],
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

  it("counts a bee renamed twice in a day once, and lists both names", async () => {
    const { db, ada, spec, expert } = await fixture();
    const s = await spec("26000101");
    await expert(s, "Bombus caliginosus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 17:00:00" });
    await expert(s, "Bombus vosnesenskii", "ecdysis_import", "2026-11-05 11:00:00Z", { enteredAt: "2026-10-20 18:00:00" });
    const [day] = (await identificationBatches(db, ada)).batches;
    expect(day!.seasons).toEqual([{ season: CURRENT_SEASON, count: 1 }]);
    expect(day!.kinds.map((k) => [k.kind, k.count])).toEqual(expect.arrayContaining([["first", 1], ["corrected", 1]]));
  });

  it("shows the newest days up to the limit, and still counts them all", async () => {
    const { db, ada } = await populated();
    const { batches, days } = await identificationBatches(db, ada, 1);
    expect(batches).toHaveLength(1);
    expect(days).toBe(3);
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
    expect(await identificationBatches(db, ada)).toEqual({ batches: [], days: 0, undated: 1 });
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
    expect(await identificationBatches(db, lin)).toEqual({ batches: [], days: 0, undated: 0 });
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

  it("puts the newest days on the front page and links to Your bees", async () => {
    const f = await fixture();
    await f.expert(await f.spec("26000102"), "Bombus caliginosus", "ecdysis_import", "2026-06-02 08:00:00Z", { enteredAt: "2026-06-02 08:00:00", byName: "L. Best" });
    await f.expert(await f.spec("26000102"), "Bombus vosnesenskii", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 17:00:00", byName: "L. Best" });
    const html = await (await (await app(f.ada, f.db)).request("/")).text();
    const section = html.slice(html.indexOf(en.qc.identifications.heading));
    expect(section).toContain(en.yourBees.batches.identified([en.yourBees.batches.ofSeason(1, CURRENT_SEASON)]));
    expect(section).toContain(en.yourBees.batches.kinds([en.yourBees.batches.kind.corrected(1)]));
    expect(section).toContain('href="/bees"');
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
