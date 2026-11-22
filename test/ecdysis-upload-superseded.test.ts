import { describe, expect, it, vi } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { CURRENT_SEASON, rows, scratchPaths } from "./helpers.js";
import { BC, fixture } from "./ecdysis-upload-fixture.js";

/**
 * A newer read of Ecdysis finishing while an archive is being written (beeline-8dx9.12). The read marker is the file
 * the fetch writes; here the route's later looks at it are made to see a newer read, the way a read that lands
 * during the build would show.
 */
const seen = { calls: 0, replaceAfter: 1 };
vi.mock("../src/fetch-ecdysis.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/fetch-ecdysis.js")>();
  return {
    ...real,
    readMarkerOf: async (dir: string, collection: Parameters<typeof real.readMarkerOf>[1]) => {
      const marker = await real.readMarkerOf(dir, collection);
      seen.calls++;
      return marker !== null && seen.calls > seen.replaceAfter ? { ...marker, readAt: new Date(Date.now() + 5_000).toISOString() } : marker;
    },
  };
});

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const e = en.programData.ecdysis;
const post = (app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }) =>
  app.request(`/programs/BC/data/ecdysis/${CURRENT_SEASON}-upload.zip`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });

describe("a read that finishes while the archive is being written", () => {
  it("keeps nothing: no completion is recorded and the answer says to start again; the unfinished start blocks until a read", async () => {
    const f = await fixture();
    const [[staff]] = (await rows(f.conn, `INSERT INTO person (display_name) VALUES ('Sam Staff') RETURNING entity_id`)) as [[number]];
    await f.conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);
    await f.cacheArchive(BC, ["BCBA_9999999"], { readHoursAgo: 1 });
    await f.specimen({ field: "2500001" });
    const app = createApp({
      ...(await scratchPaths()),
      ecdysisDir: f.dir,
      db: f.db,
      config: { environment: "sandbox" as const, origin: "http://localhost:3054", exportsDir: f.dir },
      inat: unusedInat,
      resolveSession: async () => ({ personId: staff, login: "someone", iconUrl: null }),
    });
    seen.calls = 0;
    seen.replaceAfter = 1;
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.text()).toBe(e.superseded);
    expect((await rows(f.conn, `SELECT count(*) FROM ecdysis_upload_download`))[0]).toEqual([1n]);
    expect((await rows(f.conn, `SELECT count(*) FROM ecdysis_upload_download_completed`))[0]).toEqual([0n]);
    expect((await rows(f.conn, `SELECT count(*) FROM ecdysis_upload_download_specimen`))[0]).toEqual([0n]);
    // It began after the read on disk, so it blocks a second archive until the next read.
    seen.calls = 0;
    seen.replaceAfter = 1_000;
    const again = await post(app);
    expect(again.status).toBe(409);
    expect(await again.text()).toBe(e.beingWritten);
    // The next read, which begins after it, lets one through.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await f.cacheArchive(BC, ["BCBA_9999999"], { readHoursAgo: 0 });
    seen.calls = 0;
    const third = await post(app);
    expect(third.status).toBe(200);
    await third.arrayBuffer();
  });
});
