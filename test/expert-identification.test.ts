import { describe, expect, it } from "vitest";
import { createKysely } from "../src/db.js";
import { latestIdentifications } from "../src/app/dashboard.js";
import { createApp } from "../src/app/server.js";
import type { InatClient } from "../src/app/auth.js";
import { en } from "../src/app/messages/en.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";

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
    expect(await stretches(conn, s)).toEqual([[1n, "Bombus vosnesenskii", null, "L. Best", "2026-08-12T15:00:00Z", true]]);
  });

  it("makes a changed name a new identification that remembers the old one", async () => {
    const { conn, spec, expert } = await fixture();
    const s = await spec("26000102");
    await expert(s, "Bombus caliginosus", "ecdysis_import", "2026-06-02 08:00:00Z", { enteredAt: "2026-06-02 08:00:00" });
    await expert(s, "Bombus vosnesenskii", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 09:30:00" });
    // And back again: a name returning is a change too, not the first stretch resuming.
    await expert(s, "Bombus caliginosus", "ecdysis_import", "2026-11-10 11:00:00Z", { enteredAt: "2026-11-09 16:00:00" });
    expect((await stretches(conn, s)).map((r) => [r[0], r[1], r[2], r[5]])).toEqual([
      [1n, "Bombus caliginosus", null, false],
      [2n, "Bombus vosnesenskii", "Bombus caliginosus", false],
      [3n, "Bombus caliginosus", "Bombus vosnesenskii", true],
    ]);
  });

  it("leaves a name only the old Beeline held undated, since it kept no dates", async () => {
    const { conn, spec, expert } = await fixture();
    const s = await spec("26000103");
    await expert(s, "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    expect(await stretches(conn, s)).toEqual([[1n, "Bombus mixtus", null, null, null, true]]);
  });

  it("dates a sheet by the day it states, at noon UTC, and by when it was sent when it states only a year", async () => {
    const { conn, spec, expert } = await fixture();
    const a = await spec("26000101");
    const b = await spec("26000102");
    await expert(a, "Bombus mixtus", "worksheet_import", "2026-11-10 00:34:00Z", { on: "2026-03-05", sentAt: "2026-11-09 18:00:00Z" });
    await expert(b, "Bombus mixtus", "worksheet_import", "2026-11-10 00:34:00Z", { on: "2025-01-01", precision: "year", sentAt: "2026-11-09 18:00:00Z" });
    expect((await stretches(conn, a))[0]![4]).toEqual("2026-03-05T12:00:00Z");
    expect((await stretches(conn, b))[0]![4]).toEqual("2026-11-09T18:00:00Z");
  });

  it("ignores volunteers' determinations, which are not news to the volunteer", async () => {
    const { conn, spec, animal, ada } = await fixture();
    const s = await spec("26000101");
    await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, verbatim_identification, determiner_id, recorded_at)
                    VALUES (${s}, ${await animal("Bombus")}, false, 'in_app', 'Bombus', ${ada}, TIMESTAMPTZ '2026-08-01 10:00:00Z')`);
    expect(await stretches(conn, s)).toEqual([]);
  });
});

describe("the front page's latest identifications", () => {
  async function populated() {
    const f = await fixture();
    const { spec, expert, lin, conn } = f;
    // Ada's: one named in August, one revised in October, one only the old
    // Beeline knows, and one with no field number, named by Lin in Beeline.
    await expert(await spec("26000101"), "Bombus vosnesenskii", "legacy_import", "2026-11-03 22:25:00Z");
    await expert(await spec("26000101"), "Bombus vosnesenskii", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-08-12 15:00:00", byName: "L. Best" });
    await expert(await spec("26000102"), "Bombus caliginosus", "ecdysis_import", "2026-06-02 08:00:00Z", { enteredAt: "2026-06-02 08:00:00", byName: "L. Best" });
    await expert(await spec("26000102"), "Bombus vosnesenskii", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-10-20 09:30:00", byName: "L. Best" });
    await expert(await spec("26000103"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z");
    const unnumbered = await one(conn, `SELECT entity_id FROM specimen WHERE field_number IS NULL`);
    await expert(unnumbered, "Bombus mixtus", "in_app", "2026-09-01 17:00:00Z", { by: lin });
    // The shared sample's, and Bo's own, which is not Ada's business.
    await expert(await spec("26000201"), "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-07-01 12:00:00" });
    await expert(await spec("26000301"), "Bombus mixtus", "ecdysis_import", "2026-11-04 11:00:00Z", { enteredAt: "2026-11-01 12:00:00" });
    return { ...f, unnumbered };
  }

  it("lists the person's, a second collector's included, newest identified first, and none only the old Beeline dated", async () => {
    const { db, ada } = await populated();
    for (const inlineLimit of [2_000, 0]) {
      const got = await latestIdentifications(db, ada, 10, inlineLimit);
      expect(got.map((i) => [i.field_number, i.scientific_name, i.previous?.scientific_name ?? null, i.superseded])).toEqual([
        ["26000102", "Bombus vosnesenskii", "Bombus caliginosus", false],
        [null, "Bombus mixtus", null, false],
        ["26000101", "Bombus vosnesenskii", null, false],
        ["26000201", "Bombus mixtus", null, false],
        ["26000102", "Bombus caliginosus", null, true],
      ]);
    }
  });

  it("names the determiner Beeline knows, else as written, and stops at the limit", async () => {
    const { db, ada } = await populated();
    const got = await latestIdentifications(db, ada, 2);
    expect(got.map((i) => i.determiner)).toEqual(["L. Best", "Lin Lee"]);
  });

  it("still lists an old Beeline name that states the day it was given", async () => {
    const { db, ada, spec, expert } = await fixture();
    await expert(await spec("26000103"), "Bombus mixtus", "legacy_import", "2026-11-03 22:25:00Z", { on: "2025-07-01" });
    const got = await latestIdentifications(db, ada);
    expect(got.map((i) => [i.field_number, i.identified_at.toISOString()])).toEqual([["26000103", "2025-07-01T12:00:00.000Z"]]);
  });

  it("is empty for a person with no specimens", async () => {
    const { db, lin } = await populated();
    expect(await latestIdentifications(db, lin)).toEqual([]);
  });

  it("is on the front page, with the name it replaced", async () => {
    const f = await populated();
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
    const html = await (await app.request("/")).text();
    const section = html.slice(html.indexOf(en.qc.identifications.heading));
    expect(section).toContain(en.qc.identifications.heading);
    expect(section).toContain("26000102");
    expect(section).toContain(en.qc.identifications.previously);
    expect(section).toContain(en.qc.identifications.specimen("1", 4));
    expect(section).not.toContain("26000301");
  });
});
