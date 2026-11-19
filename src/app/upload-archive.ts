import { RECEIVED_FOLDER } from "../received-files.js";
import { serviceAccountToken, trashFile, uploadFile, type ServiceAccountKey } from "../drive-service-account.js";

/**
 * Where an uploaded file is kept besides the machine's disk (beeline-kgyd.1,
 * Peter, 2026-11-18): the Drive folder of received files, where the files
 * people send by email are kept too (src/received-files.ts). The disk copy is
 * not in the nightly backup, so a store put back from a backup could name a
 * file it no longer has; the Drive copy is the one that outlives the machine.
 *
 * The app is given one of these, or none. Only the server is given one, made
 * from the key the app's config already reads for the nightly backup
 * (`driveBackup.key`, src/app/config.ts). A workstation without that key, and
 * every test, has none, and keeps the file on disk only. Nothing here falls
 * back to the workstation's key file the way `pnpm received:store` does: a
 * developer's upload, or a test's, would then land in production's folder.
 */
export interface UploadArchive {
  /** Store the file and return its Drive id. Throws if it was not stored. */
  keep(file: KeptFile): Promise<string>;
  /** Move a stored file to the bin, for an upload that was not recorded after all. */
  discard(driveId: string): Promise<void>;
}

export interface KeptFile {
  /** The file on disk. */
  path: string;
  /** Its name in Drive. */
  name: string;
  /** What anyone browsing the folder reads about it. */
  description: string;
  /** Drive's app properties, which a program can search on. */
  properties: Record<string, string>;
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * How long an upload waits for Drive. The person is waiting for the page, and
 * a file is at most 20 MB, so a minute is generous; `uploadFile`'s own limit of
 * half an hour is for the store's backups.
 */
export const KEEP_TIMEOUT_MS = 60_000;

/**
 * The name a person browsing the folder finds the file by: the upload's id,
 * who sent it, the day, and what the file was called on their computer. The
 * id comes first so the files sort in the order they arrived.
 */
export const keptName = (uploadId: number, login: string, day: string, fileName: string): string =>
  `upload ${uploadId} ${login} ${day} ${fileName}`;

/** Keeps uploads in the received-files folder, as Beeline's service account. */
export function driveUploadArchive(key: ServiceAccountKey, folderId: string, timeoutMs = KEEP_TIMEOUT_MS): UploadArchive {
  // A test that built one would write into the real folder; the key is never
  // present under Vitest, and this makes sure of it.
  if (process.env.VITEST !== undefined) throw new Error("no upload is kept in Drive under Vitest");
  return {
    async keep(file) {
      const signal = AbortSignal.timeout(timeoutMs);
      const token = await serviceAccountToken(key, signal);
      const stored = await uploadFile(token, {
        folderId,
        path: file.path,
        name: file.name,
        mimeType: XLSX,
        metadata: { description: file.description, appProperties: file.properties },
        signal,
      });
      return stored.id;
    },
    async discard(driveId) {
      const signal = AbortSignal.timeout(timeoutMs);
      await trashFile(await serviceAccountToken(key, signal), driveId, signal);
    },
  };
}

/** The archive the server keeps uploads in: the received-files folder, when the app has the service account's key. */
export function serverUploadArchive(key: ServiceAccountKey | null): UploadArchive | null {
  return key === null || RECEIVED_FOLDER === null ? null : driveUploadArchive(key, RECEIVED_FOLDER);
}

/** A link a member of staff can open the kept copy by. */
export const driveFileHref = (driveId: string) => `https://drive.google.com/file/d/${encodeURIComponent(driveId)}/view`;
