import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, test, vi } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import { applySampleOverlay } from "../src/apply-sample-overlay.js";
import { readInatTaxon, type InatTaxonAnswer } from "../src/fetch-inat-taxa.js";
import { promoteObservations } from "../src/promote-observations.js";
import { canonicalJson } from "../src/sync-inat.js";
import { readSampleChanges, recordSampleChanges } from "../src/sample-change.js";
import { duckdbReader } from "../src/person-change.js";
import {
  formatHost,
  hostRowProblem,
  parseHost,
  parseSampleOverlay,
  readSampleOverlay,
  sampleValueProblem,
  upsertSampleOverlay,
  type SampleOverlayRow,
} from "../src/sample-overlay.js";
import { parseTaxonRef, judgeHostTaxon, type HostTaxonReader } from "../src/app/host-override.js";
import { hostProblemFor } from "../src/app/correction-reasons.js";
import { setHost, type Actor, type CorrectionDeps, type StaffHostFormInput } from "../src/app/sample-corrections.js";
import { en } from "../src/app/messages/en.js";
import { createMemoryDb, currentSeasonDate, insertCleanSample, rows, scratchPaths } from "./helpers.js";
import { promotedStore } from "./promoted-store.js";

/**
 * A floral host staff set, standing over the observation's (beeline-hlay):
 * the overlay's grammar, what the applier writes, what promotion does to a
 * sample that has one, the QC rule that reads it, and the correction's own
 * refusals. Nothing here calls iNaturalist: the single-taxon read is a fake.
 */

const TRACHEOPHYTA = 211194;
const eriophyllum: InatTaxonAnswer = {
  id: 53439, name: "Eriophyllum lanatum", rank: "species", isActive: true,
  ancestorIds: [48460, 47126, TRACHEOPHYTA, 47604, 53438], replacedBy: [],
};
const rubus: InatTaxonAnswer = {
  id: 47604, name: "Rubus", rank: "genus", isActive: true, ancestorIds: [48460, 47126, TRACHEOPHYTA], replacedBy: [],
};
const bee: InatTaxonAnswer = {
  id: 47219, name: "Apis mellifera", rank: "species", isActive: true, ancestorIds: [48460, 1, 47120, 47158], replacedBy: [],
};
const retired: InatTaxonAnswer = {
  id: 60000, name: "Old name", rank: "species", isActive: false, ancestorIds: [], replacedBy: [53439, 777],
};
const taxa: Record<number, InatTaxonAnswer> = { 53439: eriophyllum, 47604: rubus, 47219: bee, 60000: retired };

/** The injected read: ids not listed are unknown to iNaturalist, and 1 is an iNaturalist that cannot be reached. */
const fakeReader = () =>
  vi.fn<HostTaxonReader>(async (id) => {
    if (id === 1) throw new Error("iNaturalist is down");
    return taxa[id] ?? null;
  });

describe("the overlay's host grammar", () => {
  it("writes and reads `<id> <rank> <name>`, the name being the rest of the line", () => {
    expect(parseHost("53439 species Eriophyllum lanatum")).toEqual({ inat_taxon_id: 53439, rank: "species", name: "Eriophyllum lanatum" });
    expect(formatHost({ inat_taxon_id: 53439, rank: "species", name: "Eriophyllum lanatum" })).toBe("53439 species Eriophyllum lanatum");
    // A hybrid's sign and an infraspecific marker are part of the name.
    expect(parseHost("1 species Mentha × piperita")).toMatchObject({ name: "Mentha × piperita" });
  });

  it("writes `-` for a rank or name it cannot carry, so a base always reads back", () => {
    expect(formatHost({ inat_taxon_id: 47604, rank: "", name: null })).toBe("47604 - -");
    expect(formatHost({ inat_taxon_id: 47604, rank: "sub species", name: "  " })).toBe("47604 - -");
    expect(formatHost({ inat_taxon_id: null, rank: "", name: "" })).toBe("");
    expect(parseHost("47604 - -", true)).toEqual({ inat_taxon_id: 47604, rank: null, name: null });
    expect(hostRowProblem("53439 species Eriophyllum lanatum", "47604 - -")).toBeNull();
    expect(hostRowProblem("53439 species ", "")).not.toBeNull();
    expect(hostRowProblem("none", "garbage")).toMatch(/base/);
  });

  it("refuses a value that is not a taxon id, a rank and a name, and accepts `none` and an empty value", () => {
    expect(sampleValueProblem("host", "none")).toBeNull();
    expect(sampleValueProblem("host", "")).toBeNull();
    expect(sampleValueProblem("host", "53439 species Eriophyllum lanatum")).toBeNull();
    for (const bad of ["Eriophyllum lanatum", "53439", "53439 species", "- species Eriophyllum", "x1 species Eriophyllum"]) {
      expect(sampleValueProblem("host", bad), bad).not.toBeNull();
    }
  });

  it("allows any part of a base to be unknown, written `-`, and all of it to be empty", () => {
    expect(parseHost("- species Eriophyllum lanatum", true)).toEqual({ inat_taxon_id: null, rank: "species", name: "Eriophyllum lanatum" });
    expect(parseHost("47604 - Rubus", true)).toEqual({ inat_taxon_id: 47604, rank: null, name: "Rubus" });
    expect(formatHost({ inat_taxon_id: null, rank: "species", name: "Eriophyllum lanatum" })).toBe("- species Eriophyllum lanatum");
    expect(formatHost({ inat_taxon_id: null, rank: null, name: null })).toBe("");
  });

  it("is checked when the file is read: a host row with a bad value or base stops the read, as the other fields' do", () => {
    const header = "sample_ref,field,base_value,value,author,reason\n";
    expect(parseSampleOverlay(`${header}inat:1,host,47604 genus Rubus,53439 species Eriophyllum lanatum,sam,wrong plant\ninat:2,host,,none,sam,a trap\n`, "f")).toHaveLength(2);
    expect(parseSampleOverlay(`${header}legacy:abc,host,,none,sam,because\n`, "f")).toHaveLength(1);
    expect(() => parseSampleOverlay(`${header}inat:1,host,,Eriophyllum,sam,x\n`, "f")).toThrow(/floral host is/);
    expect(() => parseSampleOverlay(`${header}inat:1,host,garbage,none,sam,x\n`, "f")).toThrow(/base/);
  });
});

describe("the taxon a staff member gives", () => {
  it("is read from a taxon page address or a number, and from nothing else", () => {
    expect(parseTaxonRef("53439")).toBe(53439);
    expect(parseTaxonRef(" https://www.inaturalist.org/taxa/53439-Eriophyllum-lanatum ")).toBe(53439);
    expect(parseTaxonRef("https://www.inaturalist.org/taxa/53439")).toBe(53439);
    expect(parseTaxonRef("http://inaturalist.org/taxa/53439-Eriophyllum-lanatum?locale=en")).toBe(53439);
    for (const bad of ["Eriophyllum lanatum", "", "0", "-5", "12345678901", "https://www.inaturalist.org/observations/53439", "https://example.org/taxa/53439", "53439 species"]) {
      expect(parseTaxonRef(bad), bad).toBeNull();
    }
  });

  it("is judged by iNaturalist's answer: a vascular plant that is active, and nothing else", async () => {
    const { instance, conn } = await createMemoryDb();
    const db = createKysely(instance);
    const read = fakeReader();
    expect(await judgeHostTaxon(db, read, 53439)).toEqual({ ok: true, taxon: { id: 53439, name: "Eriophyllum lanatum", rank: "species" } });
    expect(await judgeHostTaxon(db, read, 47219)).toEqual({ ok: false, problem: "not_vascular" });
    expect(await judgeHostTaxon(db, read, 424242)).toEqual({ ok: false, problem: "unknown" });
    // Replacements are named from the cache where it has them, else by id.
    await conn.run(`INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active) VALUES (53439, 'Eriophyllum lanatum', 'species', 10, true)`);
    expect(await judgeHostTaxon(db, read, 60000)).toEqual({ ok: false, problem: "inactive", replacedBy: ["Eriophyllum lanatum", "taxon 777"] });
    expect(await judgeHostTaxon(db, read, 1)).toEqual({ ok: false, problem: "unreachable" });
  });

  it("is taken from the cache, without asking iNaturalist, when the cache holds it active and with Tracheophyta in its lineage", async () => {
    const { instance, conn } = await createMemoryDb();
    await conn.run(`INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active) VALUES (53439, 'Eriophyllum lanatum', 'species', 10, true)`);
    for (const [a, depth] of [[53439, 0], [211194, 3]]) await conn.run(`INSERT INTO inat_taxon_ancestor VALUES (53439, ${a}, ${depth})`);
    const read = fakeReader();
    expect(await judgeHostTaxon(createKysely(instance), read, 53439)).toEqual({
      ok: true,
      taxon: { id: 53439, name: "Eriophyllum lanatum", rank: "species" },
    });
    expect(read).not.toHaveBeenCalled();
    // A cached taxon with a recorded absence is asked about again, whatever the cache says of its lineage.
    await conn.run(`INSERT INTO inat_taxon_absent (inat_taxon_id) VALUES (53439)`);
    expect(await judgeHostTaxon(createKysely(instance), read, 53439)).toMatchObject({ ok: true });
    expect(read).toHaveBeenCalledTimes(1);
    await conn.run(`DELETE FROM inat_taxon_absent`);
    read.mockClear();
    // A cached taxon that is not vascular is asked about again: the cache may be old.
    await conn.run(`INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active) VALUES (47219, 'Apis mellifera', 'species', 10, true)`);
    await conn.run(`INSERT INTO inat_taxon_ancestor VALUES (47219, 47219, 0)`);
    expect(await judgeHostTaxon(createKysely(instance), read, 47219)).toEqual({ ok: false, problem: "not_vascular" });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("reading one taxon from iNaturalist", () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }) as Response);

  it("asks the v2 address the nightly step does, for that one id, and reads the lineage and replacements", async () => {
    const fetchImpl = answer(200, {
      results: [{ id: 60000, name: "Old name", rank: "species", is_active: false, ancestor_ids: [48460, 211194], current_synonymous_taxon_ids: [53439, 53439] }],
    });
    expect(await readInatTaxon(60000, { fetchImpl })).toEqual({
      id: 60000, name: "Old name", rank: "species", isActive: false, ancestorIds: [48460, 211194], replacedBy: [53439],
    });
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("https://api.inaturalist.org/v2/taxa/60000?");
    expect(url).toContain("ancestor_ids");
  });

  it("refuses an answer whose name is blank or whose rank is empty or has a space in it", async () => {
    const one = (name: string, rank: string) => answer(200, { results: [{ id: 5, name, rank, is_active: true, ancestor_ids: [] }] });
    await expect(readInatTaxon(5, { fetchImpl: one("   ", "species") })).rejects.toThrow(/usable name or rank/);
    await expect(readInatTaxon(5, { fetchImpl: one("", "species") })).rejects.toThrow(/usable name or rank/);
    await expect(readInatTaxon(5, { fetchImpl: one("Rubus", "sub species") })).rejects.toThrow(/usable name or rank/);
    await expect(readInatTaxon(5, { fetchImpl: one("Rubus", "") })).rejects.toThrow(/usable name or rank/);
    expect(await readInatTaxon(5, { fetchImpl: one("Rubus", "genus") })).toMatchObject({ name: "Rubus", rank: "genus" });
  });

  it("answers null for a taxon iNaturalist does not have, and throws for anything that is not an answer", async () => {
    expect(await readInatTaxon(1, { fetchImpl: answer(404, { results: [] }) })).toBeNull();
    expect(await readInatTaxon(1, { fetchImpl: answer(200, { results: [] }) })).toBeNull();
    await expect(readInatTaxon(1, { fetchImpl: answer(500, {}) })).rejects.toThrow(/500/);
    await expect(readInatTaxon(1, { fetchImpl: answer(200, { nope: true }) })).rejects.toThrow(/results/);
    await expect(readInatTaxon(1, { fetchImpl: vi.fn(async () => Promise.reject(new Error("offline"))) })).rejects.toThrow(/offline/);
  });
});

// --- the store -------------------------------------------------------------------------------

let conn: DuckDBConnection;
let overlayPath: string;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector'), ('Sam Staff')");
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login)
     SELECT entity_id, 100, 'adacollects' FROM person WHERE display_name = 'Ada Collector'`,
  );
  await conn.run(
    `INSERT INTO inat_account (person_id, inat_user_id, login)
     SELECT entity_id, 200, 'samstaff' FROM person WHERE display_name = 'Sam Staff'`,
  );
  for (const [id, name, level] of [[1, "United States", 0], [10, "Oregon", 10], [484, "Benton", 20]] as const) {
    await conn.run(`INSERT INTO inat_place (inat_place_id, name, admin_level) VALUES (${id}, '${name}', ${level})`);
  }
  overlayPath = join(await mkdtemp(join(tmpdir(), "beeline-host-overlay-")), "sample-overlay.csv");
});

const RUBUS = { id: 47604, name: "Rubus", rank: "genus", ancestor_ids: [48460, 47126, TRACHEOPHYTA, 47604] };
const ERIOPHYLLUM = { id: 53439, name: "Eriophyllum lanatum", rank: "species", ancestor_ids: [48460, 47126, TRACHEOPHYTA, 53439] };
const ERICAMERIA = { id: 99999, name: "Ericameria nauseosa", rank: "species", ancestor_ids: [48460, 47126, TRACHEOPHYTA, 99999] };
const APIS = { id: 47219, name: "Apis mellifera", rank: "species", ancestor_ids: [48460, 1, 47120, 47158, 47219] };

function obs(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    uuid: `uuid-${id}`,
    observed_on: currentSeasonDate(7, 14),
    geojson: { coordinates: [-123.262, 44.5646], type: "Point" },
    positional_accuracy: 30,
    public_positional_accuracy: 30,
    geoprivacy: null,
    taxon_geoprivacy: null,
    place_ids: [1, 10, 484],
    place_guess: "Corvallis, OR, US",
    user: { id: 100, login: "adacollects", name: "Ada Collector" },
    taxon: RUBUS,
    ofvs: [{ name: "sampleId", value: "7" }, { name: "numberOfSpecimens", value: "3" }],
    ...extra,
  };
}

async function stage(o: Record<string, unknown>): Promise<void> {
  await conn.run("INSERT INTO sync_run (source, authenticated, completed_at) VALUES ('test', true, now())");
  await conn.run(
    `INSERT INTO observation_load (inat_id, sync_run_id, content, content_hash)
     VALUES ($1, (SELECT max(entity_id) FROM sync_run), $2, $3)`,
    [Number(o.id), canonicalJson(o), `hash-${o.id}-${Math.random()}`] as never,
  );
}

const one = async (sql: string) => (await rows(conn, sql))[0];
const count = async (sql: string) => Number(((await rows(conn, sql))[0] ?? [0])[0]);
const host = () => one("SELECT host_inat_taxon_id, host_name_as_observed, host_rank FROM sample");

const SET = "53439 species Eriophyllum lanatum";
const hostRow = (value: string, extra: Partial<SampleOverlayRow> = {}): SampleOverlayRow => ({
  sample_ref: "inat:7",
  field: "host",
  base_value: "47604 genus Rubus",
  value,
  author: "samstaff",
  reason: "the bees are on the woolly sunflower, not the bramble",
  ...extra,
});
const apply = async (...r: SampleOverlayRow[]) => {
  await upsertSampleOverlay(overlayPath, r);
  return applySampleOverlay(conn, r);
};
const promote = () => promoteObservations(conn, { sampleOverlayPath: overlayPath });

describe("a floral host staff set stands over the observation's", () => {
  it("is written to the sample with its provenance, and the sample and the override agree", async () => {
    await stage(obs(7));
    await promote();
    expect(await host()).toEqual([47604n, "Rubus", "genus"]);

    expect(await apply(hostRow(SET))).toEqual({ applied: 1, unresolved: [] });
    expect(await host()).toEqual([53439n, "Eriophyllum lanatum", "species"]);
    expect(
      await one(`SELECT o.host_inat_taxon_id, o.host_name, o.host_rank, o.observed_host_inat_taxon_id, o.observed_host_name, o.observed_host_rank,
                        p.display_name, o.reason
                 FROM sample_host_override o JOIN person p ON p.entity_id = o.set_by`),
    ).toEqual([53439n, "Eriophyllum lanatum", "species", 47604n, "Rubus", "genus", "Sam Staff", "the bees are on the woolly sunflower, not the bramble"]);
    expect(await count("SELECT count(*) FROM sample_host_override_stale")).toBe(0);
    expect(await count("SELECT count(*) FROM sample_host_override_diverged")).toBe(0);
  });

  it("writes no host at all, all three columns null, for `none`", async () => {
    await stage(obs(7));
    await promote();
    await apply(hostRow("none", { reason: "a bee caught on the road" }));
    expect(await host()).toEqual([null, null, null]);
    expect(await one("SELECT host_inat_taxon_id, host_name, host_rank FROM sample_host_override")).toEqual([null, null, null]);
    expect(await count("SELECT count(*) FROM sample_host_override_stale")).toBe(0);
  });

  it("is left alone by every promotion, however the observation changes, and by the clearing of a plant that is none", async () => {
    await stage(obs(7));
    await promote();
    await apply(hostRow(SET));

    await stage(obs(7, { taxon: ERICAMERIA }));
    await promote();
    expect(await host()).toEqual([53439n, "Eriophyllum lanatum", "species"]);
    // The observation turned into the bee, and then was flagged as Homo sapiens: neither rewrites nor clears it.
    await stage(obs(7, { taxon: APIS }));
    await promote();
    expect(await host()).toEqual([53439n, "Eriophyllum lanatum", "species"]);
    await stage(obs(7, { taxon: { id: 43584, name: "Homo sapiens", rank: "species", ancestor_ids: [48460, 1, 2, 40151, 43583, 43584] } }));
    await conn.run(`INSERT INTO inat_taxon_ancestor VALUES (53439, 53439, 0)`);
    await promote();
    expect(await host()).toEqual([53439n, "Eriophyllum lanatum", "species"]);
    expect(await count("SELECT count(*) FROM sample_host_override_stale")).toBe(0);
  });

  it("follows the observation again after removal, at once and on every promotion", async () => {
    await stage(obs(7));
    await promote();
    await apply(hostRow(SET));
    await stage(obs(7, { taxon: ERICAMERIA }));
    await promote();

    // The removal row, with no explanation: the sample takes what the observation gives now.
    await apply(hostRow("", { reason: "" }));
    expect(await host()).toEqual([99999n, "Ericameria nauseosa", "species"]);
    expect(await count("SELECT count(*) FROM sample_host_override")).toBe(0);
    await stage(obs(7, { taxon: RUBUS }));
    await promote();
    expect(await host()).toEqual([47604n, "Rubus", "genus"]);
    // The file keeps the removal for good and every promotion replays it: with nothing standing it changes nothing.
    expect(await count("SELECT count(*) FROM sample_host_override")).toBe(0);
  });

  it("restores what the sample held when the observation names no plant, so nothing staff set is left unrecorded", async () => {
    // The follow rule writes only while the observation names a plant, so without a base to
    // restore, removal would leave the staff host on the sample with no record that staff set it.
    const sampleId = await insertCleanSample(conn, {
      inat_observation_id: "7", sample_number: "'7'", collector_id: "(SELECT min(entity_id) FROM person)",
      host_name_as_observed: "'Ericameria nauseosa'", host_inat_taxon_id: "NULL", host_rank: "'species'",
    });
    await stage(obs(7, { taxon: null }));
    await promote();
    expect(await one(`SELECT host_inat_taxon_id, host_name_as_observed, host_rank FROM sample WHERE entity_id = ${sampleId}`)).toEqual([null, "Ericameria nauseosa", "species"]);

    // A host that was only a name has an empty id in the base.
    await apply(hostRow(SET, { base_value: "- species Ericameria nauseosa" }));
    expect(await host()).toEqual([53439n, "Eriophyllum lanatum", "species"]);
    expect(await one("SELECT observed_host_inat_taxon_id, observed_host_name, observed_host_rank FROM sample_host_override")).toEqual([null, "Ericameria nauseosa", "species"]);
    await apply(hostRow("", { reason: "", base_value: "" }));
    expect(await host()).toEqual([null, "Ericameria nauseosa", "species"]);
  });

  it("leaves the override standing and the sample as it was when removal fails part way", async () => {
    await stage(obs(7));
    await promote();
    await apply(hostRow(SET));
    // The follow rule reads observation_host, which is gone for the moment: the removal gets as far as restoring the base.
    await conn.run("ALTER VIEW observation_host RENAME TO observation_host_away");
    await expect(applySampleOverlay(conn, [hostRow("", { reason: "" })], { transactional: true })).rejects.toThrow();
    await conn.run("ALTER VIEW observation_host_away RENAME TO observation_host");
    expect(await count("SELECT count(*) FROM sample_host_override")).toBe(1);
    expect(await host()).toEqual([53439n, "Eriophyllum lanatum", "species"]);
    expect(await count("SELECT count(*) FROM sample_host_override_stale")).toBe(0);
    // And once it works, the same row applies whole.
    await applySampleOverlay(conn, [hostRow("", { reason: "" })], { transactional: true });
    expect(await count("SELECT count(*) FROM sample_host_override")).toBe(0);
    expect(await host()).toEqual([47604n, "Rubus", "genus"]);
  });

  it("restores a sample that had no host to having none", async () => {
    const sampleId = await insertCleanSample(conn, { inat_observation_id: "7", sample_number: "'7'" });
    await stage(obs(7, { taxon: null }));
    await promote();
    await apply(hostRow(SET, { base_value: "" }));
    await apply(hostRow("", { reason: "", base_value: "" }));
    expect(await one(`SELECT host_inat_taxon_id, host_name_as_observed, host_rank FROM sample WHERE entity_id = ${sampleId}`)).toEqual([null, null, null]);
  });

  it("gives the same result when its file is replayed on a store whose taxon cache is empty", async () => {
    await stage(obs(7));
    await promote();
    await upsertSampleOverlay(overlayPath, [hostRow(SET)]);
    await promote();
    const first = await one("SELECT host_inat_taxon_id, host_name_as_observed, host_rank FROM sample");

    // A rebuild: a fresh store, the observation minted again, the file replayed. The name and rank
    // come from the file, never from the taxon cache, which here is empty.
    const rebuilt = await createMemoryDb();
    const keep = conn;
    conn = rebuilt.conn;
    try {
      await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
      await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) SELECT entity_id, 100, 'adacollects' FROM person`);
      for (const [id, name, level] of [[1, "United States", 0], [10, "Oregon", 10], [484, "Benton", 20]] as const) {
        await conn.run(`INSERT INTO inat_place (inat_place_id, name, admin_level) VALUES (${id}, '${name}', ${level})`);
      }
      expect(await count("SELECT count(*) FROM inat_taxon")).toBe(0);
      await stage(obs(7));
      await promote();
      expect(await one("SELECT host_inat_taxon_id, host_name_as_observed, host_rank FROM sample")).toEqual(first);
      expect(await count("SELECT count(*) FROM sample_host_override")).toBe(1);
    } finally {
      conn = keep;
    }
  });

  it("keeps the first base when staff save over a standing host", async () => {
    await stage(obs(7));
    await promote();
    await apply(hostRow(SET));
    const { currentHostOf } = await import("../src/apply-sample-overlay.js");
    const sampleId = Number((await one("SELECT entity_id FROM sample"))![0]);
    expect(await currentHostOf(conn, sampleId)).toBe("47604 genus Rubus");
    await apply(hostRow("53438 species Another plant", { base_value: await currentHostOf(conn, sampleId) }));
    expect(await one("SELECT observed_host_inat_taxon_id, observed_host_name FROM sample_host_override")).toEqual([47604n, "Rubus"]);
  });

  it("refuses a standing row with a blank reason, before the table's check can fail the promotion", async () => {
    await stage(obs(7));
    await promote();
    const result = await applySampleOverlay(conn, [hostRow(SET, { reason: "  " })]);
    expect(result.unresolved).toEqual([{ sample_ref: "inat:7", field: "host", reason: "a floral host needs a reason" }]);
    expect(await count("SELECT count(*) FROM sample_host_override")).toBe(0);
    expect(await host()).toEqual([47604n, "Rubus", "genus"]);
    // And the table says the same for a writer that bypasses the applier.
    const id = Number((await one("SELECT entity_id FROM sample"))![0]);
    await expect(conn.run(`INSERT INTO sample_host_override (sample_id, reason) VALUES (${id}, '')`)).rejects.toThrow();
  });

  it("reports a row that names no sample rather than guessing", async () => {
    const result = await applySampleOverlay(conn, [hostRow(SET, { sample_ref: "inat:555" })]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.applied).toBe(0);
  });
});

describe("the view of a host the observation has since moved on from", () => {
  it("names an observation that now gives a plant that is neither the base nor the host set", async () => {
    await stage(obs(7));
    await promote();
    await apply(hostRow(SET));
    expect(await count("SELECT count(*) FROM sample_host_override_diverged")).toBe(0);

    await stage(obs(7, { taxon: ERICAMERIA }));
    await promote();
    expect(await one("SELECT override_host_inat_taxon_id, observed_host_inat_taxon_id, observation_host_inat_taxon_id, observation_host_name, observation_host_rank FROM sample_host_override_diverged"))
      .toEqual([53439n, 47604n, 99999n, "Ericameria nauseosa", "species"]);

    // Back to what the sample held, or on to what staff set: nothing is in dispute.
    await stage(obs(7, { taxon: RUBUS }));
    await promote();
    expect(await count("SELECT count(*) FROM sample_host_override_diverged")).toBe(0);
    await stage(obs(7, { taxon: ERIOPHYLLUM }));
    await promote();
    expect(await count("SELECT count(*) FROM sample_host_override_diverged")).toBe(0);
  });

  it("ignores an observation that names no plant, as the follow rule does", async () => {
    await stage(obs(7));
    await promote();
    await apply(hostRow(SET));
    await stage(obs(7, { taxon: null }));
    await promote();
    expect(await count("SELECT count(*) FROM sample_host_override_diverged")).toBe(0);
  });
});

describe("the rule on a host that is no vascular plant", () => {
  const finding = () => count(`SELECT count(*) FROM qc_finding WHERE rule_name = 'non_tracheophyte_host'`);
  const lineage = async (id: number, name: string, rank: string, ancestors: number[]) => {
    await conn.run(`INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active) VALUES (${id}, '${name}', '${rank}', 10, true) ON CONFLICT DO NOTHING`);
    for (const [depth, a] of [id, ...ancestors].entries()) await conn.run(`INSERT INTO inat_taxon_ancestor VALUES (${id}, ${a}, ${depth}) ON CONFLICT DO NOTHING`);
  };

  it("blocks an observation of a bee before staff name the real host, and does not after", async () => {
    await stage(obs(7, { taxon: APIS }));
    await promote();
    expect(await finding()).toBe(1);
    expect(await count("SELECT count(*) FROM printable_sample")).toBe(0);

    // Setting a host takes the sample out of the observation's judgement, by that host.
    await lineage(53439, "Eriophyllum lanatum", "species", [47604, TRACHEOPHYTA, 47126, 48460]);
    await apply(hostRow(SET, { base_value: "47219 species Apis mellifera" }));
    expect(await finding()).toBe(0);
    expect(await count("SELECT count(*) FROM printable_sample")).toBe(1);

    // Back to following the observation: the finding is back.
    await apply(hostRow("", { reason: "" }));
    expect(await finding()).toBe(1);
  });

  it("is quiet for `none`, and for a host whose lineage the cache has not read", async () => {
    await stage(obs(7, { taxon: APIS }));
    await promote();
    await apply(hostRow("none", { base_value: "47219 species Apis mellifera", reason: "no flower" }));
    expect(await finding()).toBe(0);
    await apply(hostRow(SET, { base_value: "47219 species Apis mellifera" }));
    expect(await finding()).toBe(0);
  });

  it("judges a host set in Beeline by that host, never the observation: a row that reached the file with a moss fires", async () => {
    await stage(obs(7));
    await promote();
    await lineage(53439, "Eriophyllum lanatum", "species", [47604, 47126, 48460]);
    await apply(hostRow(SET));
    const [[detail, rank]] = (await rows(conn, `SELECT detail_taxon_name, detail_taxon_rank FROM qc_finding WHERE rule_name = 'non_tracheophyte_host'`)) as [[string, string]];
    expect([detail, rank]).toEqual(["Eriophyllum lanatum", "species"]);
  });
});

describe("a sample from the old Beeline", () => {
  async function old() {
    const { instance, conn: c } = await promotedStore("occurrences");
    await c.run(`INSERT INTO person (display_name) VALUES ('Sam Staff')`);
    await c.run(`INSERT INTO inat_account (person_id, inat_user_id, login) SELECT entity_id, 3, 'samstaff' FROM person WHERE display_name = 'Sam Staff'`);
    const [[sampleId]] = (await rows(c, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00657'`)) as [[number]];
    const [[legacyId]] = (await rows(c, `SELECT min(_id) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[string]];
    return { instance, conn: c, sampleId: Number(sampleId), legacyId: String(legacyId) };
  }
  const hostOf = async (c: DuckDBConnection, id: number) =>
    (await rows(c, `SELECT host_inat_taxon_id, host_name_as_observed, host_rank FROM sample WHERE entity_id = ${id}`))[0];

  it("takes a host under its first old record's key, and removal restores what it held", async () => {
    const o = await old();
    const before = await hostOf(o.conn, o.sampleId);
    const ref = `legacy:${o.legacyId}`;
    const set = hostRow(SET, { sample_ref: ref, base_value: formatHost({ inat_taxon_id: before![0] === null ? null : Number(before![0]), rank: before![2] as string | null, name: before![1] as string | null }) });
    expect(await applySampleOverlay(o.conn, [set])).toEqual({ applied: 1, unresolved: [] });
    expect(await hostOf(o.conn, o.sampleId)).toEqual([53439n, "Eriophyllum lanatum", "species"]);
    expect(await applySampleOverlay(o.conn, [hostRow("", { sample_ref: ref, reason: "" })])).toEqual({ applied: 1, unresolved: [] });
    expect(await hostOf(o.conn, o.sampleId)).toEqual(before);
  });

  it("still holds off the follow rule after it gains an observation, and the diverged view says what the observation names", async () => {
    const o = await old();
    const ref = `legacy:${o.legacyId}`;
    await applySampleOverlay(o.conn, [hostRow(SET, { sample_ref: ref, base_value: "" })]);
    await o.conn.run(`UPDATE sample SET inat_observation_id = 777 WHERE entity_id = ${o.sampleId}`);
    await o.conn.run(
      `INSERT INTO observation_field (inat_id, user_id, host_taxon_id, host_taxon_name, host_taxon_rank, host_is_tracheophyte)
       VALUES (777, 1, 99999, 'Ericameria nauseosa', 'species', true)`,
    );
    // The follow rule's own statement, as ingest/mint-samples.sql runs it, leaves the sample alone.
    const { readFile } = await import("node:fs/promises");
    const mint = await readFile(new URL("../ingest/mint-samples.sql", import.meta.url), "utf8");
    const followRule = mint.slice(mint.indexOf("UPDATE sample SET\n  host_inat_taxon_id    = f.host_taxon_id"));
    await o.conn.run(followRule.slice(0, followRule.indexOf(";") + 1));
    expect(await hostOf(o.conn, o.sampleId)).toEqual([53439n, "Eriophyllum lanatum", "species"]);
    expect(await rows(o.conn, `SELECT observation_host_inat_taxon_id, observation_host_name FROM sample_host_override_diverged`)).toEqual([[99999n, "Ericameria nauseosa"]]);
  });
});

describe("the correction", () => {
  async function setup() {
    const { instance, conn: c } = await createMemoryDb();
    const person = async (name: string, login: string, uid: number) => {
      const [[id]] = (await (await c.run(`INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)).getRows()) as [[number]];
      await c.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${id}, ${uid}, '${login}')`);
      return Number(id);
    };
    const alice = await person("Alice Adams", "alice", 1);
    const sam = await person("Sam Staff", "samstaff", 3);
    const linked = await insertCleanSample(c, {
      collector_id: String(alice), sample_number: "'A-1'", inat_observation_id: "998877",
      host_inat_taxon_id: "47604", host_name_as_observed: "'Rubus'", host_rank: "'genus'",
    });
    const unlinked = await insertCleanSample(c, { collector_id: String(alice), sample_number: "'A-2'" });
    const entered = await insertCleanSample(c, { collector_id: String(alice), sample_number: "'T-1'" });
    await c.run(`INSERT INTO sample_entry (sample_id, entered_by) VALUES (${entered}, ${alice})`);
    const paths = await scratchPaths();
    const samplePaths = { log: paths.sampleChangesPath, state: paths.sampleStatePath };
    await recordSampleChanges(duckdbReader(c), samplePaths, { source: "observation_promotion" });
    const read = fakeReader();
    const deps: CorrectionDeps = {
      db: createKysely(instance),
      conn: c,
      correctionsPath: paths.correctionsPath,
      sampleOverlayPath: paths.sampleOverlayPath,
      hostTaxon: read,
      samplePaths,
      syncJobRunning: () => false,
    };
    const actor = (personId: number, login: string, extra: Partial<Actor> = {}): Actor => ({
      personId, signedInPersonId: personId, login, staff: false, impersonating: false, ...extra,
    });
    const form = (extra: Partial<StaffHostFormInput> = {}): StaffHostFormInput => ({
      taxon: "https://www.inaturalist.org/taxa/53439-Eriophyllum-lanatum",
      none: false,
      remove: false,
      note: "the bees are on the woolly sunflower",
      problemFor: hostProblemFor(en),
      ...extra,
    });
    return {
      conn: c, deps, read, linked, unlinked, entered, paths, form,
      alice: actor(alice, "alice"),
      sam: actor(sam, "samstaff", { staff: true }),
      hostOf: async (id: number) => (await rows(c, `SELECT host_inat_taxon_id, host_name_as_observed, host_rank FROM sample WHERE entity_id = ${id}`))[0],
      file: () => readSampleOverlay(paths.sampleOverlayPath),
    };
  }

  it("refuses anyone who is not staff, and anyone impersonating, before reading iNaturalist", async () => {
    const s = await setup();
    expect(await setHost(s.deps, s.alice, s.linked, s.form())).toEqual({ ok: false, refusal: "not_admin" });
    expect(await setHost(s.deps, { ...s.sam, impersonating: true }, s.linked, s.form())).toEqual({ ok: false, refusal: "impersonating" });
    expect(await setHost(s.deps, s.sam, 999999, s.form())).toEqual({ ok: false, refusal: "not_found" });
    expect(await setHost({ ...s.deps, conn: undefined }, s.sam, s.linked, s.form())).toEqual({ ok: false, refusal: "unavailable" });
    expect(s.read).not.toHaveBeenCalled();
    expect(await s.file()).toEqual([]);
  });

  it("refuses a blank explanation, for a plant and for none, without reading iNaturalist", async () => {
    const s = await setup();
    for (const f of [s.form({ note: "" }), s.form({ note: "   " }), s.form({ none: true, taxon: "", note: "" })]) {
      expect(await setHost(s.deps, s.sam, s.linked, f)).toEqual({ ok: false, refusal: "invalid", problem: en.record.sample.staffHost.problems.reason });
    }
    expect(s.read).not.toHaveBeenCalled();
    expect(await s.hostOf(s.linked)).toEqual([47604n, "Rubus", "genus"]);
  });

  it("refuses what is not a plant given by address or number, and both a plant and none", async () => {
    const s = await setup();
    const p = en.record.sample.staffHost.problems;
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ taxon: "Eriophyllum lanatum" }))).toMatchObject({ refusal: "invalid", problem: p.address });
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ taxon: "" }))).toMatchObject({ refusal: "invalid", problem: p.taxon_needed });
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ none: true }))).toMatchObject({ refusal: "invalid", problem: p.both });
    expect(s.read).not.toHaveBeenCalled();
  });

  it("refuses a taxon that is unknown, retired or not a vascular plant, and one it could not check, writing nothing", async () => {
    const s = await setup();
    const p = en.record.sample.staffHost.problems;
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ taxon: "424242" }))).toMatchObject({ refusal: "invalid", problem: p.unknown });
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ taxon: "47219" }))).toMatchObject({ refusal: "invalid", problem: p.not_vascular });
    const gone = await setHost(s.deps, s.sam, s.linked, s.form({ taxon: "60000" }));
    expect(gone).toMatchObject({ refusal: "invalid" });
    expect((gone as { problem: string }).problem).toBe(p.inactive(["taxon 53439", "taxon 777"]));
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ taxon: "1" }))).toEqual({ ok: false, refusal: "inat_unreachable" });
    expect(await s.file()).toEqual([]);
    expect(await s.hostOf(s.linked)).toEqual([47604n, "Rubus", "genus"]);
    expect(await rows(s.conn, "SELECT 1 FROM sample_host_override")).toEqual([]);
  });

  it("refuses the host the sample already has when none is set in Beeline, as no change", async () => {
    const s = await setup();
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ taxon: "47604" }))).toMatchObject({
      refusal: "invalid",
      problem: en.record.sample.staffHost.problems.unchanged,
    });
    // A sample with no host, told it has none, is no change either.
    const bare = await insertCleanSample(s.conn, { sample_number: "'A-9'", inat_observation_id: "998880" });
    expect(await setHost(s.deps, s.sam, bare, s.form({ none: true, taxon: "" }))).toMatchObject({ refusal: "invalid" });
  });

  it("sets, changes, says none and removes: the sample, the file and the change log, each time", async () => {
    const s = await setup();
    const set = await setHost(s.deps, s.sam, s.linked, s.form());
    expect(set).toEqual({ ok: true, outcome: "saved", dry_run: false, host: { id: 53439, name: "Eriophyllum lanatum", rank: "species" } });
    expect(await s.hostOf(s.linked)).toEqual([53439n, "Eriophyllum lanatum", "species"]);
    expect(await s.file()).toEqual([
      { sample_ref: "inat:998877", field: "host", base_value: "47604 genus Rubus", value: SET, author: "samstaff", reason: "the bees are on the woolly sunflower" },
    ]);
    // The first base stays through a change and through none.
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ taxon: "47604", note: "after all, the bramble" }))).toMatchObject({ ok: true, outcome: "saved" });
    expect(await s.hostOf(s.linked)).toEqual([47604n, "Rubus", "genus"]);
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ none: true, taxon: "", note: "a bee off the road" }))).toMatchObject({ ok: true, outcome: "saved", host: null });
    expect(await s.hostOf(s.linked)).toEqual([null, null, null]);
    expect((await s.file())[0]).toMatchObject({ base_value: "47604 genus Rubus", value: "none", reason: "a bee off the road" });
    expect(await rows(s.conn, "SELECT 1 FROM sample_host_override_stale")).toEqual([]);

    // Removal needs no explanation, restores what the sample held and applies the rule.
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ remove: true, taxon: "", note: "" }))).toMatchObject({ ok: true, outcome: "removed" });
    expect(await s.hostOf(s.linked)).toEqual([47604n, "Rubus", "genus"]);
    expect(await rows(s.conn, "SELECT 1 FROM sample_host_override")).toEqual([]);
    expect((await s.file())[0]).toMatchObject({ value: "" });
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ remove: true, taxon: "", note: "" }))).toMatchObject({ ok: true, outcome: "unchanged" });

    // Each set, change and removal is in the log with its author, door and explanation.
    const entries = (await readSampleChanges(s.paths.sampleChangesPath)).filter((c) => c.field === "host" && c.source !== "observation_promotion");
    expect(entries.map((c) => [c.new_value, c.author, c.source, c.reason])).toEqual([
      ["53439 Eriophyllum lanatum", "samstaff", "app", "the bees are on the woolly sunflower"],
      ["47604 Rubus", "samstaff", "app", "after all, the bramble"],
      ["", "samstaff", "app", "a bee off the road"],
      ["47604 Rubus", "samstaff", "app", ""],
    ]);
  });

  it("does the checks of a dry run and writes nothing", async () => {
    const s = await setup();
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ dryRun: true }))).toMatchObject({ ok: true, outcome: "would_save", dry_run: true });
    expect(await s.hostOf(s.linked)).toEqual([47604n, "Rubus", "genus"]);
    expect(await s.file()).toEqual([]);
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ taxon: "47219", dryRun: true }))).toMatchObject({ refusal: "invalid" });
  });

  it("does not ask iNaturalist for a taxon the cache holds as an active vascular plant", async () => {
    const s = await setup();
    await s.conn.run(`INSERT INTO inat_taxon (inat_taxon_id, name, rank, rank_level, is_active) VALUES (53439, 'Eriophyllum lanatum', 'species', 10, true)`);
    for (const [a, d] of [[53439, 0], [211194, 3]]) await s.conn.run(`INSERT INTO inat_taxon_ancestor VALUES (53439, ${a}, ${d})`);
    expect(await setHost(s.deps, s.sam, s.linked, s.form())).toMatchObject({ ok: true, outcome: "saved" });
    expect(s.read).not.toHaveBeenCalled();
  });

  it("is refused while the nightly run or the weekly sweep runs, before iNaturalist is read", async () => {
    const s = await setup();
    const busy = { ...s.deps, syncJobRunning: () => true };
    expect(await setHost(busy, s.sam, s.linked, s.form())).toEqual({ ok: false, refusal: "busy" });
    expect(s.read).not.toHaveBeenCalled();
    expect(await s.file()).toEqual([]);
  });

  it("writes nothing to the file for an answer whose name is blank or whose rank has a space in it", async () => {
    const s = await setup();
    for (const answer of [
      { ...eriophyllum, name: "   " },
      { ...eriophyllum, rank: "sub species" },
      { ...eriophyllum, rank: "" },
    ]) {
      const deps = { ...s.deps, hostTaxon: vi.fn<HostTaxonReader>(async () => answer) };
      expect(await setHost(deps, s.sam, s.linked, s.form())).toEqual({
        ok: false, refusal: "invalid", problem: en.record.sample.staffHost.problems.unwritable,
      });
      expect(await setHost(deps, s.sam, s.linked, s.form({ dryRun: true }))).toMatchObject({ refusal: "invalid" });
    }
    expect(await s.file()).toEqual([]);
    expect(await s.hostOf(s.linked)).toEqual([47604n, "Rubus", "genus"]);
  });

  it("records a base the sample holds with an empty rank and no name, and the file reads back", async () => {
    const s = await setup();
    await s.conn.run(`UPDATE sample SET host_rank = '', host_name_as_observed = NULL WHERE entity_id = ${s.linked}`);
    expect(await setHost(s.deps, s.sam, s.linked, s.form())).toMatchObject({ ok: true, outcome: "saved" });
    expect((await s.file())[0]).toMatchObject({ base_value: "47604 - -" });
    expect(await setHost(s.deps, s.sam, s.linked, s.form({ taxon: "", remove: true, note: "" }))).toMatchObject({ ok: true, outcome: "removed" });
    expect(await s.hostOf(s.linked)).toEqual([47604n, null, null]);
  });

  it("refuses a sample with no observation and no old record, and one entered in Beeline, with a message", async () => {
    const s = await setup();
    expect(await setHost(s.deps, s.sam, s.unlinked, s.form())).toEqual({ ok: false, refusal: "no_host_key" });
    expect(await setHost(s.deps, s.sam, s.entered, s.form())).toEqual({ ok: false, refusal: "no_host_key" });
    expect(s.read).not.toHaveBeenCalled();
  });

  it("is refused for a sample whose observation is on another sample, writing nothing", async () => {
    const s = await setup();
    await insertCleanSample(s.conn, { sample_number: "'A-8'", inat_observation_id: "998877" });
    const result = await setHost(s.deps, s.sam, s.linked, s.form());
    expect(result).toMatchObject({ ok: false, refusal: "unresolved" });
    expect(await s.file()).toEqual([]);
  });
});

test("a host staff set goes when its sample is deleted", async () => {
  const { DELETED_WITH_SAMPLE } = await import("../src/trap-sample.js");
  expect(DELETED_WITH_SAMPLE).toContain("sample_host_override");
});

describe("a sample from the old Beeline that gains an observation by the free link", () => {
  it("keeps its one row under the old record's key through a second save and a removal", async () => {
    const { instance, conn: c } = await promotedStore("occurrences");
    const [[sampleId]] = (await rows(c, `SELECT entity_id FROM sample WHERE sample_number = 'OBAS-00657'`)) as [[number]];
    const [[legacyId]] = (await rows(c, `SELECT min(_id) FROM legacy_specimen_number WHERE sample_id = ${sampleId}`)) as [[string]];
    const paths = await scratchPaths();
    const deps: CorrectionDeps = {
      db: createKysely(instance), conn: c, correctionsPath: paths.correctionsPath, sampleOverlayPath: paths.sampleOverlayPath,
      hostTaxon: fakeReader(), samplePaths: { log: paths.sampleChangesPath, state: paths.sampleStatePath }, syncJobRunning: () => false,
    };
    const sam: Actor = { personId: 1, signedInPersonId: 1, login: "samstaff", staff: true, impersonating: false };
    const form = (extra: Partial<StaffHostFormInput> = {}): StaffHostFormInput => ({
      taxon: "53439", none: false, remove: false, note: "because", problemFor: hostProblemFor(en), ...extra,
    });
    const file = () => readSampleOverlay(paths.sampleOverlayPath);
    const before = (await rows(c, `SELECT host_inat_taxon_id, host_name_as_observed, host_rank FROM sample WHERE entity_id = ${sampleId}`))[0];

    expect(await setHost(deps, sam, Number(sampleId), form())).toMatchObject({ ok: true, outcome: "saved" });
    expect((await file()).map((r) => r.sample_ref)).toEqual([`legacy:${legacyId}`]);

    // The free link: the sample now carries an observation.
    await c.run(`UPDATE sample SET inat_observation_id = 777 WHERE entity_id = ${sampleId}`);
    expect(await setHost(deps, sam, Number(sampleId), form({ taxon: "", none: true, note: "no flower after all" }))).toMatchObject({ ok: true, outcome: "saved" });
    expect((await file()).map((r) => [r.sample_ref, r.value])).toEqual([[`legacy:${legacyId}`, "none"]]);

    expect(await setHost(deps, sam, Number(sampleId), form({ taxon: "", remove: true, note: "" }))).toMatchObject({ ok: true, outcome: "removed" });
    expect((await file()).map((r) => [r.sample_ref, r.value])).toEqual([[`legacy:${legacyId}`, ""]]);
    expect((await rows(c, `SELECT host_inat_taxon_id, host_name_as_observed, host_rank FROM sample WHERE entity_id = ${sampleId}`))[0]).toEqual(before);
    expect(await rows(c, "SELECT 1 FROM sample_host_override")).toEqual([]);
  });
});
