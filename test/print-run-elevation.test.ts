import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approveRun, markPrinted, prepareRun, PrintRunRefused, requestReprint } from "../src/print-run.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
import { deriveElevations } from "../src/derive-elevation.js";
import { tinyTiff } from "./tiff.js";

// A print run copies a sample's elevation onto a permanent label, so one read
// at a point the sample has since moved from must be read again or kept off
// the label (beeline-trl9, Peter, 2026-11-21).

const NOW = new Date("2026-09-21T16:00:00Z");
const LATER = new Date("2026-09-21T17:00:00Z");
const NEXT = new Date("2026-09-22T16:00:00Z");
const AFTER = new Date("2026-09-22T17:00:00Z");

let conn: DuckDBConnection;
let demDir: string;
let ash: number;
let seq = 0;

/** What the app supplies: the tiles in a folder, read again for the samples named. */
const read = (dir: string) => ({
  readElevations: async (ids: number[]) => {
    await deriveElevations(conn, dir, ids);
  },
});

beforeAll(async () => {
  demDir = await mkdtemp(join(tmpdir(), "beeline-dem-"));
  // n44_w124: 10x10, cell value = row*100 + column. Point 44.5646, -123.262
  // falls in row 4, column 7: 407.
  const srtm = new Int16Array(100);
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) srtm[c + 10 * r] = r * 100 + c;
  await writeFile(join(demDir, "n44_w124_1arc_v3.tif"), tinyTiff(srtm, 10, 10));
});

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  const [[id]] = (await rows(conn, `INSERT INTO person (display_name, given_name, family_name) VALUES ('Ada Ash', 'Ada', 'Ash') RETURNING entity_id`)) as [[number]];
  ash = id;
});

/** A sample whose elevation (72 m) was read at the fixture's default point, which then moved to the given one. */
async function movedSample(latitude: string, longitude: string, location: Record<string, string> = {}): Promise<number> {
  const id = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "1", sample_number: `'${++seq}'` }, location);
  await conn.run(`UPDATE sample_location SET latitude = ${latitude}, longitude = ${longitude} WHERE sample_id = ${id}`);
  return id;
}
const labelElevations = async (runId: number) =>
  ((await rows(conn, `SELECT sp.sample_id, pl.elevation_m FROM printed_label pl JOIN specimen sp ON sp.entity_id = pl.specimen_id WHERE pl.print_run_id = ${runId} ORDER BY sp.sample_id`)) as [number, number | null][]);
const stored = async (id: number) =>
  (await rows(conn, `SELECT elevation_m, elevation_latitude, elevation_longitude FROM sample_location WHERE sample_id = ${id}`)) as [number, number, number][];

describe("a run and an elevation read at another point", () => {
  it("reads it again from the tile on disk, prints it and writes it to the store", async () => {
    // Moved from 44.5646, -123.262 (where 72 m was read) to a cell the tile gives 307 m.
    const id = await movedSample("44.6", "-123.2");
    expect(await rows(conn, `SELECT sample_id FROM sample_elevation_stale`)).toEqual([[id]]);
    const run = await prepareRun(conn, { atlasId: null, personId: ash, now: NOW, ...read(demDir) });
    expect(run).toMatchObject({ labels: 1, heldForElevation: 0 });
    expect(await labelElevations(run!.printRunId)).toEqual([[id, 307]]);
    expect(await stored(id)).toEqual([[307, 44.6, -123.2]]);
    expect(await rows(conn, `SELECT * FROM sample_elevation_stale`)).toEqual([]);
  });

  it("holds a sample no tile covers, says so, and prints the rest", async () => {
    const fresh = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "1", sample_number: "'90'" });
    const away = await movedSample("40.5", "-120.5");
    const run = await prepareRun(conn, { atlasId: null, personId: ash, now: NOW, ...read(demDir) });
    expect(run).toMatchObject({ labels: 1, samples: 1, heldForElevation: 1 });
    // The fresh sample is untouched; the held one has no label, is still pending, and keeps what the store held.
    expect(await labelElevations(run!.printRunId)).toEqual([[fresh, 72]]);
    expect(await rows(conn, `SELECT sample_id FROM pending_print_sample`)).toEqual([[away]]);
    expect((await stored(away))[0]![0]).toBe(72);
  });

  it("holds every stale sample when no tile folder is given, and refuses a run with nothing else in it", async () => {
    await movedSample("44.6", "-123.2");
    await expect(prepareRun(conn, { atlasId: null, personId: ash, now: NOW })).rejects.toMatchObject({
      refusal: { code: "awaiting_elevation", samples: 1 },
    });
    await expect(prepareRun(conn, { atlasId: null, personId: ash, now: NOW })).rejects.toBeInstanceOf(PrintRunRefused);
    expect(await rows(conn, `SELECT count(*) FROM print_run`)).toEqual([[0n]]);
  });

  it("fills an empty elevation from the tile on disk and prints it", async () => {
    const id = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "1", sample_number: "'91'" }, { elevation_m: "NULL" });
    const run = await prepareRun(conn, { atlasId: null, personId: ash, now: NOW, ...read(demDir) });
    expect(run).toMatchObject({ labels: 1, heldForElevation: 0 });
    expect(await labelElevations(run!.printRunId)).toEqual([[id, 407]]);
    expect(await stored(id)).toEqual([[407, 44.5646, -123.262]]);
  });

  it("holds an empty elevation it cannot read, as it holds a stale one", async () => {
    // A promotion that finds an elevation stale empties it, so a sample moved
    // before the run can be empty, not stale, when the run is prepared.
    const id = await movedSample("40.5", "-120.5");
    await conn.run(`UPDATE sample_location SET elevation_m = NULL, elevation_source_id = NULL, elevation_latitude = NULL, elevation_longitude = NULL WHERE sample_id = ${id}`);
    expect(await rows(conn, `SELECT * FROM sample_elevation_stale`)).toEqual([]);
    await expect(prepareRun(conn, { atlasId: null, personId: ash, now: NOW, ...read(demDir) })).rejects.toMatchObject({
      refusal: { code: "awaiting_elevation", samples: 1 },
    });
  });

  it("holds a sample whose tile cannot be read, and prints the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beeline-dem-bad-"));
    await writeFile(join(dir, "n41_w124_1arc_v3.tif"), "not a tiff");
    const fresh = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "1", sample_number: "'95'" });
    const broken = await movedSample("41.5", "-123.5");
    const run = await prepareRun(conn, { atlasId: null, personId: ash, now: NOW, ...read(dir) });
    expect(run).toMatchObject({ labels: 1, heldForElevation: 1 });
    expect(await labelElevations(run!.printRunId)).toEqual([[fresh, 72]]);
    expect(await rows(conn, `SELECT sample_id FROM pending_print_sample`)).toEqual([[broken]]);
  });

  it("prints a held sample in the next run once its tile exists", async () => {
    const id = await movedSample("40.5", "-120.5");
    const fresh = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "1", sample_number: "'96'" });
    const first = await prepareRun(conn, { atlasId: null, personId: ash, now: NOW, ...read(demDir) });
    expect(first).toMatchObject({ heldForElevation: 1 });
    expect(await labelElevations(first!.printRunId)).toEqual([[fresh, 72]]);
    const later = await mkdtemp(join(tmpdir(), "beeline-dem-later-"));
    const tile = new Int16Array(100).fill(1234);
    await writeFile(join(later, "n40_w121_1arc_v3.tif"), tinyTiff(tile, 10, 10));
    const second = await prepareRun(conn, { atlasId: null, personId: ash, now: LATER, ...read(later) });
    expect(second).toMatchObject({ labels: 1, heldForElevation: 0 });
    expect(await labelElevations(second!.printRunId)).toEqual([[id, 1234]]);
  });

  it("reads again only the samples named", async () => {
    const a = await insertCleanSample(conn, { collector_id: String(ash), sample_number: "'97'" }, { elevation_m: "NULL" });
    const b = await insertCleanSample(conn, { collector_id: String(ash), sample_number: "'98'" }, { elevation_m: "NULL" });
    await deriveElevations(conn, demDir, [a]);
    expect(await rows(conn, `SELECT sample_id, elevation_m IS NOT NULL FROM sample_location WHERE sample_id IN (${a}, ${b}) ORDER BY sample_id`)).toEqual([
      [a, true],
      [b, false],
    ]);
  });

  it("does not hold a sample whose point is too vague for an elevation, new or reprint", async () => {
    const id = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "1", sample_number: "'99'" });
    const first = (await prepareRun(conn, { atlasId: null, personId: ash, now: NOW }))!.printRunId;
    await approveRun(conn, first, { personId: ash, now: NOW });
    await markPrinted(conn, first, { personId: ash, now: LATER });
    const [[specimen]] = (await rows(conn, `SELECT entity_id FROM specimen WHERE sample_id = ${id}`)) as [[number]];
    // Too vague, and with no elevation at all (a promotion emptied it).
    await conn.run(`UPDATE sample_location SET coordinate_uncertainty_m = 5000, elevation_m = NULL, elevation_source_id = NULL, elevation_latitude = NULL, elevation_longitude = NULL WHERE sample_id = ${id}`);
    await requestReprint(conn, { specimenId: specimen }, { personId: ash, now: NEXT, reason: "damaged" });
    const second = await prepareRun(conn, { atlasId: null, personId: ash, now: AFTER, ...read(demDir) });
    expect(second).toMatchObject({ reprints: 1, heldForElevation: 0 });
    expect(await labelElevations(second!.printRunId)).toEqual([[id, null]]);
  });

  it("prints no elevation, and does not hold, a reprint whose point is too vague for one", async () => {
    const id = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "1", sample_number: "'94'" });
    const first = (await prepareRun(conn, { atlasId: null, personId: ash, now: NOW }))!.printRunId;
    await approveRun(conn, first, { personId: ash, now: NOW });
    await markPrinted(conn, first, { personId: ash, now: LATER });
    const [[specimen]] = (await rows(conn, `SELECT entity_id FROM specimen WHERE sample_id = ${id}`)) as [[number]];
    await conn.run(`UPDATE sample_location SET latitude = 40.5, longitude = -120.5, coordinate_uncertainty_m = 5000 WHERE sample_id = ${id}`);
    await requestReprint(conn, { specimenId: specimen }, { personId: ash, now: NEXT, reason: "damaged" });
    const second = await prepareRun(conn, { atlasId: null, personId: ash, now: AFTER, ...read(demDir) });
    expect(second).toMatchObject({ reprints: 1, heldForElevation: 0 });
    expect(await labelElevations(second!.printRunId)).toEqual([[id, null]]);
  });

  it("covers a reprint: a printed sample whose point moved reads again, or is held", async () => {
    const id = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "1", sample_number: "'92'" });
    const first = (await prepareRun(conn, { atlasId: null, personId: ash, now: NOW, ...read(demDir) }))!.printRunId;
    await approveRun(conn, first, { personId: ash, now: NOW });
    await markPrinted(conn, first, { personId: ash, now: LATER });
    const [[specimen]] = (await rows(conn, `SELECT entity_id FROM specimen WHERE sample_id = ${id}`)) as [[number]];

    // Moved to a point inside the tile on disk: the reprint says what the tile says.
    await conn.run(`UPDATE sample_location SET latitude = 44.1, longitude = -123.1 WHERE sample_id = ${id}`);
    await requestReprint(conn, { specimenId: specimen }, { personId: ash, now: NEXT, reason: "damaged" });
    const second = await prepareRun(conn, { atlasId: null, personId: ash, now: AFTER, ...read(demDir) });
    expect(second).toMatchObject({ reprints: 1, heldForElevation: 0 });
    expect(await labelElevations(second!.printRunId)).toEqual([[id, 809]]);
  });

  it("holds a reprint whose new point has no tile", async () => {
    const id = await insertCleanSample(conn, { collector_id: String(ash), specimen_count: "1", sample_number: "'93'" });
    const first = (await prepareRun(conn, { atlasId: null, personId: ash, now: NOW, ...read(demDir) }))!.printRunId;
    await approveRun(conn, first, { personId: ash, now: NOW });
    await markPrinted(conn, first, { personId: ash, now: LATER });
    const [[specimen]] = (await rows(conn, `SELECT entity_id FROM specimen WHERE sample_id = ${id}`)) as [[number]];
    await conn.run(`UPDATE sample_location SET latitude = 40.5, longitude = -120.5 WHERE sample_id = ${id}`);
    await requestReprint(conn, { specimenId: specimen }, { personId: ash, now: NEXT, reason: "damaged" });
    await expect(prepareRun(conn, { atlasId: null, personId: ash, now: AFTER, ...read(demDir) })).rejects.toMatchObject({
      refusal: { code: "awaiting_elevation", samples: 1 },
    });
  });
});
