import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeAll, describe, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { scopeCounts } from "../src/app/print-runs.js";
import { createApp } from "../src/app/server.js";
import { createKysely } from "../src/db.js";
import { approveRun, markPrinted, prepareRun, requestReprint } from "../src/print-run.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths, SETTLED_SEASON } from "./helpers.js";

/**
 * What the Prepare screen of /print-runs counts (scopeCounts), pinned on a
 * store with several atlases, pending samples, held and blocked ones, samples
 * of a settled season, and reprints (beeline-amdt.2). The page reads the
 * pending-print and reprint views through one pass per request; these numbers
 * are what it showed before it did, so a change to how it reads them that
 * alters one fails here. The program's counts are also held equal to the views
 * the freeze reads (print_scope_sample, print_scope_reprint), which is the
 * promise in schema/155 that the screen and the freeze cannot disagree.
 */

const HOUR = 3_600_000;
const T0 = Date.now() - 6 * HOUR;
const at = (hours: number) => new Date(T0 + hours * HOUR);

const atlas = (code: string) => `(SELECT entity_id FROM program WHERE code = '${code}')`;
const count = async (conn: DuckDBConnection, sql: string): Promise<number> =>
  Number((await rows(conn, sql))[0]![0]);

async function build() {
  const { instance, conn } = await createMemoryDb();
  const person = async (name: string) => {
    const [given, family] = name.split(" ");
    const [[id]] = (await rows(
      conn,
      `INSERT INTO person (display_name, given_name, family_name) VALUES ('${name}', '${given}', '${family}') RETURNING entity_id`,
    )) as [[number]];
    return Number(id);
  };
  const ash = await person("Ada Ash");
  const staffer = await person("Sam Staff");
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staffer})`);
  // Washington prints its own labels; every other atlas is the program's run.
  await conn.run(`INSERT INTO atlas_printing SELECT entity_id FROM program WHERE code = 'WaBA'`);
  const sample = (n: number, count: number, extra: Record<string, string> = {}, location: Record<string, string> | null = {}) =>
    insertCleanSample(conn, { collector_id: String(ash), specimen_count: String(count), sample_number: `'${n}'`, ...extra }, location);

  // Printed already: one in the program's run, one in Washington's own, one more in the program's run that is held later.
  const p1 = await sample(1, 3, { atlas_id: atlas("OBA") });
  const p3 = await sample(3, 2, { atlas_id: atlas("ID") });
  const p2 = await sample(2, 2, { atlas_id: atlas("WaBA") });
  const printed = async (atlasId: number | null, now: Date) => {
    const run = (await prepareRun(conn, { atlasId, personId: ash, now }))!;
    await approveRun(conn, run.printRunId, { personId: ash, now });
    await markPrinted(conn, run.printRunId, { personId: ash, now: new Date(now.getTime() + 60_000) });
  };
  await printed(null, at(0));
  await printed(Number((await rows(conn, `SELECT entity_id FROM program WHERE code = 'WaBA'`))[0]![0]), at(1));
  const specimen = async (sampleId: number, n: number) =>
    Number((await rows(conn, `SELECT entity_id FROM specimen WHERE sample_id = ${sampleId} AND specimen_number = ${n}`))[0]![0]);
  // Reprints: two of the program's, one of Washington's, and one held back by a staff hold.
  await requestReprint(conn, { specimenIds: [await specimen(p1, 1), await specimen(p1, 2)] }, { personId: staffer, now: at(2) });
  await requestReprint(conn, { specimenId: await specimen(p2, 1) }, { personId: staffer, now: at(2) });
  await requestReprint(conn, { specimenId: await specimen(p3, 1) }, { personId: staffer, now: at(2) });
  await conn.run(`INSERT INTO sample_hold (sample_id, reason, held_by) VALUES (${p3}, 'checking the date', ${staffer})`);

  // Waiting to print, by atlas.
  await sample(10, 3, { atlas_id: atlas("OBA") });
  await sample(11, 2, { atlas_id: atlas("OBA") });
  // The Washington sample's elevation was read elsewhere too: a stale elevation in an atlas that prints its own labels.
  await sample(12, 4, { atlas_id: atlas("WaBA") }, { elevation_latitude: "40.5", elevation_longitude: "-120.5" });
  await sample(13, 2, { atlas_id: atlas("BC") });
  await sample(14, 2); // in no atlas
  // Moved from where its elevation was read: still waiting, and counted as stale.
  await sample(15, 1, { atlas_id: atlas("ID") }, { elevation_latitude: "40.5", elevation_longitude: "-120.5" });
  // Not waiting: held by staff, blocked for lack of a location, and settled without a release.
  const held = await sample(16, 5, { atlas_id: atlas("OBA") });
  await conn.run(`INSERT INTO sample_hold (sample_id, reason, held_by) VALUES (${held}, 'wrong day', ${staffer})`);
  await sample(17, 6, { atlas_id: atlas("OBA") }, null);
  const settled = { date_start: `DATE '${SETTLED_SEASON}-07-14'`, date_end: `DATE '${SETTLED_SEASON}-07-14'` };
  await sample(18, 7, { atlas_id: atlas("OBA"), ...settled });
  // Settled and released by staff: waiting, in the New Mexico atlas, unless it follows an observation's point.
  const releasedPlain = await sample(19, 2, { atlas_id: atlas("NM"), ...settled });
  const releasedObserved = await sample(20, 4, { atlas_id: atlas("OBA"), ...settled, inat_observation_id: "987654" });
  for (const id of [releasedPlain, releasedObserved])
    await conn.run(`INSERT INTO sample_print_release_event (sample_id, action, person_id) VALUES (${id}, 'release', ${staffer})`);
  return { instance, conn, ash, staffer };
}

describe("what the Prepare screen counts (beeline-amdt.2)", () => {
  let env: Awaited<ReturnType<typeof build>>;
  beforeAll(async () => {
    env = await build();
  });

  it("counts the program's run, each atlas, and the callouts as it always did", async () => {
    const scope = await scopeCounts(createKysely(env.instance));
    expect(scope.program).toEqual({ samples: 6, labels: 12, reprints: 2 });
    expect(scope.awaiting_place).toBe(1);
    expect(scope.stale_elevation).toBe(2);
    expect(scope.atlases.map((a) => [a.code, a.own, a.samples, a.labels, a.reprints])).toEqual([
      ["OBA", false, 2, 5, 2],
      ["WaBA", true, 1, 4, 1],
      ["BC", false, 1, 2, 0],
      ["ID", false, 1, 1, 0],
      ["NM", false, 1, 2, 0],
    ]);
    expect(scope.atlases.map((a) => [a.abbreviation, a.name])).toEqual([
      ["OBA", "Oregon Bee Atlas"],
      ["WABA", "Washington Bee Atlas"],
      ["BCBA", "British Columbia Bee Atlas"],
      ["ID", "Idaho Bee Atlas"],
      ["NM", "New Mexico Bee Atlas"],
    ]);
    expect(scope.atlases.map((a) => a.atlas_id)).toEqual([...scope.atlases.map((a) => a.atlas_id)].sort((a, b) => a - b));
  });

  it("keeps the program's counts equal to the views the freeze reads", async () => {
    const scope = await scopeCounts(createKysely(env.instance));
    expect(scope.program.samples).toBe(await count(env.conn, `SELECT count(*) FROM print_scope_sample`));
    expect(scope.program.labels).toBe(await count(env.conn, `SELECT sum(pending_count) FROM print_scope_sample`));
    expect(scope.program.reprints).toBe(await count(env.conn, `SELECT count(DISTINCT specimen_id) FROM print_scope_reprint`));
    for (const a of scope.atlases) {
      expect(a.samples).toBe(
        await count(env.conn, `SELECT count(*) FROM pending_print_sample p JOIN sample_atlas sa USING (sample_id) WHERE sa.atlas_id = ${a.atlas_id}`),
      );
      expect(a.labels).toBe(
        await count(
          env.conn,
          `SELECT coalesce(sum(pending_count), 0) FROM pending_print_sample p JOIN sample_atlas sa USING (sample_id) WHERE sa.atlas_id = ${a.atlas_id}`,
        ),
      );
      expect(a.reprints).toBe(
        await count(
          env.conn,
          `SELECT count(DISTINCT specimen_id) FROM printable_reprint p JOIN sample_atlas sa USING (sample_id) WHERE sa.atlas_id = ${a.atlas_id}`,
        ),
      );
    }
  });

  it("shows the same on the page to staff, and nothing to anyone else", async () => {
    const paths = await scratchPaths();
    const appFor = (personId: number, login: string) =>
      createApp({
        ...paths,
        db: createKysely(env.instance),
        config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
        inat: { authorizeUrl: () => "unused", exchangeCode: () => Promise.reject(new Error("unused")), identity: () => Promise.reject(new Error("unused")) },
        resolveSession: async () => ({ personId, login, iconUrl: null }),
        printConn: env.conn,
      });
    const body = await (await appFor(env.staffer, "staffer").request("/print-runs")).text();
    const p = en.printRuns.prepare;
    const text = (s: string) => s.replaceAll("'", "&#39;");
    expect(body).toContain(text(`${p.program} — ${p.waiting(12, 6, 2)}`));
    expect(body).toContain(text(`Washington Bee Atlas — ${p.waiting(4, 1, 1)}`));
    expect(body).not.toContain("Oregon Bee Atlas —");
    expect(body).toContain(text(p.programCovers(["OBA", "BCBA", "ID", "NM"])));
    expect(body).toContain(text(p.awaitingPlace(1)));
    expect(body).toContain(text(p.staleElevation(2)));
    expect((await appFor(env.ash, "ash").request("/print-runs")).status).toBe(403);
  });
});
