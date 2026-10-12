import { DuckDBInstance } from "@duckdb/node-api";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "../src/app/config.js";
import { attachPrivateStore } from "../src/app/db.js";
import { buildJobs } from "../src/app/jobs/registry.js";
import type { JobContext } from "../src/app/jobs/framework.js";
import type { DriveFile, ServiceAccountKey } from "../src/drive-service-account.js";
import {
  backUp,
  type BackupManifest,
  backupName,
  backupsToTrash,
  backupTakenAt,
  checkBackup,
  confirmUpload,
  writeArchive,
} from "../src/store-backup.js";
import { fillOrder, snapshotCatalog, verifySnapshot } from "../src/store-snapshot.js";
import { createMemoryDb, rows } from "./helpers.js";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const scratch = () => mkdtemp(join(tmpdir(), "beeline-backup-"));

/** A store from the real schema, with a taxonomy whose children sort ahead of their parents. */
async function storeWithData() {
  const { instance, conn } = await createMemoryDb();
  const dir = await scratch();
  await attachPrivateStore(instance, { path: join(dir, "private.duckdb"), key: KEY });
  // Ids chosen so the species is numbered below its genus and the genus
  // below its family: a copy that inserts the table in one statement, or in
  // id order, fails on the reference to a parent not yet copied.
  // One statement each: DuckDB will not take a row and its parent in one.
  await conn.run(`INSERT INTO animal (entity_id, parent_id, rank, scientific_name) VALUES (900, NULL, 'family', 'Apidae')`);
  await conn.run(`INSERT INTO animal (entity_id, parent_id, rank, scientific_name) VALUES (800, 900, 'genus', 'Bombus')`);
  await conn.run(`INSERT INTO animal (entity_id, parent_id, rank, scientific_name) VALUES (700, 800, 'species', 'Bombus vosnesenskii')`);
  await conn.run(`INSERT INTO person (display_name) VALUES ('A. Collector')`);
  await conn.run(`INSERT INTO private.session (id, inat_user_id, created_at, last_seen_at) VALUES ('s1', 1, now(), now())`);
  const [[catalog]] = (await rows(conn, "SELECT current_database()")) as [[string]];
  return { instance, conn, dir, catalog };
}

describe("a copy of a store", () => {
  it("fills every table after the tables it refers to", () => {
    const refs = [
      { table: "main.child", columns: ["p"], referencedTable: "main.parent", referencedColumns: ["id"] },
      { table: "main.parent", columns: ["up"], referencedTable: "main.parent", referencedColumns: ["id"] },
    ];
    expect(fillOrder(["main.child", "main.parent", "main.alone"], refs)).toEqual(["main.parent", "main.alone", "main.child"]);
    const cycle = [
      { table: "main.a", columns: ["b"], referencedTable: "main.b", referencedColumns: ["id"] },
      { table: "main.b", columns: ["a"], referencedTable: "main.a", referencedColumns: ["id"] },
    ];
    expect(() => fillOrder(["main.a", "main.b"], cycle)).toThrow(/cycle/);
  });

  it("holds every row, keeps the sequence where it was, and still enforces the schema", async () => {
    const { conn, dir, catalog } = await storeWithData();
    const [[next]] = (await rows(conn, "SELECT nextval('entity_id_seq')")) as [[bigint]];
    const path = join(dir, "copy.duckdb");
    const snap = await snapshotCatalog(conn, catalog, path, null);
    expect(snap.tables["main.animal"]).toBe(3);
    expect(snap.tables["main.person"]).toBe(1);
    await verifySnapshot(path, null, snap);

    const copy = await (await DuckDBInstance.create(path)).connect();
    // A restored store must not hand out an entity_id it already used.
    expect(await rows(copy, "SELECT nextval('entity_id_seq')")).toEqual([[next + 1n]]);
    expect(await rows(copy, "SELECT scientific_name FROM animal WHERE parent_id = 800")).toEqual([["Bombus vosnesenskii"]]);
    await expect(copy.run("INSERT INTO animal (parent_id, rank, scientific_name) VALUES (12345, 'genus', 'Nowhere')")).rejects.toThrow(
      /foreign key/i,
    );
    // Views and comments come across with the tables.
    expect((await rows(copy, "SELECT count(*) FROM duckdb_views() WHERE NOT internal"))[0]![0]).toBeGreaterThan(50n);
    expect((await rows(copy, "SELECT comment FROM duckdb_tables() WHERE table_name = 'animal'"))[0]![0]).toMatch(/curated taxonomy/);
  });

  it("encrypts the private store's copy with the store's own key", async () => {
    const { conn, dir } = await storeWithData();
    const path = join(dir, "private-copy.duckdb");
    const snap = await snapshotCatalog(conn, "private", path, KEY);
    expect(snap.tables["main.session"]).toBe(1);
    await verifySnapshot(path, KEY, snap);
    await expect(verifySnapshot(path, null, snap)).rejects.toThrow();
    // Not a byte of it in the clear.
    expect((await readFile(path)).includes(Buffer.from("A. Collector"))).toBe(false);
  });

  it("is refused when it does not hold what was copied into it", async () => {
    const { conn, dir, catalog } = await storeWithData();
    const path = join(dir, "copy.duckdb");
    const snap = await snapshotCatalog(conn, catalog, path, null);
    await expect(verifySnapshot(path, null, { ...snap, tables: { ...snap.tables, "main.animal": 4 } })).rejects.toThrow(/animal holds 3 rows, 4 were copied/);
    // And a copy that lost part of its schema without losing a row.
    const constraints = snap.shape.constraints + 1;
    await expect(verifySnapshot(path, null, { ...snap, shape: { ...snap.shape, constraints } })).rejects.toThrow(
      new RegExp(`${constraints - 1} constraints where the store has ${constraints}`),
    );
  });
});

describe("which copies are kept", () => {
  const now = new Date("2026-10-12T10:00:00Z");
  const night = (iso: string) => ({ name: backupName(new Date(iso)) });

  it("names a backup by its instant and reads the instant back", () => {
    const at = new Date("2026-10-12T10:15:07.123Z");
    expect(backupName(at)).toBe("beeline-backup-20261012T101507Z.tar.gz");
    expect(backupTakenAt(backupName(at))).toEqual(new Date("2026-10-12T10:15:07Z"));
    expect(backupTakenAt("beeline-authored-20261012.tar.gz")).toBeNull();
  });

  it("keeps two weeks of nights and the first copy of each of the last twelve months", () => {
    const files = [
      night("2026-10-11T10:00:00Z"), // yesterday
      night("2026-09-29T10:00:00Z"), // 13 days: kept
      night("2026-09-27T10:00:00Z"), // 15 days, not September's first: goes
      night("2026-09-01T10:00:00Z"), // September's first
      night("2026-08-02T10:00:00Z"), // August's first, since the 1st failed
      night("2026-08-03T10:00:00Z"), // goes
      night("2025-11-01T10:00:00Z"), // eleven months back: kept
      night("2025-10-01T10:00:00Z"), // twelve months back: goes
      { name: "someone-elses-file.pdf" }, // never touched
    ];
    expect(backupsToTrash(files, now).map((f) => f.name)).toEqual([
      backupName(new Date("2026-09-27T10:00:00Z")),
      backupName(new Date("2026-08-03T10:00:00Z")),
      backupName(new Date("2025-10-01T10:00:00Z")),
    ]);
  });
});

describe("the archive", () => {
  it("is read by the system's tar, every member whole", async () => {
    const dir = await scratch();
    // An ordinary member, one whose size is a multiple of the block, and one that is empty.
    const members: [string, Buffer][] = [
      ["manifest.json", Buffer.from("{}\n")],
      ["authored/a.csv", Buffer.from("a,b\n1,2\n")],
      ["block.bin", Buffer.alloc(512, 7)],
      ["authored/empty.csv", Buffer.alloc(0)],
    ];
    const entries = [];
    for (const [i, [name, content]] of members.entries()) {
      await writeFile(join(dir, `m${i}`), content);
      entries.push({ name, path: join(dir, `m${i}`) });
    }
    const archive = join(dir, "x.tar.gz");
    await writeArchive(entries, archive);
    expect(execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n")).toEqual(members.map(([n]) => n));
    await mkdir(join(dir, "out"));
    execFileSync("tar", ["-xzf", archive, "-C", join(dir, "out")]);
    for (const [name, content] of members) expect(await readFile(join(dir, "out", name))).toEqual(content);
  });
});

describe("the upload", () => {
  const uploaded: DriveFile = { id: "new", name: "b.tar.gz", size: 10, md5Checksum: "abc", createdTime: "" };

  it("must hold the bytes that were sent, and be in the folder", () => {
    expect(() => confirmUpload([uploaded], uploaded, { bytes: 10, md5: "abc" })).not.toThrow();
    // Listed, if not first: a listing a moment behind does not fail a good copy.
    expect(() => confirmUpload([{ ...uploaded, id: "old" }, uploaded], uploaded, { bytes: 10, md5: "abc" })).not.toThrow();
    expect(() => confirmUpload([{ ...uploaded, id: "old" }], uploaded, { bytes: 10, md5: "abc" })).toThrow(/does not list it/);
    expect(() => confirmUpload([uploaded], uploaded, { bytes: 10, md5: "abd" })).toThrow(/MD5/);
    expect(() => confirmUpload([uploaded], uploaded, { bytes: 11, md5: "abc" })).toThrow(/10 bytes/);
  });
});

/**
 * Drive as far as the backup uses it: the token endpoint, a resumable upload,
 * the folder listing and the bin. Files it holds are whatever it was sent, so
 * the MD5 it reports is computed, not assumed.
 */
function fakeDrive(folderId: string, existing: string[], opts: { corrupt?: boolean } = {}) {
  const files = existing.map((name, i) => ({
    id: `old${i}`,
    name,
    size: 1,
    md5Checksum: "x",
    createdTime: backupTakenAt(name)!.toISOString(),
    trashed: false,
    parent: folderId,
    bytes: Buffer.alloc(0),
  }));
  let uploading: { name: string; parent: string } | null = null;
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "token" });
    if (url.searchParams.get("uploadType") === "resumable") {
      const meta = JSON.parse(String(init.body)) as { name: string; parents: string[] };
      uploading = { name: meta.name, parent: meta.parents[0]! };
      return new Response(null, { status: 200, headers: { Location: "https://upload.example/session" } });
    }
    if (url.host === "upload.example" && method === "PUT") {
      const bytes = Buffer.from(await new Response(init.body as ReadableStream).arrayBuffer());
      const stored = opts.corrupt ? bytes.subarray(1) : bytes;
      const file = {
        id: "new",
        name: uploading!.name,
        size: stored.length,
        md5Checksum: createHash("md5").update(stored).digest("hex"),
        createdTime: new Date().toISOString(),
        trashed: false,
        parent: uploading!.parent,
        bytes: stored,
      };
      files.push(file);
      return Response.json({ id: file.id, name: file.name, md5Checksum: file.md5Checksum, createdTime: file.createdTime, size: String(file.size) });
    }
    if (method === "PATCH") {
      const id = url.pathname.split("/").pop()!;
      files.find((f) => f.id === id)!.trashed = true;
      return Response.json({});
    }
    if (method === "GET" && url.pathname === "/drive/v3/files") {
      const listed = files
        .filter((f) => !f.trashed && f.parent === folderId)
        .sort((a, b) => b.createdTime.localeCompare(a.createdTime))
        .map((f) => ({ id: f.id, name: f.name, md5Checksum: f.md5Checksum, createdTime: f.createdTime, size: String(f.size) }));
      return Response.json({ files: listed });
    }
    return new Response("not faked", { status: 500 });
  };
  return { files, fetchImpl };
}

function testServiceAccount(): ServiceAccountKey {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    client_email: "backup@test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    token_uri: "https://oauth2.googleapis.com/token",
  };
}

describe("a night's backup", () => {
  afterEach(() => vi.unstubAllGlobals());

  const run = async (drive: ReturnType<typeof fakeDrive>, now: Date, before?: (dir: string) => Promise<void>) => {
    vi.stubGlobal("fetch", drive.fetchImpl);
    const { conn, dir, catalog } = await storeWithData();
    await writeFile(join(dir, "person-change.csv"), "when,person_ref\n");
    await before?.(dir);
    const result = await backUp(conn, {
      workDir: join(dir, "work"),
      catalogs: { main: catalog, private: "private" },
      privateKey: KEY,
      authored: [join(dir, "person-change.csv"), join(dir, "corrections.csv")],
      release: "deployment-test",
      drive: { key: testServiceAccount(), folderId: "folder" },
      step: (_label, fn) => fn(),
      now: () => now,
    });
    return { result, dir };
  };

  it("uploads one archive that restores, and moves what the retention rule lets go to the bin", async () => {
    const now = new Date("2026-10-12T10:00:00Z");
    const drive = fakeDrive("folder", [
      backupName(new Date("2026-10-11T10:00:00Z")),
      backupName(new Date("2026-09-20T10:00:00Z")),
      backupName(new Date("2026-09-01T10:00:00Z")),
    ]);
    // What a run the process did not survive leaves behind.
    const { result, dir } = await run(drive, now, async (d) => {
      await mkdir(join(d, "work", "run-killed"), { recursive: true });
      await writeFile(join(d, "work", "run-killed", "beeline.duckdb"), "half a copy");
    });

    expect(result.name).toBe("beeline-backup-20261012T100000Z.tar.gz");
    expect(result.staleRemoved).toBe(1);
    expect(result.absent).toEqual(["corrections.csv"]);
    expect(result.trashed).toEqual([backupName(new Date("2026-09-20T10:00:00Z"))]);
    expect(result.kept).toBe(3);

    // What Drive holds is a backup `pnpm backup:check` accepts, both stores opened.
    const archive = join(dir, "downloaded.tar.gz");
    await writeFile(archive, drive.files.find((f) => f.id === "new")!.bytes);
    const checked = await checkBackup(archive, { dir: join(dir, "restored"), privateKey: KEY });
    expect(checked.storesOpened).toEqual(["beeline.duckdb", "private.duckdb"]);
    expect(checked.manifest.release).toBe("deployment-test");
    expect(checked.manifest.absent).toEqual(["corrections.csv"]);
    expect(checked.manifest.duckdb).toMatch(/^v\d/);
    expect(await readFile(join(dir, "restored", "authored", "person-change.csv"), "utf8")).toBe("when,person_ref\n");
    // And the work directory is left empty.
    expect(await readdir(join(dir, "work"))).toEqual([]);
  });

  it("is refused by backup:check once its manifest or its files have been tampered with", async () => {
    const drive = fakeDrive("folder", []);
    const { dir } = await run(drive, new Date("2026-10-12T10:00:00Z"));
    const original = join(dir, "downloaded.tar.gz");
    await writeFile(original, drive.files.find((f) => f.id === "new")!.bytes);
    const unpacked = join(dir, "unpacked");
    await mkdir(unpacked);
    execFileSync("tar", ["-xzf", original, "-C", unpacked]);
    const manifest = JSON.parse(await readFile(join(unpacked, "manifest.json"), "utf8")) as BackupManifest;
    const members = ["manifest.json", ...Object.keys(manifest.files)];
    let n = 0;
    // Repack the night's files under an edited manifest, and check the result.
    const tampered = async (edit: (m: BackupManifest) => void, extra: string[] = []) => {
      const m = structuredClone(manifest);
      edit(m);
      await writeFile(join(unpacked, "manifest.json"), JSON.stringify(m));
      const out = join(dir, `tampered-${++n}.tar.gz`);
      await writeArchive([...members, ...extra].map((name) => ({ name, path: join(unpacked, name) })), out);
      return checkBackup(out, { dir: join(dir, `check-${n}`), privateKey: KEY });
    };

    // Repacked unchanged, it passes: what fails below fails for its edit.
    await expect(tampered(() => undefined)).resolves.toMatchObject({ storesOpened: ["beeline.duckdb", "private.duckdb"] });
    await expect(tampered((m) => (m.files["authored/person-change.csv"]!.sha256 = "0".repeat(64)))).rejects.toThrow(
      /person-change\.csv does not match/,
    );
    await expect(tampered((m) => (m.files["../person-change.csv"] = m.files["authored/person-change.csv"]!))).rejects.toThrow(
      /not a path inside the archive/,
    );
    await expect(tampered((m) => delete m.files["beeline.duckdb"])).rejects.toThrow(/gives no hash for beeline\.duckdb/);
    await expect(
      tampered((m) => {
        m.stores = {};
        m.files = {};
      }),
    ).rejects.toThrow(/describes no beeline\.duckdb or private\.duckdb/);
    await writeFile(join(unpacked, "stray.txt"), "not in the manifest");
    await expect(tampered(() => undefined, ["stray.txt"])).rejects.toThrow(/holds stray\.txt, which the manifest does not hash/);
  });

  it("fails, naming the step, when the file Drive holds is not the file that was sent, and bins that file", async () => {
    const old = backupName(new Date("2026-08-15T10:00:00Z"));
    const drive = fakeDrive("folder", [old], { corrupt: true });
    await expect(run(drive, new Date("2026-10-12T10:00:00Z"))).rejects.toThrow(/^confirm the upload: .*the archive sent was/);
    // The bad upload must not stay under a backup's name, where it could be
    // the month's copy kept for a year; and retention, which never ran, has
    // binned nothing else.
    expect(drive.files.filter((f) => f.trashed).map((f) => f.id)).toEqual(["new"]);
  });
});

describe("the job", () => {
  const ctx = { conn: {} as JobContext["conn"], step: (_: string, fn: () => Promise<unknown>) => fn() } as unknown as JobContext;
  const job = (
    environment: "development" | "sandbox",
    driveBackup: { key: ServiceAccountKey; folderId: string } | null = null,
    privateDbKey: string | null = null,
  ) =>
    buildJobs({
      syncProjects: [],
      sweepDays: 365,
      personChangesPath: "unused.csv",
      sampleChangesPath: "unused.csv",
      sampleStatePath: "unused.csv",
      environment,
      driveBackup,
      privateDbKey,
    }).find((j) => j.name === "store-backup")!;

  it("fails outside development when it has nowhere to go, rather than succeeding at nothing", async () => {
    await expect(job("sandbox").run(ctx)).rejects.toThrow(/nothing was backed up/);
    await expect(job("development").run(ctx)).resolves.toMatch(/nothing backed up/);
  });

  it("refuses, outside development, to back up the private store without its key", async () => {
    const drive = { key: testServiceAccount(), folderId: "f" };
    await expect(job("sandbox", drive, null).run(ctx)).rejects.toThrow(/refusing to back up the private store unencrypted/);
  });

  it("runs ahead of the Sunday sweep, so a long sweep cannot push it past the night window", () => {
    const names = buildJobs({
      syncProjects: [],
      sweepDays: 365,
      personChangesPath: "unused.csv",
      sampleChangesPath: "unused.csv",
      sampleStatePath: "unused.csv",
    }).map((j) => j.name);
    expect(names.indexOf("store-backup")).toBeLessThan(names.indexOf("weekly-sweep"));
  });

  it("is configured from a key and a folder, set together", () => {
    const base = { BEELINE_ENV: "development" };
    const key = JSON.stringify({ type: "service_account", ...testServiceAccount() });
    expect(configFromEnv({ ...base, BEELINE_DRIVE_KEY: key, BEELINE_BACKUP_FOLDER: "f" }).driveBackup?.folderId).toBe("f");
    expect(configFromEnv(base).driveBackup).toBeNull();
    expect(() => configFromEnv({ ...base, BEELINE_DRIVE_KEY: key })).toThrow(/set together/);
    expect(() => configFromEnv({ ...base, BEELINE_BACKUP_FOLDER: "f" })).toThrow(/set together/);
    expect(() => configFromEnv({ ...base, BEELINE_DRIVE_KEY: "{}", BEELINE_BACKUP_FOLDER: "f" })).toThrow(/not a service account key/);
  });
});
