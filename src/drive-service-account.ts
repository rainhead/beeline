import { createSign } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

/**
 * Google Drive as Beeline's own identity: a service account, whose key is a
 * secret on the server (`BEELINE_DRIVE_KEY`), writing into a folder of a
 * shared drive that somebody with manager rights added it to (GitHub #126).
 * Not src/google-drive.ts, which reads Drive as the developer signed in to
 * gcloud on a workstation; nothing on the server is signed in as a person.
 *
 * Scoped to `drive.file`: the account sees only the files it created itself,
 * so even a key that leaked would reach the backups and nothing else on the
 * drive. Every call says `supportsAllDrives`, without which the API answers
 * as if a shared drive's files did not exist.
 */

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

/** The JSON key file Google issues for a service account, as the secret holds it. */
export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let parsed: Partial<ServiceAccountKey> & { type?: string };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    throw new Error("BEELINE_DRIVE_KEY is not JSON: it should be the service account's key file, whole");
  }
  if (parsed.type !== "service_account" || !parsed.client_email || !parsed.private_key) {
    throw new Error("BEELINE_DRIVE_KEY is not a service account key (it needs type, client_email and private_key)");
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    token_uri: parsed.token_uri ?? "https://oauth2.googleapis.com/token",
  };
}

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

const base64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** An hour's access token, from a JWT the key signs (Google's two-legged OAuth for service accounts). */
export async function serviceAccountToken(key: ServiceAccountKey, signal?: AbortSignal): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri, iat: now, exp: now + 3600 }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key, "base64url");
  const res = await fetch(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
    signal: withTimeout(signal, 30_000),
  });
  if (!res.ok) throw new Error(`Google refused the service account's sign-in (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** A file as Drive describes it, with what a backup is checked by. */
export interface DriveFile {
  id: string;
  name: string;
  size: number;
  md5Checksum: string | null;
  createdTime: string;
}

const FILE_FIELDS = "id, name, size, md5Checksum, createdTime";

interface RawFile {
  id: string;
  name: string;
  size?: string;
  md5Checksum?: string;
  createdTime: string;
}

const toFile = (f: RawFile): DriveFile => ({
  id: f.id,
  name: f.name,
  size: Number(f.size ?? 0),
  md5Checksum: f.md5Checksum ?? null,
  createdTime: f.createdTime,
});

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function check(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`Drive answered ${res.status} to ${what}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

/**
 * Upload a file into a folder in one request of a resumable session, the
 * route Drive asks for above 5 MB. Streamed from disk, never read into
 * memory: a copy of the main store is most of a hundred megabytes.
 */
export async function uploadFile(
  token: string,
  opts: { folderId: string; path: string; name: string; mimeType: string; signal?: AbortSignal },
): Promise<DriveFile> {
  const { size } = await stat(opts.path);
  const params = new URLSearchParams({ uploadType: "resumable", supportsAllDrives: "true", fields: FILE_FIELDS });
  const session = await check(
    await fetch(`${UPLOAD}?${params}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": opts.mimeType,
        "X-Upload-Content-Length": String(size),
      },
      body: JSON.stringify({ name: opts.name, parents: [opts.folderId], mimeType: opts.mimeType }),
      signal: withTimeout(opts.signal, 30_000),
    }),
    `starting the upload of ${opts.name}`,
  );
  const location = session.headers.get("Location");
  if (location === null) throw new Error(`Drive started no upload session for ${opts.name}`);
  const res = await check(
    await fetch(location, {
      method: "PUT",
      headers: { "Content-Type": opts.mimeType, "Content-Length": String(size) },
      body: Readable.toWeb(createReadStream(opts.path)) as ReadableStream,
      duplex: "half",
      // Generous: the sandbox's link is not the bottleneck, but a stalled
      // upload must end in a failed run rather than a job that never ends.
      signal: withTimeout(opts.signal, 30 * 60_000),
    } as RequestInit),
    `the upload of ${opts.name}`,
  );
  return toFile((await res.json()) as RawFile);
}

/** The files in a folder that this account can see (with drive.file: the ones it made), newest first. */
export async function listFolder(token: string, folderId: string, signal?: AbortSignal): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`,
      fields: `nextPageToken, files(${FILE_FIELDS})`,
      orderBy: "createdTime desc",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    const res = await check(
      await fetch(`${API}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: withTimeout(signal, 30_000),
      }),
      "listing the backup folder",
    );
    const page = (await res.json()) as { files: RawFile[]; nextPageToken?: string };
    files.push(...page.files.map(toFile));
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return files;
}

/**
 * Move a file to the drive's bin. Not a deletion, which a Content manager on
 * a shared drive is not allowed: the bin empties itself after 30 days.
 */
export async function trashFile(token: string, fileId: string, signal?: AbortSignal): Promise<void> {
  await check(
    await fetch(`${API}/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
      signal: withTimeout(signal, 30_000),
    }),
    `moving ${fileId} to the bin`,
  );
}
