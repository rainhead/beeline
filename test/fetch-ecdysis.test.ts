import type { DuckDBConnection } from "@duckdb/node-api";
import { zipSync } from "fflate";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { configFromEnv } from "../src/app/config.js";
import { describeFetch, fetchEcdysis, type EcdysisCollection } from "../src/fetch-ecdysis.js";
import { createKysely } from "../src/db.js";
import { uploadStateOf } from "../src/app/ecdysis-upload.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

/**
 * The nightly Ecdysis fetch (beeline-9ut.1) against a stand-in for Ecdysis:
 * the v2 API's counts, a sign-in that sets a session cookie, and the download
 * handler, which serves the archive (the loader's own test fixture, zipped)
 * only to a request carrying that cookie — as Ecdysis answers 401 otherwise.
 */

const FIXTURES = new URL("./fixtures/ecdysis/archive/", import.meta.url).pathname;
const WA: EcdysisCollection = { datasetId: 44, catalogPrefix: "WSDA_", program: "WaBA" };
const BC: EcdysisCollection = { collectionId: 196, catalogPrefix: "BCBA_", program: "BC" };
const CREDENTIALS = { username: "fetcher", password: "s3cret-never-logged" };

let conn: DuckDBConnection;
let instance: Awaited<ReturnType<typeof createMemoryDb>>["instance"];
let dir: string;
let zip: Uint8Array;

beforeEach(async () => {
  ({ conn, instance } = await createMemoryDb());
  await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector'), ('Sam Staff')`);
  await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('genus', 'Bombus'), ('genus', 'Andrena'), ('genus', 'Lasioglossum'), ('genus', 'Ceratina')`);
  for (const [genus, species] of [["Bombus", "Bombus vosnesenskii"], ["Andrena", "Andrena sladeni"], ["Lasioglossum", "Lasioglossum cooleyi"], ["Ceratina", "Ceratina acantha"]]) {
    await conn.run(`INSERT INTO animal (rank, scientific_name, parent_id) SELECT 'species', '${species}', entity_id FROM animal WHERE scientific_name = '${genus}'`);
  }
  const sample = await insertCleanSample(conn, { specimen_count: "4" });
  for (const [n, fieldNumber] of [[1, "2303966"], [2, "2303967"], [3, "2303968"], [4, "2303969"]] as const) {
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, ${n}, '${fieldNumber}')`);
  }
  dir = await mkdtemp(join(tmpdir(), "ecdysis-fetch-"));
  zip = zipSync({
    "occurrences.csv": new Uint8Array(await readFile(`${FIXTURES}occurrences.csv`)),
    "identifications.csv": new Uint8Array(await readFile(`${FIXTURES}identifications.csv`)),
    "eml.xml": new TextEncoder().encode("<eml/>"),
  });
});

interface Ecdysis {
  fetch: typeof fetch;
  /** What the API reports. */
  counts: { total: number; modifiedSince: number };
  apiFails: boolean;
  acceptLogin: boolean;
  downloads: number;
  requests: string[];
}

function ecdysis(): Ecdysis {
  const e: Ecdysis = {
    counts: { total: 6, modifiedSince: 2 },
    apiFails: false,
    acceptLogin: true,
    downloads: 0,
    requests: [],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body === undefined ? "" : String(init.body);
      e.requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search} ${body}`);
      if (url.pathname === "/api/v2/occurrence") {
        if (e.apiFails) return new Response("oops", { status: 500 });
        const count = url.searchParams.has("dateLastModifiedMin") ? e.counts.modifiedSince : e.counts.total;
        return Response.json({ count, results: [] });
      }
      if (url.pathname === "/profile/index.php") {
        return new Response(null, {
          status: 302,
          headers: e.acceptLogin ? [["location", "/"], ["set-cookie", "PHPSESSID=abc123; path=/; HttpOnly"]] : [["location", "/"]],
        });
      }
      if (url.pathname === "/collections/download/downloadhandler.php") {
        const cookie = new Headers(init?.headers).get("cookie");
        if (cookie !== "PHPSESSID=abc123") return Response.json({ error: "Unauthorized access" }, { status: 401 });
        e.downloads += 1;
        return new Response(Buffer.from(zip), { headers: { "content-type": "application/zip" } });
      }
      return new Response("not found", { status: 404 });
    },
  };
  return e;
}

const fetchWith = (e: Ecdysis, now = new Date("2026-10-09T10:00:00Z")) =>
  fetchEcdysis(conn, WA, { dir, credentials: CREDENTIALS, fetch: e.fetch, now });

describe("the nightly Ecdysis fetch", () => {
  test("the first run signs in, downloads, loads, and keeps the archive and the probe's baseline", async () => {
    const e = ecdysis();
    const r = await fetchWith(e);
    expect(r).toMatchObject({ source: "downloaded", reason: "no archive downloaded before" });
    expect(r.load).toMatchObject({ input: "archive", matched: 4, loaded: 6 });
    expect(e.downloads).toBe(1);
    // The dataset's own download, with the identification history.
    const download = e.requests.find((q) => q.startsWith("POST /collections/download/"))!;
    expect(download).toContain("identifications=1");
    expect(decodeURIComponent(download)).toContain("datasetid=44");
    expect(existsSync(join(dir, "44.zip"))).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "44.probe.json"), "utf8"))).toEqual({ datasetId: 44, total: 6, since: "2026-10-08", modifiedSince: 2 });
    // Nothing unpacked is left behind.
    expect((await import("node:fs")).readdirSync(dir).sort()).toEqual(["44.probe.json", "44.read.json", "44.zip"]);
    expect(describeFetch(r)).not.toContain(CREDENTIALS.password);
  });

  test("every successful read leaves a marker beside the zip: when it began, which zip it loaded, how many records", async () => {
    const e = ecdysis();
    await fetchWith(e);
    const marker = async () => JSON.parse(await readFile(join(dir, "44.read.json"), "utf8"));
    const zipStat = (await import("node:fs")).statSync(join(dir, "44.zip"));
    expect(await marker()).toEqual({
      scope: "dataset 44",
      readAt: "2026-10-09T10:00:00.000Z",
      source: "downloaded",
      zipBytes: zipStat.size,
      zipModifiedAt: zipStat.mtime.toISOString(),
      records: 6,
    });
    // A read that found nothing new still counts, and says so; the zip is the same one.
    await fetchWith(e, new Date("2026-10-10T10:00:00Z"));
    expect(await marker()).toMatchObject({ source: "cached", readAt: "2026-10-10T10:00:00.000Z", zipBytes: zipStat.size, zipModifiedAt: zipStat.mtime.toISOString() });
  });

  test("a read that failed leaves the earlier marker as it was", async () => {
    const e = ecdysis();
    await fetchWith(e);
    e.apiFails = true;
    e.acceptLogin = false;
    await expect(fetchWith(e, new Date("2026-10-11T10:00:00Z"))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(dir, "44.read.json"), "utf8")).readAt).toBe("2026-10-09T10:00:00.000Z");
  });

  test("when Ecdysis says nothing moved, the cached archive is reloaded and nothing is downloaded", async () => {
    const e = ecdysis();
    await fetchWith(e);
    const again = await fetchWith(e, new Date("2026-10-10T10:00:00Z"));
    expect(again).toMatchObject({ source: "cached", reason: "unchanged since 2026-10-08 (6 records)" });
    expect(again.load.loaded).toBe(0);
    expect(e.downloads).toBe(1);
  });

  test("a reseeded store is made whole from the cached archive, though Ecdysis has not moved", async () => {
    const e = ecdysis();
    await fetchWith(e);
    await conn.run("DELETE FROM ecdysis_identification");
    await conn.run("DELETE FROM determination WHERE channel = 'ecdysis_import'");
    const again = await fetchWith(e, new Date("2026-10-10T10:00:00Z"));
    expect(again.source).toBe("cached");
    expect(again.load.loaded).toBe(6);
  });

  test("a kept archive that cannot be read is downloaded afresh rather than failing every night", async () => {
    const e = ecdysis();
    await fetchWith(e);
    await (await import("node:fs/promises")).writeFile(join(dir, "44.zip"), "not a zip");
    const again = await fetchWith(e, new Date("2026-10-10T10:00:00Z"));
    expect(again.source).toBe("downloaded");
    expect(again.reason).toMatch(/^the kept archive could not be loaded \(.+\), so downloading$/);
    expect(e.downloads).toBe(2);
  });

  test("a record added or edited since the last download means downloading again", async () => {
    const e = ecdysis();
    await fetchWith(e);
    e.counts = { total: 6, modifiedSince: 3 };
    const edited = await fetchWith(e, new Date("2026-10-10T10:00:00Z"));
    expect(edited).toMatchObject({ source: "downloaded", reason: "+0 records, 1 more modified since 2026-10-08" });
    e.counts = { total: 5, modifiedSince: 3 };
    const deleted = await fetchWith(e, new Date("2026-10-11T10:00:00Z"));
    expect(deleted.source).toBe("downloaded");
    expect(e.downloads).toBe(3);
  });

  test("an API it cannot ask means downloading, and no baseline is kept to skip by", async () => {
    const e = ecdysis();
    e.apiFails = true;
    const r = await fetchWith(e);
    expect(r.source).toBe("downloaded");
    expect(r.reason).toMatch(/^probe failed \(Ecdysis API answered 500\), so downloading$/);
    expect(existsSync(join(dir, "44.probe.json"))).toBe(false);
    const again = await fetchWith(e, new Date("2026-10-10T10:00:00Z"));
    expect(again.source).toBe("downloaded");
  });

  test("a refused sign-in fails the run without the password, and keeps nothing", async () => {
    const e = ecdysis();
    e.acceptLogin = false;
    const err = await fetchWith(e).catch((x: Error) => x);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/sign-in set no session cookie/);
    expect((err as Error).message).not.toContain(CREDENTIALS.password);
    expect(existsSync(join(dir, "44.zip"))).toBe(false);
    expect(existsSync(join(dir, "44.probe.json"))).toBe(false);
    expect(await rows(conn, "SELECT count(*) FROM determination")).toEqual([[0n]]);
  });
});

describe("the read marker and the upload files", () => {
  test("a read the fetch has just made is accepted by the upload code, which then knows the catalog numbers Beeline could not match", async () => {
    const bcOccurrences = (await readFile(`${FIXTURES}occurrences.csv`, "utf8")).replaceAll("WSDA_", "BCBA_");
    zip = zipSync({
      "occurrences.csv": new TextEncoder().encode(bcOccurrences),
      "identifications.csv": new Uint8Array(await readFile(`${FIXTURES}identifications.csv`)),
    });
    const e = ecdysis();
    const db = createKysely(instance);
    expect(await uploadStateOf(db, BC, { ecdysisDir: dir })).toMatchObject({ ok: false, reason: "never" });
    await fetchEcdysis(conn, BC, { dir, credentials: CREDENTIALS, fetch: e.fetch, now: new Date() });
    const state = await uploadStateOf(db, BC, { ecdysisDir: dir });
    expect(state).toMatchObject({ ok: true });
    if (!state.ok) return;
    // Matched to a specimen, and not matched (BCBA_9999999 is no specimen's).
    expect(state.held.has("bcba_2303966")).toBe(true);
    expect(state.held.has("bcba_9999999")).toBe(true);
    // A read that finds nothing new counts too, and the zip is the same one.
    await fetchEcdysis(conn, BC, { dir, credentials: CREDENTIALS, fetch: e.fetch, now: new Date() });
    expect((await uploadStateOf(db, BC, { ecdysisDir: dir })).ok).toBe(true);
    expect(e.downloads).toBe(1);
  });
});

describe("the Ecdysis login in the environment", () => {
  const base = { BEELINE_ENV: "development" };
  test("is both halves or neither", () => {
    expect(configFromEnv(base).ecdysis).toBeNull();
    expect(configFromEnv({ ...base, ECDYSIS_USERNAME: "u", ECDYSIS_PASSWORD: "p" }).ecdysis).toEqual({ username: "u", password: "p" });
    expect(() => configFromEnv({ ...base, ECDYSIS_USERNAME: "u" })).toThrow(/set together/);
    expect(() => configFromEnv({ ...base, ECDYSIS_PASSWORD: "p" })).toThrow(/set together/);
  });

  test("British Columbia is asked for by collection, not dataset, and its BCBA_ catalog numbers join to field numbers", async () => {
    // Washington's fixture with the prefix BC's catalog numbers carry
    // (BCBA_2404406 in Ecdysis's v2 API, 2026-11-16, over field number 2404406).
    const bcOccurrences = (await readFile(`${FIXTURES}occurrences.csv`, "utf8")).replaceAll("WSDA_", "BCBA_");
    expect(bcOccurrences).toContain("BCBA_2303966");
    zip = zipSync({
      "occurrences.csv": new TextEncoder().encode(bcOccurrences),
      "identifications.csv": new Uint8Array(await readFile(`${FIXTURES}identifications.csv`)),
    });
    const e = ecdysis();
    const r = await fetchEcdysis(conn, BC, { dir, credentials: CREDENTIALS, fetch: e.fetch, now: new Date("2026-10-09T10:00:00Z") });
    expect(r).toMatchObject({ scope: "collection 196", source: "downloaded" });
    expect(r.load).toMatchObject({ matched: 4, loaded: 6 });
    expect(describeFetch(r)).toMatch(/^collection 196 downloaded/);
    const probes = e.requests.filter((q) => q.startsWith("GET /api/v2/occurrence"));
    expect(probes).toHaveLength(2);
    for (const q of probes) {
      expect(q).toContain("collid=196");
      expect(q).not.toContain("datasetID");
    }
    const download = decodeURIComponent(e.requests.find((q) => q.startsWith("POST /collections/download/"))!);
    expect(download).toContain("identifications=1");
    expect(download).toContain("db=196");
    expect(download).not.toContain("datasetid");
    // Kept apart from Washington's, which is 44.zip.
    expect((await import("node:fs")).readdirSync(dir).sort()).toEqual(["collection-196.probe.json", "collection-196.read.json", "collection-196.zip"]);
    expect(JSON.parse(await readFile(join(dir, "collection-196.probe.json"), "utf8"))).toEqual({ collectionId: 196, total: 6, since: "2026-10-08", modifiedSince: 2 });
  });

  test("Washington's requests are unchanged by collections existing", async () => {
    const e = ecdysis();
    await fetchWith(e);
    for (const q of e.requests.filter((q) => q.startsWith("GET /api/v2/occurrence"))) {
      expect(q).toContain("datasetID=44");
      expect(q).not.toContain("collid");
    }
  });
});
