import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { en } from "../src/app/messages/en.js";
import { createApp } from "../src/app/server.js";
import type { InatClient } from "../src/app/auth.js";
import { heldBackRecords, type HeldBack } from "../src/app/held-back.js";
import { createKysely } from "../src/db.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { repairSkippedLegacyRecords } from "../src/repair-legacy-skipped.js";
import { createMemoryDb, FIXTURE_INPUTS, insertCleanSample, scratchPaths } from "./helpers.js";

/**
 * The page of old-Beeline records new Beeline held back (beeline-cel0), over
 * the records test/repair-legacy-skipped.test.ts describes one by one, after
 * promotion and the repair have run on them as they did on production. Two
 * records with nothing but a field number are added, as the old system's
 * empty labels 25100000 onward are on production.
 */
const FIXTURE = new URL("./fixtures/legacy-skipped.jsonl", import.meta.url).pathname;

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

let conn: DuckDBConnection;
let app: ReturnType<typeof createApp>;
let signedIn: { personId: number; login: string };
let staff: number;
let volunteer: number;
let held: HeldBack;

const byField = (n: string) => held.records.find((r) => r.fieldNumber === n);

beforeAll(async () => {
  const created = await createMemoryDb();
  conn = created.conn;
  // The fixture, and two empty labels sharing one field number.
  const lines = (await readFile(FIXTURE, "utf8")).split("\n").filter((l) => l.trim() !== "");
  const blank = Object.fromEntries(Object.keys(JSON.parse(lines[0]!)).map((k) => [k, ""]));
  const bare = ["bare1", "bare2"].map((id) => JSON.stringify({ ...blank, _id: id, fieldNumber: "25100000" }));
  const staged = join(await mkdtemp(join(tmpdir(), "beeline-held-back-")), "legacy.jsonl");
  await writeFile(staged, [...lines, ...bare].join("\n") + "\n");
  await loadLegacyStaging(conn, staged);
  await promoteLegacy(conn, FIXTURE_INPUTS);
  // As in the repair's own test: the samples the nightly sync made from observations.
  for (const [number, observation, count] of [["'02viii20.1'", "56359335", null], ["'3'", "56370000", "1"]] as const) {
    await insertCleanSample(conn, {
      sample_number: number,
      inat_observation_id: observation,
      ...(count === null ? {} : { specimen_count: count }),
      collector_id: "(SELECT entity_id FROM person WHERE display_name = 'Cleo Cortez')",
    });
  }
  await conn.run(
    `INSERT INTO observation_field (inat_id, collection_method_raw, specimen_count_raw)
     VALUES (56390000, 'pan trap', '1'), (56391000, 'net', '1'), (56392000, 'pan trap', '2'), (56393000, 'pan trap', '2')`,
  );
  await repairSkippedLegacyRecords(conn);

  const [[s]] = (await (await conn.run(`INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)).getRows()) as [[number]];
  staff = s;
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);
  volunteer = ((await (await conn.run(`SELECT entity_id FROM person WHERE display_name = 'Cleo Cortez'`)).getRows()) as [[number]])[0][0];
  signedIn = { personId: staff, login: "staff" };
  const db = createKysely(created.instance);
  app = createApp({
    ...(await scratchPaths()),
    db,
    config: { environment: "sandbox" as const, origin: "http://localhost:3054", exportsDir: await mkdtemp(join(tmpdir(), "beeline-exports-")) },
    inat: unusedInat,
    resolveSession: async () => ({ ...signedIn, iconUrl: null }),
  });
  held = (await heldBackRecords(db))!;
});

describe("the old records new Beeline held back", () => {
  test("lists what promotion refused and the repair left out, and nothing Beeline holds", () => {
    // Left out by the repair, each for its own reason.
    expect(byField("2127399")?.rules).toEqual(["bad_specimen_number"]);
    expect(byField("2050001")?.rules).toEqual(["bad_specimen_number"]);
    // A pair the repair would not tie: the set-aside record, with the kept specimen's remark.
    expect(byField("2127010")).toMatchObject({
      rules: ["duplicate_specimen"],
      collector: "Cleo Cortez",
      sampleNumber: "7",
      date: "2021-6-10",
      expert: "Bombus vosnesenskii",
      related: { fieldNumber: "2127325", remark: expect.stringContaining("11.1 km apart") },
    });
    // A refused record the repair matched to a specimen but would not tie;
    // its remark names it with a comma after the number.
    expect(byField("Cleo_Cortez:20.008.002")?.related).toMatchObject({
      fieldNumber: "Cleo_Cortez:18.008.002",
      remark: expect.stringContaining("field number Cleo_Cortez:20.008.002, a record with details missing"),
    });
    // Kept, tied as a second print, placed, or tied as a second entry: none is held back.
    for (const n of ["2127319", "2127004", "Cleo_Cortez:18.008.004", "Cleo_Cortez:19.008.001", "2037759"]) expect(byField(n)).toBeUndefined();
  });

  test("counts the bare records rather than listing them, and splits the reasons by season", () => {
    expect(held.bare).toEqual({ records: 2, fieldNumbers: 1, first: "25100000", last: "25100000" });
    expect(held.records.some((r) => r.fieldNumber === "25100000")).toBe(false);
    // Every fixture record is from a settled season.
    const duplicates = held.reasons.find((r) => r.rule === "duplicate_specimen")!;
    expect(duplicates.active).toBe(0);
    expect(duplicates.settled).toBe(held.records.filter((r) => r.rules.includes("duplicate_specimen")).length);
  });

  test("shows staff the page and the download, linked from Exports", async () => {
    const exportsPage = await (await app.request("/exports")).text();
    expect(exportsPage).toContain(`href="/exports/held-back"`);
    const page = await (await app.request("/exports/held-back")).text();
    expect(page).toContain(en.heldBack.heading);
    expect(page).toContain(en.heldBack.reason.duplicate_specimen);
    expect(page).toContain("2127010");
    expect(page).toContain(`href="https://www.inaturalist.org/observations/`);
    expect(page).toContain(en.heldBack.bare(1, "25100000", "25100000", 2).replaceAll("'", "&#39;"));

    const res = await app.request("/exports/held-back.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const lines = (await res.text()).replace(/^﻿/, "").trim().split("\n");
    expect(lines[0]!.startsWith("_id,")).toBe(true);
    expect(lines[0]!.endsWith(",held_back_because")).toBe(true);
    // Every listed record and both bare ones.
    expect(lines.length - 1).toBe(held.records.length + 2);
    expect(lines.find((l) => l.includes(",2127010,"))).toMatch(/,duplicate_specimen$/);
  });

  test("is refused to a volunteer", async () => {
    signedIn = { personId: volunteer, login: "cleocortez" };
    try {
      expect((await app.request("/exports/held-back")).status).toBe(403);
      expect((await app.request("/exports/held-back.csv")).status).toBe(403);
    } finally {
      signedIn = { personId: staff, login: "staff" };
    }
  });
});

describe("a store without the old Beeline's records", () => {
  test("says it cannot tell, rather than failing", async () => {
    const { instance, conn: bare } = await createMemoryDb();
    const [[id]] = (await (await bare.run(`INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)).getRows()) as [[number]];
    await bare.run(`INSERT INTO person_admin (person_id) VALUES (${id})`);
    const empty = createApp({
      ...(await scratchPaths()),
      db: createKysely(instance),
      config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
      inat: unusedInat,
      resolveSession: async () => ({ personId: id, login: "staff", iconUrl: null }),
    });
    expect(await (await empty.request("/exports/held-back")).text()).toContain(en.heldBack.noStaging.replaceAll("'", "&#39;"));
    expect((await empty.request("/exports/held-back.csv")).status).toBe(404);
  });
});
