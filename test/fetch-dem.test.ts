// The nightly fetching its own DEM tiles (beeline-z08): what it asks for, the
// limit on one run, and that a failed fetch never fails the run. The sources
// are faked; the bytes are not a real tile, since nothing here derives.
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, test } from "vitest";
import { refreshTiles } from "../src/app/jobs/registry.js";
import { glo30Url, srtmUrl } from "../src/fetch-dem.js";
import { createMemoryDb, insertCleanSample } from "./helpers.js";

let conn: DuckDBConnection;
let demDir: string;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
  demDir = await mkdtemp(join(tmpdir(), "dem-"));
});

/** A sample waiting for an elevation, on the tile whose southwest corner is (lat, lon). */
async function pending(n: number, lat: number, lon: number): Promise<void> {
  await insertCleanSample(conn, { sample_number: `'${n}'` }, {
    latitude: String(lat + 0.5),
    longitude: String(lon + 0.5),
    elevation_m: "NULL",
  });
}

/** Sources that hold the given URLs and answer 404 for anything else, recording each request. */
function sources(have: string[], asked: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    return have.includes(url) ? new Response("tile bytes") : new Response(null, { status: 404 });
  }) as typeof fetch;
}

describe("refreshTiles", () => {
  test("fetches a missing tile, from GLO-30 where SRTM lacks it, and says nothing when there is nothing to do", async () => {
    await pending(1, 44, -124);
    await pending(2, 60, -136);
    const fetchImpl = sources([srtmUrl("n44_w124"), glo30Url("n60_w136")]);
    expect(await refreshTiles(conn, demDir, { fetchImpl })).toBe("2 elevation tile(s) fetched");
    expect((await readdir(demDir)).sort()).toHaveLength(2);
    // The tiles are on disk now, so a second run asks for nothing.
    const asked: string[] = [];
    expect(await refreshTiles(conn, demDir, { fetchImpl: sources([], asked) })).toBeNull();
    expect(asked).toEqual([]);
  });

  test("stops at the limit and says how many wait, and a tile neither source has does not count against it", async () => {
    await pending(1, 10, -150); // open ocean: neither source has it
    await pending(2, 44, -124);
    await pending(3, 45, -124);
    await pending(4, 46, -124);
    const fetchImpl = sources([srtmUrl("n44_w124"), srtmUrl("n45_w124"), srtmUrl("n46_w124")]);
    expect(await refreshTiles(conn, demDir, { fetchImpl, limit: 2 })).toBe(
      "2 elevation tile(s) fetched, 1 left for the next run",
    );
    expect(await refreshTiles(conn, demDir, { fetchImpl, limit: 2 })).toBe("1 elevation tile(s) fetched");
  });

  test("an outage is reported in the detail rather than failing the run", async () => {
    await pending(1, 44, -124);
    const down = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    expect(await refreshTiles(conn, demDir, { fetchImpl: down })).toMatch(
      /^elevation tile fetch failed \(n44_w124 from .*: HTTP 503\); deriving from the tiles on disk$/,
    );
    // No partial file is left for derivation to hash and trust.
    expect(await readdir(demDir)).toEqual([]);
  });

  test("a fetch still going at the deadline stops, is reported, and leaves the run to derive", async () => {
    await pending(1, 44, -124);
    // A source that never answers until the request is abandoned.
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    expect(await refreshTiles(conn, demDir, { fetchImpl: hanging, deadlineMs: 50 })).toBe(
      "elevation tile fetch stopped after 0 minutes; deriving from the tiles on disk",
    );
    expect(await readdir(demDir)).toEqual([]);
  });

  test("an aborted run stops rather than reporting a failed fetch", async () => {
    await pending(1, 44, -124);
    const controller = new AbortController();
    controller.abort();
    await expect(refreshTiles(conn, demDir, { fetchImpl: sources([]), signal: controller.signal })).rejects.toThrow();
  });
});
