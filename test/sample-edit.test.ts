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
import { createMemoryDb, rows } from "./helpers.js";

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;
const TAXONOMY = new URL("./fixtures/taxonomy.csv", import.meta.url).pathname;
const CORRECTIONS = new URL("./fixtures/legacy-corrections.csv", import.meta.url).pathname;
const NO_REGISTER = new URL("./fixtures/no-usernames.csv", import.meta.url).pathname;

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

async function personId(conn: DuckDBConnection, name: string): Promise<number> {
  const [[id]] = (await rows(conn, `SELECT entity_id FROM person WHERE display_name = '${name}'`)) as [[number]];
  return Number(id);
}

async function sampleId(conn: DuckDBConnection, sampleNumber: string): Promise<number> {
  const [[id]] = (await rows(conn, `SELECT entity_id FROM sample WHERE sample_number = '${sampleNumber}'`)) as [
    [number],
  ];
  return Number(id);
}

/**
 * The full pipeline on the fixture, signed in as Bea Trapper — whose trap
 * sample OBAS-00657 has no iNat observation and both a locality_format
 * finding and a missing county.
 */
async function editApp(appCsv?: string) {
  const { instance, conn } = await createMemoryDb();
  await loadLegacyStaging(conn, FIXTURE);
  const correctionsPath = appCsv ?? join(await mkdtemp(join(tmpdir(), "beeline-edit-")), "corrections.csv");
  await promoteLegacy(
    conn,
    TAXONOMY,
    "ingest/determiner-aliases.csv",
    "ingest/determiner-register.csv",
    CORRECTIONS,
    correctionsPath,
    "ingest/person-overlay.csv",
    "data/person-overlay.csv",
    "ingest/collector-aliases.csv",
    NO_REGISTER, // never the developer's fetched data/legacy/usernames.csv
  );
  const bea = await personId(conn, "Bea Trapper");
  const beaSample = await sampleId(conn, "OBAS-00657");
  // The fixture collects in July 2025, which is a settled season by now, and
  // settled samples do not appear on the QC home (beeline-2c3.24). This test
  // is about the edit path, not about settling, so move Bea's sample into the
  // open season and leave the rest of the fixture where it is.
  await conn.run(`UPDATE sample SET date_start = current_date, date_end = current_date WHERE entity_id = ${beaSample}`);
  const db = createKysely(instance);
  const app = createApp({
    db,
    config: { environment: "development" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: bea, login: "trapline", iconUrl: null }),
    correctionsPath,
  });
  return { app, conn, db, correctionsPath, bea, beaSample, instance };
}

const post = async (
  app: { request: (p: string, init?: RequestInit) => Promise<Response> | Response },
  path: string,
  body: Record<string, string>,
) => app.request(path, { method: "POST", body: new URLSearchParams(body) });

describe("in-app editing of non-iNat samples", () => {
  it("offers the edit form from the QC home, prefilled with current values", async () => {
    const { app, beaSample } = await editApp();
    const home = await (await app.request("/")).text();
    expect(home).toContain(`/samples/${beaSample}/edit`);
    expect(home).toContain("Edit this sample");

    const form = await (await app.request(`/samples/${beaSample}/edit`)).text();
    expect(form).toContain("Edit sample OBAS-00657");
    expect(form).toContain("5th St, Walla Walla vicinity");
    expect(form).toContain("6 Vane Traps");
  });

  it("refuses samples that are not yours or that iNaturalist backs", async () => {
    const { app, conn } = await editApp();
    // Ada's sample 1 is iNat-backed; and it is not Bea's either way.
    const adaSample = await sampleId(conn, "1");
    expect((await app.request(`/samples/${adaSample}/edit`)).status).toBe(404);
    expect((await post(app, `/samples/${adaSample}/edit`, { locality: "Nope" })).status).toBe(404);
  });

  it("saves: the sample row updates, findings clear, and events land in the store", async () => {
    const { app, conn, beaSample, correctionsPath } = await editApp();
    const before = await rows(
      conn,
      `SELECT rule_name FROM qc_finding WHERE sample_id = ${beaSample} AND rule_name = 'locality_format'`,
    );
    expect(before).toHaveLength(1);

    const res = await post(app, `/samples/${beaSample}/edit`, {
      locality: "Walla Walla",
      country: "USA",
      state_province: "WA",
      county: "WallaWallaCo",
      protocol: "6 Vane Traps",
      note: "trap site is in town",
    });
    expect(res.status).toBe(302);

    const [[locality, county]] = (await rows(
      conn,
      `SELECT locality, county FROM sample WHERE entity_id = ${beaSample}`,
    )) as [[string, string]];
    expect(locality).toBe("Walla Walla");
    expect(county).toBe("WallaWallaCo");
    expect(
      await rows(conn, `SELECT 1 FROM qc_finding WHERE sample_id = ${beaSample} AND rule_name = 'locality_format'`),
    ).toHaveLength(0);

    const records = parseCsv(await readFile(correctionsPath, "utf8")).slice(1);
    const localityEvent = records.find((r) => r[0] === "bbbb2222" && r[1] === "locality");
    expect(localityEvent).toEqual([
      "bbbb2222",
      "locality",
      "5th St, Walla Walla vicinity",
      "Walla Walla",
      "trapline",
      "trap site is in town",
    ]);
    expect(records.find((r) => r[0] === "bbbb2222" && r[1] === "county")?.[3]).toBe("WallaWallaCo");
    // Unchanged fields write no events.
    expect(records.find((r) => r[1] === "samplingProtocol")).toBeUndefined();
    expect(records.find((r) => r[1] === "country")).toBeUndefined();
  });

  it("a second edit replaces the field's event instead of stacking a duplicate", async () => {
    const { app, beaSample, correctionsPath } = await editApp();
    await post(app, `/samples/${beaSample}/edit`, { locality: "Walla Walla" });
    await post(app, `/samples/${beaSample}/edit`, { locality: "College Place" });
    const records = parseCsv(await readFile(correctionsPath, "utf8")).slice(1);
    const localityEvents = records.filter((r) => r[0] === "bbbb2222" && r[1] === "locality");
    expect(localityEvents).toHaveLength(1);
    expect(localityEvents[0]?.[3]).toBe("College Place");
  });

  it("reverting to the staged value writes the identity event, so rebuilds keep the revert", async () => {
    const { app, beaSample, correctionsPath } = await editApp();
    await post(app, `/samples/${beaSample}/edit`, { locality: "Walla Walla" });
    await post(app, `/samples/${beaSample}/edit`, { locality: "5th St, Walla Walla vicinity" });

    // The stale X→Z row is replaced by X→X, which the merge retires.
    const records = parseCsv(await readFile(correctionsPath, "utf8")).slice(1);
    const localityEvents = records.filter((r) => r[0] === "bbbb2222" && r[1] === "locality");
    expect(localityEvents).toEqual([
      ["bbbb2222", "locality", "5th St, Walla Walla vicinity", "5th St, Walla Walla vicinity", "trapline", "edited in Beeline"],
    ]);

    const { conn: conn2 } = await createMemoryDb();
    await loadLegacyStaging(conn2, FIXTURE);
    await promoteLegacy(
      conn2,
      TAXONOMY,
      "ingest/determiner-aliases.csv",
      "ingest/determiner-register.csv",
      CORRECTIONS,
      correctionsPath,
      "ingest/person-overlay.csv",
      "data/person-overlay.csv",
      "ingest/collector-aliases.csv",
      NO_REGISTER, // never the developer's fetched data/legacy/usernames.csv
    );
    const [[locality]] = (await rows(
      conn2,
      `SELECT locality FROM sample WHERE sample_number = 'OBAS-00657'`,
    )) as [[string]];
    expect(locality).toBe("5th St, Walla Walla vicinity");
  });

  it("a stale tab's untouched prefills do not revert a newer save", async () => {
    const { app, conn, beaSample } = await editApp();
    // Both tabs rendered the same form; tab A saves a locality fix first.
    const rendered = { "base:locality": "5th St, Walla Walla vicinity", "base:county": "" };
    await post(app, `/samples/${beaSample}/edit`, { ...rendered, locality: "Walla Walla" });
    // Tab B, unaware, submits its stale locality prefill plus a county edit.
    await post(app, `/samples/${beaSample}/edit`, {
      ...rendered,
      locality: "5th St, Walla Walla vicinity",
      county: "WallaWallaCo",
    });

    const [[locality, county]] = (await rows(
      conn,
      `SELECT locality, county FROM sample WHERE entity_id = ${beaSample}`,
    )) as [[string, string]];
    expect(locality).toBe("Walla Walla"); // tab A's save survives
    expect(county).toBe("WallaWallaCo"); // tab B's deliberate edit lands
  });

  it("settles a stored within-sample disagreement for the edited field only", async () => {
    const { app, conn, beaSample } = await editApp();
    await conn.run(
      `INSERT INTO sample_promotion_finding (sample_id, rule_name, details) VALUES
       (${beaSample}, 'within_sample_disagreement', 'county: A | B'),
       (${beaSample}, 'within_sample_disagreement', 'protocol: vane trap | 6 Vane Traps')`,
    );
    await post(app, `/samples/${beaSample}/edit`, { county: "WallaWallaCo" });
    const remaining = await rows(
      conn,
      `SELECT details FROM sample_promotion_finding
       WHERE sample_id = ${beaSample} AND rule_name = 'within_sample_disagreement'`,
    );
    expect(remaining).toEqual([["protocol: vane trap | 6 Vane Traps"]]);
  });

  it("an edit with nothing changed writes nothing", async () => {
    const { app, beaSample, correctionsPath } = await editApp();
    await post(app, `/samples/${beaSample}/edit`, {
      locality: "5th St, Walla Walla vicinity",
      country: "USA",
      state_province: "WA",
      county: "",
      protocol: "6 Vane Traps",
    });
    const records = parseCsv(await readFile(correctionsPath, "utf8")).slice(1);
    expect(records).toHaveLength(0);
  });

  it("edits survive the blow-away rebuild: a fresh promote re-derives them", async () => {
    const { app, beaSample, correctionsPath } = await editApp();
    await post(app, `/samples/${beaSample}/edit`, { locality: "Walla Walla", county: "WallaWallaCo" });

    // Blow away: new database, same staging, same correction files.
    const { conn: conn2 } = await createMemoryDb();
    await loadLegacyStaging(conn2, FIXTURE);
    await promoteLegacy(
      conn2,
      TAXONOMY,
      "ingest/determiner-aliases.csv",
      "ingest/determiner-register.csv",
      CORRECTIONS,
      correctionsPath,
      "ingest/person-overlay.csv",
      "data/person-overlay.csv",
      "ingest/collector-aliases.csv",
      NO_REGISTER, // never the developer's fetched data/legacy/usernames.csv
    );
    const [[locality, county]] = (await rows(
      conn2,
      `SELECT locality, county FROM sample WHERE sample_number = 'OBAS-00657'`,
    )) as [[string, string]];
    expect(locality).toBe("Walla Walla");
    expect(county).toBe("WallaWallaCo");
    // The git CSV's latitude correction (a different field) still applies.
    const [[latitude]] = (await rows(
      conn2,
      `SELECT loc.latitude FROM sample_location loc
       JOIN sample s ON s.entity_id = loc.sample_id WHERE s.sample_number = 'OBAS-00657'`,
    )) as [[unknown]];
    expect(latitude).toBe(46.1111);
  });
});
