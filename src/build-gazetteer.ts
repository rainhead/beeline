import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSpatial, openDuckDb } from "./db.js";

/**
 * Build the gazetteer a sample's locality is named from (beeline-7i6), from
 * the sources scripts/fetch-gazetteer.sh downloads. Run on a workstation; the
 * file it writes goes up to the machine by hand (docs/runbooks/deploy-fly.md),
 * the way a reseeded store does. ingest/gazetteer.sql says what is in it.
 *
 * The file is written beside its destination and renamed over it, so the
 * nightly never opens a half-built one. Each build gets a fresh id
 * (`gazetteer_build`), which every derived locality records: a new build is
 * how the nightly knows to name every sample again.
 */

const INGEST_DIR = new URL("../ingest/", import.meta.url).pathname;

export interface GazetteerCounts {
  buildId: string;
  tables: Record<string, number>;
}

export async function buildGazetteer(out: string, sources: string): Promise<GazetteerCounts> {
  const partial = `${out}.building`;
  await rm(partial, { force: true });
  await rm(`${partial}.wal`, { force: true });
  const instance = await openDuckDb(partial);
  const conn = await instance.connect();
  try {
    await loadSpatial(conn);
    const staged = await stageOsm(conn, sources);
    await conn.run(
      `CREATE TEMP TABLE osm_area_staged AS SELECT * FROM read_parquet([${staged.map(quote).join(", ")}])`,
    );
    const sql = (await readFile(`${INGEST_DIR}gazetteer.sql`, "utf8")).replaceAll("__SOURCES__", sources);
    await conn.run(sql);
    await conn.run(`DROP TABLE osm_area_staged`);
    await conn.run(
      `CREATE TABLE gazetteer_build AS SELECT gen_random_uuid()::TEXT AS build_id, current_timestamp AS built_at`,
    );
    const tables: Record<string, number> = {};
    for (const t of ["region", "refuge", "wildlife_area_unit", "nps_unit", "state_park", "town_limits", "osm_area", "place", "feature"]) {
      const [[n]] = (await (await conn.run(`SELECT count(*) FROM ${t}`)).getRows()) as [[bigint]];
      tables[t] = Number(n);
    }
    const [[buildId]] = (await (await conn.run(`SELECT build_id FROM gazetteer_build`)).getRows()) as [[string]];
    await conn.run("CHECKPOINT");
    conn.closeSync();
    instance.closeSync();
    await rename(partial, out);
    return { buildId, tables };
  } catch (err) {
    conn.closeSync();
    instance.closeSync();
    await rm(partial, { force: true });
    throw err;
  }
}

/**
 * Each OpenStreetMap extract in the sources, read into a Parquet file beside
 * it unless one newer than the extract is there already: British Columbia's
 * takes minutes, and an extract changes only when somebody fetches it again.
 */
async function stageOsm(conn: { run(sql: string): Promise<unknown> }, sources: string): Promise<string[]> {
  const pbfs = (await readdir(sources)).filter((f) => f.endsWith("-latest.osm.pbf")).sort();
  if (pbfs.length === 0) throw new Error(`no OpenStreetMap extracts in ${sources}: run pnpm locality:fetch`);
  const template = await readFile(`${INGEST_DIR}gazetteer-osm.sql`, "utf8");
  const staged: string[] = [];
  for (const pbf of pbfs) {
    const path = `${sources}/${pbf}`;
    const parquet = `${sources}/osm-${basename(pbf, "-latest.osm.pbf")}.parquet`;
    const fresh = await stat(parquet).then(
      async (p) => p.mtimeMs > (await stat(path)).mtimeMs,
      () => false,
    );
    if (!fresh) {
      console.error(`reading ${pbf}`);
      await conn.run(template.replaceAll("__PBF__", path).replaceAll("__OUT__", parquet));
    }
    staged.push(parquet);
  }
  return staged;
}

function quote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

// CLI: pnpm locality:gazetteer [out] [sources]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const out = process.argv[2] ?? "data/gazetteer.duckdb";
  const sources = process.argv[3] ?? "data/gazetteer-sources";
  console.log(JSON.stringify(await buildGazetteer(out, sources), null, 2));
}
