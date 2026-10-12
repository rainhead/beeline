import type { DuckDBConnection } from "@duckdb/node-api";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { promisify } from "node:util";
import {
  listFolder,
  serviceAccountToken,
  trashFile,
  uploadFile,
  type DriveFile,
  type ServiceAccountKey,
} from "./drive-service-account.js";
import { snapshotCatalog, verifySnapshot, type Snapshot } from "./store-snapshot.js";

/**
 * The nightly backup (beeline-elf, GitHub #126): both stores and the authored
 * files a rebuild cannot reconstruct, as one archive in the Bee Line folder on
 * the OSU shared drive, for recovery only — nobody opens these.
 *
 * One file a night, `beeline-backup-<UTC instant>.tar.gz`, holding
 *
 *   beeline.duckdb    a consistent copy of the main store (src/store-snapshot.ts)
 *   private.duckdb    the same of the private store, encrypted with the key the
 *                     running app uses (ADR 0003) — never anything weaker
 *   authored/*.csv    the overlays and change logs, as they stand on the volume
 *   manifest.json     what the copies held and the hash of every file, which is
 *                     what `pnpm backup:check` checks a downloaded archive against
 *
 * Restoring is extracting it and putting each file back where the app reads
 * it; the copies are ordinary stores the app opens as they are.
 *
 * Each step is checked rather than trusted, because a backup that only looks
 * like one is the failure this exists to prevent: the copies are reopened on
 * an instance of their own and their rows and schema counted, and the size
 * and MD5 Drive computed for the upload must match the local file's — an
 * upload that does not is moved to the bin before the run fails. Only then
 * are old copies moved to the bin by the retention rule.
 */

const execFileAsync = promisify(execFile);

export const BACKUP_MIME = "application/gzip";
const NAME = /^beeline-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tar\.gz$/;

/** The archive's name for an instant: sortable, and the only name the retention rule will touch. */
export function backupName(at: Date): string {
  return `beeline-backup-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.tar.gz`;
}

/** When a backup was taken, read off its name; null for any file this job did not name. */
export function backupTakenAt(name: string): Date | null {
  const m = NAME.exec(name);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

/** How long copies are kept (Peter, 2026-10-12, on #126). */
export const RETENTION = { days: 14, months: 12 } as const;

/**
 * Which copies the retention rule lets go: every copy younger than
 * `RETENTION.days` is kept, and so is the first copy of each of the last
 * `RETENTION.months` calendar months (UTC) — the first that exists, so a month
 * whose 1st failed keeps its 2nd. A file whose name this job did not write is
 * never returned, whatever else is in the folder.
 */
export function backupsToTrash<F extends { name: string }>(files: F[], now: Date, keep = RETENTION): F[] {
  const dated = files.flatMap((f) => {
    const at = backupTakenAt(f.name);
    return at === null ? [] : [{ file: f, at }];
  });
  const monthOf = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
  const firstOfMonth = new Map<number, Date>();
  for (const { at } of dated) {
    const m = monthOf(at);
    const first = firstOfMonth.get(m);
    if (first === undefined || at < first) firstOfMonth.set(m, at);
  }
  const thisMonth = monthOf(now);
  return dated
    .filter(({ at }) => {
      if (now.getTime() - at.getTime() < keep.days * 86_400_000) return false;
      const m = monthOf(at);
      return !(thisMonth - m < keep.months && firstOfMonth.get(m)?.getTime() === at.getTime());
    })
    .map(({ file }) => file);
}

/** A file going into the archive: where it is, and what it is called inside. */
export interface ArchiveEntry {
  name: string;
  path: string;
}

/**
 * One ustar header. Written here rather than by shelling out to `tar` so the
 * archive is the same on a workstation and on the server whatever tar each
 * has, and needs nothing from the image; any tar reads it.
 */
function tarHeader(name: string, size: number, mtime: Date): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`archive member name too long for ustar: ${name}`);
  const h = Buffer.alloc(512);
  const field = (offset: number, length: number, value: string) => h.write(value, offset, length, "utf8");
  const octal = (offset: number, length: number, n: number) =>
    field(offset, length, `${n.toString(8).padStart(length - 1, "0")}\0`);
  field(0, 100, name);
  octal(100, 8, 0o600);
  octal(108, 8, 0);
  octal(116, 8, 0);
  // Eleven octal digits: 8 GiB, past which ustar cannot say the size and a
  // header written anyway would be silently wrong. Far off at ~275 MB.
  if (size >= 8 ** 11) throw new Error(`${name} is too large for a ustar archive (${size} bytes)`);
  octal(124, 12, size);
  octal(136, 12, Math.floor(mtime.getTime() / 1000));
  field(148, 8, " ".repeat(8));
  field(156, 1, "0");
  field(257, 6, "ustar\0");
  field(263, 2, "00");
  let sum = 0;
  for (const byte of h) sum += byte;
  field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

async function* tarStream(entries: ArchiveEntry[], mtime: Date): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    const { size } = await stat(entry.path);
    yield tarHeader(entry.name, size, mtime);
    let written = 0;
    for await (const chunk of createReadStream(entry.path)) {
      written += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
    // The header promised this many bytes; a file that changed size under the
    // read would make every member after it unreadable.
    if (written !== size) throw new Error(`${entry.name} changed size while it was being archived`);
    if (size % 512 !== 0) yield Buffer.alloc(512 - (size % 512));
  }
  yield Buffer.alloc(1024);
}

/**
 * Write a gzipped tar of the entries to `out`, by way of a temporary name, so
 * a run that dies half-way leaves nothing at `out` that reads as an archive.
 * Gzip at level 1: on the dev store it took the copy from 258 MB to 94 MB in
 * 2 s, where level 6 took 2.5 times as long to save another 4 MB.
 */
export async function writeArchive(entries: ArchiveEntry[], out: string, mtime = new Date()): Promise<void> {
  const partial = `${out}.partial`;
  await pipeline(Readable.from(tarStream(entries, mtime)), createGzip({ level: 1 }), createWriteStream(partial, { mode: 0o600 }));
  await rename(partial, out);
}

export async function fileHash(path: string, algorithm: "md5" | "sha256"): Promise<string> {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** What a backup says about itself, inside the archive. */
export interface BackupManifest {
  format: 1;
  takenAt: string;
  release: string | null;
  /** The DuckDB that wrote the copies, so a restorer knows what can open them. */
  duckdb: string;
  stores: Record<string, { encrypted: boolean } & Snapshot>;
  /** Every member but this one, by name, with its SHA-256 and size. */
  files: Record<string, { sha256: string; bytes: number }>;
  /** Authored files the app is configured to write and has not (yet): named, so absence is never silent. */
  absent: string[];
}

export const MANIFEST = "manifest.json";

export interface BackupOptions {
  /** Where the copies and the archive are written while a run is in progress. Emptied afterwards. */
  workDir: string;
  /** The main store's catalog, and the private store's. */
  catalogs: { main: string; private: string };
  /** The private store's key; null only in development, where the store is unencrypted too. */
  privateKey: string | null;
  /** The authored files to carry, by their path on this machine. */
  authored: string[];
  release: string | null;
  drive: { key: ServiceAccountKey; folderId: string };
  step: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface BackupResult {
  name: string;
  bytes: number;
  tables: number;
  rows: number;
  authored: number;
  absent: string[];
  trashed: string[];
  kept: number;
  /** Work directories left by runs the process did not survive, removed at the start of this one. */
  staleRemoved: number;
}

/**
 * Take the stores' copies and the authored files into one archive and put
 * it in the folder. Throws, failing the job, at the first thing that is not
 * as it should be; the work directory is emptied whatever happens.
 */
export async function backUp(conn: DuckDBConnection, opts: BackupOptions): Promise<BackupResult> {
  const now = opts.now ?? (() => new Date());
  const takenAt = now();
  const name = backupName(takenAt);
  // A failure says which step it was in: on /jobs, "fetch failed" alone
  // does not say whether Drive or Google's sign-in was unreachable.
  const step = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
    opts.step(label, fn).catch((err: unknown) => {
      throw new Error(`${label}: ${(err as Error).message}`, { cause: err });
    });
  await mkdir(opts.workDir, { recursive: true, mode: 0o700 });
  // A run the process did not survive — killed for memory, a machine
  // restarted mid-copy — never reached its own clean-up, and left a few
  // hundred megabytes that nothing else would ever remove.
  const stale = (await readdir(opts.workDir)).filter((d) => d.startsWith("run-"));
  for (const d of stale) await rm(join(opts.workDir, d), { recursive: true, force: true });
  const work = await mkdtemp(join(opts.workDir, "run-"));
  try {
    const stores: BackupManifest["stores"] = {};
    const copies = [
      { file: "beeline.duckdb", catalog: opts.catalogs.main, key: null },
      { file: "private.duckdb", catalog: opts.catalogs.private, key: opts.privateKey },
    ];
    for (const copy of copies) {
      const path = join(work, copy.file);
      const snapshot = await step(`copy ${copy.file}`, () => snapshotCatalog(conn, copy.catalog, path, copy.key));
      await step(`reopen ${copy.file}`, () => verifySnapshot(path, copy.key, snapshot));
      stores[copy.file] = { encrypted: copy.key !== null, ...snapshot };
    }
    const [[duckdb]] = (await (await conn.run("SELECT version()")).getRows()) as [[string]];

    const entries: ArchiveEntry[] = copies.map((c) => ({ name: c.file, path: join(work, c.file) }));
    const absent: string[] = [];
    await step("gather authored files", async () => {
      await mkdir(join(work, "authored"));
      const seen = new Set<string>();
      for (const source of opts.authored) {
        const member = `authored/${basename(source)}`;
        if (seen.has(member)) throw new Error(`two authored files would both be ${member} in the archive`);
        seen.add(member);
        // Read whole and written once: a file the app appends to while it is
        // copied lands in the archive as it stood at one moment, and its hash
        // in the manifest is of exactly that.
        let content: Buffer;
        try {
          content = await readFile(source);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            absent.push(basename(source));
            continue;
          }
          throw err;
        }
        const path = join(work, member);
        await writeFile(path, content, { mode: 0o600 });
        entries.push({ name: member, path });
      }
    });

    const files: BackupManifest["files"] = {};
    for (const entry of entries) {
      files[entry.name] = { sha256: await fileHash(entry.path, "sha256"), bytes: (await stat(entry.path)).size };
    }
    const manifest: BackupManifest = {
      format: 1,
      takenAt: takenAt.toISOString(),
      release: opts.release,
      duckdb,
      stores,
      files,
      absent,
    };
    const manifestPath = join(work, MANIFEST);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const archive = join(work, name);
    await step("write the archive", () => writeArchive([{ name: MANIFEST, path: manifestPath }, ...entries], archive, takenAt));
    const bytes = (await stat(archive)).size;
    const md5 = await fileHash(archive, "md5");

    const token = await step("sign in to Drive", () => serviceAccountToken(opts.drive.key, opts.signal));
    const uploaded = await step("upload", () =>
      uploadFile(token, { folderId: opts.drive.folderId, path: archive, name, mimeType: BACKUP_MIME, signal: opts.signal }),
    );
    const listed = await step("confirm the upload", async () => {
      const found = await listFolder(token, opts.drive.folderId, opts.signal);
      try {
        confirmUpload(found, uploaded, { bytes, md5 });
      } catch (err) {
        // A file that failed its check must not stay in the folder under a
        // backup's name: the retention rule keeps the FIRST copy of each
        // month, so a bad upload on the 1st, followed by a good retry, would
        // be the month's copy kept for a year.
        await trashFile(token, uploaded.id, opts.signal).catch((trashErr: unknown) => {
          throw new Error(`${(err as Error).message}; and it could not be moved to the bin: ${(trashErr as Error).message}`);
        });
        throw err;
      }
      return found;
    });

    const trash = backupsToTrash(listed, takenAt);
    await step("move old copies to the bin", async () => {
      for (const file of trash) await trashFile(token, file.id, opts.signal);
    });

    const counts = Object.values(stores).flatMap((s) => Object.values(s.tables));
    return {
      name,
      bytes,
      tables: counts.length,
      rows: counts.reduce((a, b) => a + b, 0),
      authored: entries.length - copies.length,
      absent,
      trashed: trash.map((f) => f.name),
      kept: listed.length - trash.length,
      staleRemoved: stale.length,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * What Drive stored must be what was sent: Drive computes the MD5 from the
 * bytes it holds, so a match is the only evidence on offer that the bytes
 * there are the bytes here. And the folder, listed afterwards, must hold it,
 * since the retention rule is worked out from that listing. Holding it, not
 * leading with it: a listing a moment behind is no reason to fail a good copy.
 */
export function confirmUpload(listed: DriveFile[], uploaded: DriveFile, local: { bytes: number; md5: string }): void {
  if (uploaded.size !== local.bytes || uploaded.md5Checksum !== local.md5) {
    throw new Error(
      `${uploaded.name} on Drive is ${uploaded.size} bytes with MD5 ${uploaded.md5Checksum ?? "unknown"}; ` +
        `the archive sent was ${local.bytes} bytes with MD5 ${local.md5}`,
    );
  }
  if (!listed.some((f) => f.id === uploaded.id)) {
    throw new Error(`uploaded ${uploaded.name}, but the folder does not list it`);
  }
}

const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;

/** The run's detail on /jobs. */
export function describeBackup(r: BackupResult): string {
  return (
    `${r.name}, ${megabytes(r.bytes)}: ${r.tables} tables, ${r.rows} rows, ${r.authored} authored files` +
    (r.absent.length > 0 ? ` (not yet written: ${r.absent.join(", ")})` : "") +
    `; ${r.kept} copies in the folder` +
    (r.trashed.length > 0 ? `, ${r.trashed.length} older moved to the bin` : "") +
    (r.staleRemoved > 0 ? `; removed ${r.staleRemoved} work directory left by a run that did not finish` : "")
  );
}

export interface CheckResult {
  manifest: BackupManifest;
  /** Files whose hash matched the manifest. */
  files: number;
  /** Stores opened and counted; the private one only when its key was given. */
  storesOpened: string[];
}

/**
 * Check a downloaded archive the way a restore would use it (the drill in
 * docs/runbooks/deploy-fly.md): extract it with the system's own tar, which
 * is also the proof that tar reads what writeArchive writes; hash every file
 * against the manifest; and open each store on an instance of its own and
 * count its tables against what the backup said it copied. The private store
 * opens only with its key, and is reported as not opened without one, never
 * as fine.
 */
export async function checkBackup(archive: string, opts: { dir: string; privateKey: string | null }): Promise<CheckResult> {
  await mkdir(opts.dir, { recursive: true, mode: 0o700 });
  await execFileAsync("tar", ["-xzf", archive, "-C", opts.dir]);
  const manifest = JSON.parse(await readFile(join(opts.dir, MANIFEST), "utf8")) as BackupManifest;
  if (manifest.format !== 1) throw new Error(`${archive}: manifest format ${String(manifest.format)}, this checks format 1`);
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = join(opts.dir, name);
    const actual = await fileHash(path, "sha256");
    if (actual !== expected.sha256) throw new Error(`${name} does not match the manifest: SHA-256 ${actual}, expected ${expected.sha256}`);
  }
  const storesOpened: string[] = [];
  for (const [file, store] of Object.entries(manifest.stores)) {
    if (store.encrypted && opts.privateKey === null) continue;
    await verifySnapshot(join(opts.dir, file), store.encrypted ? opts.privateKey : null, store);
    storesOpened.push(file);
  }
  return { manifest, files: Object.keys(manifest.files).length, storesOpened };
}
