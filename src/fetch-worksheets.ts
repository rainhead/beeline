import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_DIR, type WorksheetFile } from "./load-worksheets.js";

/**
 * Export the volunteer determination worksheets (beeline-pbk) from their
 * Drive folder: each Google Sheet as .xlsx, each uploaded .xlsx as it is, and
 * a files.json naming every file with the modification time the loader orders
 * a determiner's copies by. Anything else in the folder — a zip, an
 * OpenDocument file named .xlsx — is listed with no file, so the loader can
 * say it was there and was not read.
 *
 * The folder is on a shared drive, which the Drive API lists only when asked
 * to look in all drives. Authentication is gcloud's: an access token from an
 * account signed in with `gcloud auth login --enable-gdrive-access`, or one
 * passed as GOOGLE_ACCESS_TOKEN. The export holds volunteers' names and
 * belongs under data/, which is gitignored.
 */

const SHEET = "application/vnd.google-apps.spreadsheet";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

function accessToken(): string {
  const fromEnv = process.env.GOOGLE_ACCESS_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
}

async function drive(token: string, url: string): Promise<Response> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const hint = res.status === 403 ? " (is gcloud signed in with --enable-gdrive-access?)" : "";
    throw new Error(`Drive answered ${res.status} for ${url.split("?")[0]}${hint}: ${(await res.text()).slice(0, 300)}`);
  }
  return res;
}

export async function fetchWorksheets(folderId: string, dir: string): Promise<WorksheetFile[]> {
  const token = accessToken();
  const listed: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: "allDrives",
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime)",
    });
    if (pageToken !== undefined) q.set("pageToken", pageToken);
    const page = (await (await drive(token, `https://www.googleapis.com/drive/v3/files?${q}`)).json()) as {
      files: DriveFile[];
      nextPageToken?: string;
    };
    listed.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);

  await mkdir(dir, { recursive: true });
  const out: WorksheetFile[] = [];
  for (const f of listed.sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime) || a.id.localeCompare(b.id))) {
    const url =
      f.mimeType === SHEET
        ? `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=${encodeURIComponent(XLSX)}&supportsAllDrives=true`
        : f.mimeType === XLSX
          ? `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`
          : null;
    let file: string | null = null;
    if (url !== null) {
      const bytes = new Uint8Array(await (await drive(token, url)).arrayBuffer());
      // An .xlsx is a zip; an upload that only carries the extension is not.
      if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes.length > 0) {
        file = `${f.id}.xlsx`;
        await writeFile(join(dir, file), bytes);
      }
    }
    out.push({ ...f, file });
  }
  await writeFile(join(dir, "files.json"), `${JSON.stringify(out, null, 1)}\n`);
  return out;
}

// CLI: pnpm worksheets:fetch <drive-folder-id> [export-dir]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [folderId, dir] = process.argv.slice(2);
  if (folderId === undefined) {
    console.error("usage: pnpm worksheets:fetch <drive-folder-id> [export-dir]");
    process.exit(2);
  }
  const files = await fetchWorksheets(folderId, dir ?? DEFAULT_DIR);
  console.log(JSON.stringify({ files: files.length, exported: files.filter((f) => f.file !== null).length }, null, 2));
}
