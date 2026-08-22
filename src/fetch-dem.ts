import { DuckDBInstance } from "@duckdb/node-api";
import { spawn } from "node:child_process";
import { mkdir, writeFile, access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tileNameFor } from "./derive-elevation.js";

/**
 * Fetch the SRTM tiles that elevation derivation needs into data/dem/,
 * rsynced from the legacy server's archive (requires `beeline` in
 * ~/.ssh/config, like scripts/fetch-legacy.sh). Self-scoping: the tile set
 * is computed from the database's current elevation gaps, so a fresh dev
 * environment fetches only what its data needs, and a later run picks up
 * tiles for newly cleared elevations. Tiles already present are skipped by
 * rsync. Prints tiles the server does not have — those gaps stay NULL.
 */

const REMOTE = "beeline:/root/app/OBP-Server/shared/data/elevation/";

export async function neededTiles(dbPath: string): Promise<string[]> {
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const rows = (await (
    await conn.run(
      `SELECT DISTINCT latitude, longitude FROM sample_location WHERE elevation_m IS NULL`,
    )
  ).getRows()) as Array<[number, number]>;
  conn.closeSync();
  return [...new Set(rows.map(([lat, lon]) => tileNameFor(lat, lon)))].sort();
}

// CLI: pnpm elevation:fetch [db] [demDir]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? "beeline.duckdb";
  const demDir = process.argv[3] ?? "data/dem";
  await mkdir(demDir, { recursive: true });
  const tiles = await neededTiles(dbPath);
  const absent: string[] = [];
  const toFetch: string[] = [];
  for (const tile of tiles) {
    try {
      await access(`${demDir}/${tile}`);
    } catch {
      toFetch.push(tile);
    }
  }
  console.error(`${tiles.length} tiles needed, ${toFetch.length} to fetch`);
  if (toFetch.length > 0) {
    const listPath = `${demDir}/.fetch-list`;
    await writeFile(listPath, toFetch.join("\n") + "\n");
    const rsync = spawn("rsync", ["-a", `--files-from=${listPath}`, REMOTE, demDir], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    // A null close code means rsync died on a signal — never success.
    const code = await new Promise<number>((resolve) => rsync.on("close", (c) => resolve(c ?? 1)));
    // 23/24: partial transfer — tiles the server lacks; the post-check below
    // reports exactly which. (macOS rsync predates --ignore-missing-args.)
    if (code !== 0 && code !== 23 && code !== 24) {
      console.error(`rsync exited ${code}`);
      process.exit(code);
    }
    for (const tile of toFetch) {
      try {
        await access(`${demDir}/${tile}`);
      } catch {
        absent.push(tile);
      }
    }
  }
  console.log(JSON.stringify({ needed: tiles.length, fetched: toFetch.length - absent.length, absentOnServer: absent }, null, 2));
}
