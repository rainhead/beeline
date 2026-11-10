import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseServiceAccountKey, serviceAccountToken, uploadFile } from "./drive-service-account.js";

/**
 * Files people send Beeline — a taxonomist's determinations, a staff
 * inventory, an atlas lead's corrections — kept in one folder on the
 * program's shared drive as they arrived, so that whatever a loader takes
 * from one can be traced back to the file itself, and the file read again
 * when a question comes up later.
 *
 * Storing is the first step for any file that arrives by email or by hand:
 * `pnpm received:store <file> --from "<who sent it>" --sent <instant>` uploads
 * it unconverted (a .xlsx stays a .xlsx, so the bytes are what was sent), sets
 * Drive's modified time to when it was sent, and writes who sent it into the
 * file's description, where anyone browsing the folder sees it. The Drive id
 * it prints is the file's name from then on.
 *
 * `pnpm received:fetch <drive-id> [dir]` downloads one into
 * `data/received/<id>/`, the file under its own name and `file.json` beside
 * it. A loader reads that directory: the Drive id, the name and the sent time
 * are its provenance, and what it could not place goes into the same
 * directory. `data/` is gitignored, and these files stay there: most of them
 * name people.
 *
 * Both act as Beeline's service account, the one the nightly backup uploads
 * as (src/drive-service-account.ts), and not as whoever is signed in to
 * gcloud: the shared drive is the program's, and with the `drive.file` scope
 * the account can read back exactly the files it stored. So the production
 * machine, which holds the key as `BEELINE_DRIVE_KEY`, fetches a file itself.
 * A workstation reads the same key from `data/secrets/drive-key.json`.
 */

/**
 * "Beeline received files", on the OSU shared drive. Empty until the service
 * account can create it there: it is a member of databaseBackups alone.
 */
export const RECEIVED_FOLDER: string | null = null;
export const RECEIVED_DIR = "data/received";
export const WORKSTATION_KEY = "data/secrets/drive-key.json";

/** What a fetched file's file.json holds. */
export interface ReceivedFile {
  /** The Drive file id. */
  id: string;
  /** The file's name in Drive, which is also its name in the directory. */
  name: string;
  mimeType: string;
  /** When it was sent, as stored: Drive's modified time, which storing sets. */
  modifiedTime: string;
  /** Who sent it, in the words storing was given. */
  from: string | null;
  description: string | null;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
};

/** The service account's token: its key from the environment, as on the server, or from the workstation's file. */
async function token(): Promise<string> {
  const fromEnv = process.env.BEELINE_DRIVE_KEY;
  let json: string;
  if (fromEnv !== undefined && fromEnv !== "") {
    json = fromEnv;
  } else {
    try {
      json = await readFile(WORKSTATION_KEY, "utf8");
    } catch {
      throw new Error(
        `no service account key: set BEELINE_DRIVE_KEY, or copy production's into ${WORKSTATION_KEY} (fly ssh console -C 'printenv BEELINE_DRIVE_KEY')`,
      );
    }
  }
  return serviceAccountToken(parseServiceAccountKey(json));
}

async function drive(accessToken: string, url: string): Promise<Response> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`Drive answered ${res.status} for ${url.split("?")[0]}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

export interface StoreOptions {
  file: string;
  from: string;
  /** When the sender sent it: an ISO 8601 instant, or a date. */
  sent: string;
  note?: string;
  folder?: string;
}

export async function storeReceived(opts: StoreOptions): Promise<{ id: string; name: string }> {
  if (opts.from.trim() === "") throw new Error("--from: who sent the file");
  const sent = new Date(opts.sent);
  if (Number.isNaN(sent.getTime())) throw new Error(`--sent: not a date or instant: ${opts.sent}`);
  const folderId = opts.folder ?? RECEIVED_FOLDER;
  if (folderId === null) throw new Error("the received-files folder does not exist yet (RECEIVED_FOLDER in src/received-files.ts)");
  const name = basename(opts.file);
  const description = [`Sent by ${opts.from.trim()} on ${sent.toISOString().slice(0, 10)}.`, opts.note?.trim()]
    .filter((s) => s !== undefined && s !== "")
    .join(" ");
  const stored = await uploadFile(await token(), {
    folderId,
    path: opts.file,
    name,
    mimeType: MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream",
    metadata: { modifiedTime: sent.toISOString(), description, appProperties: { from: opts.from.trim(), sent: sent.toISOString() } },
  });
  return { id: stored.id, name: stored.name };
}

export async function fetchReceived(id: string, dir = join(RECEIVED_DIR, id)): Promise<ReceivedFile & { dir: string }> {
  const accessToken = await token();
  const q = new URLSearchParams({ fields: "id, name, mimeType, modifiedTime, description, appProperties", supportsAllDrives: "true" });
  const meta = (await (await drive(accessToken, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?${q}`)).json()) as {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime: string;
    description?: string;
    appProperties?: { from?: string };
  };
  if (meta.name.includes("/") || meta.name === "file.json") throw new Error(`a name this directory cannot hold: ${meta.name}`);
  const bytes = new Uint8Array(
    await (await drive(accessToken, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`)).arrayBuffer(),
  );
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, meta.name), bytes);
  const file: ReceivedFile = {
    id: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    modifiedTime: meta.modifiedTime,
    from: meta.appProperties?.from ?? null,
    description: meta.description ?? null,
  };
  await writeFile(join(dir, "file.json"), `${JSON.stringify(file, null, 1)}\n`);
  return { ...file, dir };
}

/** A fetched directory: its file.json and the path of the file it names. */
export async function readReceived(dir: string): Promise<ReceivedFile & { path: string }> {
  const file = JSON.parse(await readFile(join(dir, "file.json"), "utf8")) as ReceivedFile;
  return { ...file, path: join(dir, file.name) };
}

// CLI: pnpm received:store <file> --from "<who sent it>" --sent <instant> [--note "<text>"]
//      pnpm received:fetch <drive-id> [dir]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, ...args] = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const valued = ["--from", "--sent", "--note"];
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1] ?? ""));
  if (command === "store" && positional[0] !== undefined) {
    const stored = await storeReceived({ file: positional[0], from: option("--from") ?? "", sent: option("--sent") ?? "", note: option("--note") });
    console.log(JSON.stringify(stored, null, 2));
  } else if (command === "fetch" && positional[0] !== undefined) {
    const fetched = await fetchReceived(positional[0], positional[1]);
    console.log(JSON.stringify(fetched, null, 2));
  } else {
    console.error('usage: pnpm received:store <file> --from "<who sent it>" --sent <instant> [--note "<text>"]\n       pnpm received:fetch <drive-id> [dir]');
    process.exit(2);
  }
}
