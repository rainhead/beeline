import type { DuckDBConnection } from "@duckdb/node-api";
import { access, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openAppDb, type AppDb } from "../src/app/db.js";
import { storeFiles } from "../src/app/jobs/registry.js";
import { applySchema } from "../src/build-db.js";
import { deriveAreas } from "../src/derive-area.js";
import { deriveLocalities } from "../src/derive-locality.js";
import { legacyExportPath, writeLegacyExport } from "../src/legacy-export.js";
import { loadEcdysis } from "../src/load-ecdysis.js";
import { snapshotCatalog, verifySnapshot } from "../src/store-snapshot.js";
import { buildTestGazetteer, insertCleanSample, rows } from "./helpers.js";

/**
 * The app's store, opened as the app opens it: its statements reach only the
 * files `storeFiles` names (beeline-pnqr.3). Each test under "still reaches"
 * is one of the things a job makes DuckDB do to a file, run under that limit,
 * because a file left off the list fails a night job and no page. The store
 * is a file, since the limit is about files and an in-memory store has none
 * of its own.
 */
let dir: string;
let app: AppDb;
let conn: DuckDBConnection;
let config: { dbPath: string; exportsDir: string; backupsDir: string; ecdysisDir: string };
let gazetteer: string;

const REFUSED = /file system operations are disabled by configuration/;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "beeline-file-limit-"));
  const data = join(dir, "data");
  await mkdir(join(data, "secrets"), { recursive: true });
  await writeFile(join(data, "secrets", "inat-oauth-token"), "a token\n");
  await writeFile(join(data, "corrections.csv"), "_id,field\n");
  config = {
    dbPath: join(data, "beeline.duckdb"),
    exportsDir: join(data, "exports"),
    backupsDir: join(data, "backups"),
    ecdysisDir: join(data, "ecdysis"),
  };
  gazetteer = join(data, "gazetteer.duckdb");
  await buildTestGazetteer(gazetteer, "build-limit");
  app = await openAppDb(config, storeFiles(config, gazetteer));
  conn = await app.instance.connect();
  await applySchema(conn);
  await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Adams')`);
  // Inside the test gazetteer's Alsea Wilderness.
  await insertCleanSample(conn, {}, { latitude: "44.50", longitude: "-123.60" });
});

afterAll(async () => {
  conn.closeSync();
  await app.close();
});

describe("the app's store refuses", () => {
  test("to read a file the app keeps beside it, such as the pipeline's token", async () => {
    await expect(conn.run(`SELECT content FROM read_text('${join(dir, "data", "secrets", "inat-oauth-token")}')`)).rejects.toThrow(REFUSED);
    await expect(conn.run(`SELECT * FROM read_csv('${join(dir, "data", "corrections.csv")}')`)).rejects.toThrow(REFUSED);
    await expect(conn.run(`SELECT * FROM glob('${join(dir, "data")}/*')`)).rejects.toThrow(REFUSED);
    await expect(conn.run(`SELECT content FROM read_text('/etc/hostname')`)).rejects.toThrow(REFUSED);
  });

  test("on a connection made afterwards too", async () => {
    const later = await app.instance.connect();
    try {
      await expect(later.run(`SELECT content FROM read_text('${join(dir, "data", "secrets", "inat-oauth-token")}')`)).rejects.toThrow(REFUSED);
    } finally {
      later.closeSync();
    }
  });

  test("a path that leaves an allowed folder by .. or by a symbolic link", async () => {
    await mkdir(config.exportsDir, { recursive: true });
    await symlink(join(dir, "data", "secrets"), join(config.exportsDir, "link"));
    await expect(conn.run(`SELECT content FROM read_text('${config.exportsDir}/../secrets/inat-oauth-token')`)).rejects.toThrow(REFUSED);
    await expect(conn.run(`SELECT content FROM read_text('${config.exportsDir}/link/inat-oauth-token')`)).rejects.toThrow(REFUSED);
  });

  test("to write or attach a file outside the allowed folders", async () => {
    await expect(conn.run(`COPY (SELECT 1 AS a) TO '${join(dir, "out.csv")}'`)).rejects.toThrow(REFUSED);
    await expect(conn.run(`ATTACH '${join(dir, "other.duckdb")}' AS other`)).rejects.toThrow(REFUSED);
    await expect(access(join(dir, "out.csv"))).rejects.toThrow();
  });

  test("to have the limit lifted or widened", async () => {
    await expect(conn.run("SET enable_external_access = true")).rejects.toThrow(/while database is running/);
    await expect(conn.run("SET allowed_directories = ['/']")).rejects.toThrow(/Cannot change allowed_directories/);
    await expect(conn.run("SET allowed_paths = ['/etc/hostname']")).rejects.toThrow(/Cannot change allowed_paths/);
  });

  test("to load an extension", async () => {
    await expect(conn.run("LOAD excel")).rejects.toThrow(/Loading external extensions is disabled/);
  });
});

describe("the app's store still reaches", () => {
  test("the legacy export's file", async () => {
    const path = legacyExportPath(config.exportsDir);
    await writeLegacyExport(conn, path);
    expect((await readFile(path, "utf8")).split("\n")[0]).toContain("fieldNumber");
  });

  test("the nightly backup's copy of the store", async () => {
    const [[catalog]] = (await rows(conn, "SELECT current_database()")) as [[string]];
    const run = join(config.backupsDir, "run-test");
    await mkdir(run, { recursive: true });
    const copy = join(run, "beeline.duckdb");
    const snapshot = await snapshotCatalog(conn, catalog, copy, null);
    expect(snapshot.tables["main.sample"]).toBe(1);
    await verifySnapshot(copy, null, snapshot);
  });

  test("an unpacked Ecdysis archive, and the determiners' spellings checked into git", async () => {
    await mkdir(config.ecdysisDir, { recursive: true });
    const unpacked = await mkdtemp(join(config.ecdysisDir, "1-unpacked-"));
    await cp(new URL("./fixtures/ecdysis/archive/", import.meta.url).pathname, unpacked, { recursive: true });
    // No determinerAliases given, so the file the nightly reads: ingest/determiner-aliases.csv.
    const result = await loadEcdysis(conn, { path: unpacked, catalogPrefix: "WSDA_" });
    expect(result.input).toBe("archive");
  });

  test("the gazetteer, for areas and for localities", async () => {
    const areas = await deriveAreas(conn, gazetteer);
    expect(areas).toMatchObject({ gazetteerBuild: "build-limit", inWilderness: 1 });
    const localities = await deriveLocalities(conn, gazetteer);
    expect(localities.gazetteerBuild).toBe("build-limit");
  });

  test("its own spill folder, when a sort is larger than memory", async () => {
    // About 500 MB of rows to sort in 200 MB, on two threads as production has.
    const [[limit, threads]] = (await rows(conn, "SELECT current_setting('memory_limit'), current_setting('threads')")) as [[string, bigint]];
    await conn.run("SET memory_limit = '200MB'");
    await conn.run("SET threads = 2");
    try {
      await conn.run(
        `CREATE TEMP TABLE sorted AS SELECT * FROM (SELECT md5(range::VARCHAR) AS h, repeat(md5(range::VARCHAR), 4) AS p FROM range(3000000)) ORDER BY h`,
      );
      expect(await rows(conn, "SELECT count(*)::INTEGER FROM sorted")).toEqual([[3_000_000]]);
    } finally {
      await conn.run("DROP TABLE IF EXISTS sorted");
      await conn.run(`SET threads = ${Number(threads)}`);
      await conn.run(`SET memory_limit = '${limit}'`);
    }
  });

  test("its own file, to checkpoint", async () => {
    await conn.run("CHECKPOINT");
  });
});
