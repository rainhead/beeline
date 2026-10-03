import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { accessToken, drive, SHEET_MIME as SHEET, XLSX_MIME as XLSX } from "./google-drive.js";
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
 * to look in all drives. Authentication is gcloud's (src/google-drive.ts).
 * The export holds volunteers' names and belongs under data/, which is
 * gitignored.
 */

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
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
