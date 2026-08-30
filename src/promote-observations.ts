import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { changeLogFor, DEFAULT_DB, duckdbReader, recordPersonChanges } from "./person-change.js";
import { recordSampleChanges, sampleLogFor } from "./sample-change.js";
import { refreshObservationFields } from "./refresh-observation-fields.js";

const INGEST_DIR = new URL("../ingest/", import.meta.url).pathname;

/**
 * Promote the current observation state into the model. Idempotent; run after
 * every sync. Three SQL files, in one transaction, and the order is the point
 * (beeline-oyq):
 *
 * 1. ingest/harvest-inat-accounts.sql — observer→collector iNat account
 *    linkage, first because minting resolves an observer through it.
 * 2. ingest/mint-samples.sql — observations that evidence a collecting event
 *    the store does not hold become samples; ones it does hold become free
 *    links. This is the only thing in Beeline that creates a sample from
 *    iNaturalist, and at cutover it becomes the only thing that creates one
 *    at all.
 * 3. ingest/promote-observations.sql — geoprivacy flags and believed-true
 *    locations (private/trusted > public-unobscured; obscured-untrusted
 *    writes nothing), keyed on the inat_observation_id step 2 has just set,
 *    so a sample minted on this pass is located on this pass.
 */

export interface ObservationPromotionCounts {
  linkedSamples: number;
  samplesMinted: number;
  freeLinks: number;
  ambiguousGroups: number;
  unresolvedObservers: number;
  trustedLocations: number;
  publicLocations: number;
  obscuredWithheld: number;
  accountsLinked: number;
  accountConflicts: number;
}

export async function promoteObservations(
  conn: DuckDBConnection,
): Promise<ObservationPromotionCounts> {
  const scalar = async (sql: string): Promise<number> => {
    const [[v]] = (await (await conn.run(sql)).getRows()) as [[bigint]];
    return Number(v);
  };

  await conn.run("BEGIN TRANSACTION");
  try {
    // Before anything reads it. A sync already refreshed this, but promotion
    // is also how a reseeded store, a hand-staged test store, or a rebuild
    // gets promoted — and promotion writes believed-true coordinates onto
    // samples from this table, so reading an empty one would link nothing
    // and say so as a number rather than as an error
    // (src/refresh-observation-fields.ts).
    await refreshObservationFields(conn);
    const accountsBefore = await scalar("SELECT count(*) FROM inat_account");
    await conn.run(await readFile(`${INGEST_DIR}harvest-inat-accounts.sql`, "utf8"));
    // Counted BEFORE minting runs, because both views are defined over what
    // is still unlinked: afterwards they are empty, which is the point but
    // makes them useless as a report of what just happened.
    const freeLinks = await scalar("SELECT count(*) FROM sample_mint_free_link");
    const ambiguousGroups = await scalar("SELECT count(*) FROM sample_mint_ambiguous");
    await conn.run(await readFile(`${INGEST_DIR}mint-samples.sql`, "utf8"));
    await conn.run(await readFile(`${INGEST_DIR}promote-observations.sql`, "utf8"));
    const counts: ObservationPromotionCounts = {
      linkedSamples: await scalar(
        `SELECT count(*) FROM sample s
         JOIN observation_field f ON f.inat_id = s.inat_observation_id`,
      ),
      samplesMinted: await scalar("SELECT count(*) FROM minted_sample"),
      freeLinks,
      ambiguousGroups,
      // Collection records nothing can mint because the store holds no
      // account for the observer — beeline-e85's queue, reported as a number
      // here so a growing one is visible without opening a screen.
      unresolvedObservers: await scalar("SELECT count(*) FROM observation_sample_unresolved"),
      trustedLocations: await scalar(
        `SELECT count(*) FROM observation_location_candidate WHERE source = 'inat_trusted'`,
      ),
      publicLocations: await scalar(
        `SELECT count(*) FROM observation_location_candidate WHERE source = 'inat_public'`,
      ),
      obscuredWithheld: await scalar(
        `SELECT count(*) FROM sample s
         JOIN observation_field f ON f.inat_id = s.inat_observation_id
         LEFT JOIN observation_location_candidate c ON c.sample_id = s.entity_id
         WHERE c.sample_id IS NULL`,
      ),
      accountsLinked: (await scalar("SELECT count(*) FROM inat_account")) - accountsBefore,
      // Pairs the harvest refused: ambiguous either way, or clashing with an
      // account already on file under a different person/user id.
      accountConflicts: await scalar(
        `SELECT count(*) FROM observer_collector_pair p
         WHERE (SELECT count(*) FROM observer_collector_pair q
                WHERE q.person_id = p.person_id) > 1
            OR (SELECT count(*) FROM observer_collector_pair q
                WHERE q.user_id = p.user_id) > 1
            OR EXISTS (SELECT 1 FROM inat_account a
                       WHERE a.person_id = p.person_id AND a.inat_user_id <> p.user_id)
            OR EXISTS (SELECT 1 FROM inat_account a
                       WHERE a.inat_user_id = p.user_id AND a.person_id <> p.person_id)`,
      ),
    };
    await conn.run("COMMIT");
    return counts;
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

// CLI: pnpm inat:promote [db]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? DEFAULT_DB;
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const counts = await promoteObservations(conn);
  // A login iNaturalist has renamed is a change to a person; the nightly job
  // records the same thing after the same step (beeline-o22). The log belongs
  // to the database this was pointed at — promoting a scratch copy must not
  // diff its people against the deployed store's history.
  const log = changeLogFor(dbPath, process.env);
  if (log === null) {
    console.warn(
      `not recording person history: ${dbPath} is not the database this environment keeps a change log for ` +
        `(${process.env.BEELINE_DB ?? DEFAULT_DB})`,
    );
  }
  const recorded =
    log === null ? null : await recordPersonChanges(duckdbReader(conn), log, { source: "observation_promotion" });
  // Samples too (beeline-ewl): minting creates them, the free-link rewires
  // them, and the location writes move them — this is the nightly's record
  // of all three.
  const samplePaths = sampleLogFor(dbPath, process.env);
  // Guarded like the boot pass — see promote-legacy.ts on why a
  // history-write failure must not abort a run whose data already committed.
  let sampleRecorded = null;
  try {
    sampleRecorded =
      samplePaths === null
        ? null
        : await recordSampleChanges(duckdbReader(conn), samplePaths, { source: "observation_promotion" });
  } catch (err) {
    console.warn(`could not record sample history: ${(err as Error).message}`);
  }
  conn.closeSync();
  console.log(
    JSON.stringify(
      {
        ...counts,
        personChangesRecorded: recorded?.appended ?? null,
        sampleChangesRecorded: sampleRecorded?.appended ?? null,
        sampleBaselined: sampleRecorded?.baselined ?? false,
      },
      null,
      2,
    ),
  );
}
