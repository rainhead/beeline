import { execFileSync } from "node:child_process";

/**
 * Reading Google Drive as the signed-in developer: an access token from an
 * account signed in with `gcloud auth login --enable-gdrive-access`, or one
 * passed as GOOGLE_ACCESS_TOKEN. Shared by the worksheet export
 * (src/fetch-worksheets.ts) and the taxonomist's decisions
 * (src/fetch-taxon-decisions.ts), which read the same way.
 */

export const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function accessToken(): string {
  const fromEnv = process.env.GOOGLE_ACCESS_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
}

export async function drive(token: string, url: string): Promise<Response> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const hint = res.status === 403 ? " (is gcloud signed in with --enable-gdrive-access?)" : "";
    throw new Error(`Drive answered ${res.status} for ${url.split("?")[0]}${hint}: ${(await res.text()).slice(0, 300)}`);
  }
  return res;
}

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

export async function fileMeta(token: string, fileId: string): Promise<DriveFileMeta> {
  const q = new URLSearchParams({ fields: "id, name, mimeType, modifiedTime", supportsAllDrives: "true" });
  return (await (await drive(token, `https://www.googleapis.com/drive/v3/files/${fileId}?${q}`)).json()) as DriveFileMeta;
}

/**
 * A Google Sheet's tabs, each as its rows of cell text — the Sheets API,
 * which the Drive-scoped token reads as well. Rows come back with trailing
 * empty cells dropped and empty rows as [], so a reader indexes by header
 * and treats a missing cell as blank.
 */
export async function sheetTabs(token: string, fileId: string): Promise<{ title: string; rows: string[][] }[]> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${fileId}`;
  const meta = (await (await drive(token, `${base}?fields=sheets.properties.title`)).json()) as {
    sheets: { properties: { title: string } }[];
  };
  const tabs: { title: string; rows: string[][] }[] = [];
  for (const { properties: { title } } of meta.sheets) {
    const range = encodeURIComponent(`'${title.replaceAll("'", "''")}'`);
    const values = (await (await drive(token, `${base}/values/${range}?valueRenderOption=FORMATTED_VALUE`)).json()) as {
      values?: string[][];
    };
    tabs.push({ title, rows: (values.values ?? []).map((r) => r.map((c) => String(c ?? ""))) });
  }
  return tabs;
}
