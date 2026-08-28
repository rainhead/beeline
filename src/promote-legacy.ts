import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ensureCorrectionsFile } from "./corrections.js";
import { applyPersonOverlay, type Unresolved } from "./apply-person-overlay.js";
import { mergeOverlays, readOverlay, CURATED_OVERLAY } from "./person-overlay.js";
import { changeLogFor, DEFAULT_DB, duckdbReader, recordPersonChanges } from "./person-change.js";

const INGEST_DIR = new URL("../ingest/", import.meta.url).pathname;

/**
 * The legacy name register is fetched, not checked in, so a store can be
 * promoted without one — a fresh clone, or anyone who has the occurrence dump
 * and not the register. Missing, it reads as empty rather than fatal: the
 * staging table and its curation views exist either way, and report nothing.
 */
const REGISTER_COLUMNS = ["userLogin", "fullName", "firstName", "firstNameInitial", "lastName"];
function registerSource(csvPath: string): string {
  if (!existsSync(csvPath)) {
    const nulls = REGISTER_COLUMNS.map((c) => `NULL::VARCHAR AS ${c}`).join(", ");
    return `(SELECT ${nulls} WHERE false)`;
  }
  return `read_csv('${csvPath.replaceAll("'", "''")}', header = true, all_varchar = true)`;
}

export interface PromotionCounts {
  staged: number;
  people: number;
  samples: number;
  specimens: number;
  locations: number;
  animals: number;
  determinations: number;
  blockedRows: number;
  unresolvedDeterminations: number;
  unresolvedDeterminerNames: number;
  /** Alias lines naming a spelling no staged row carries — a CSV typo. */
  unusedCollectorAliases: number;
  /** Logins two person records file under: one human twice, or a shared account. */
  collectorDuplicateLogins: number;
  correctionsApplied: number;
  correctionsRetired: number;
  correctionConflicts: number;
  /**
   * Rows staged from the legacy name register. Zero means there was no
   * register to read, which is not the same as a register that agrees —
   * `pnpm db:reseed` re-promotes from staging and would otherwise report a
   * clean worklist for a file it never opened.
   */
  registerStaged: number;
  /** Name parts the legacy register spells differently — a worklist (beeline-8t8). */
  registerNameConflicts: number;
  /** Staff decisions about people replayed onto the fresh store (ADR 0004). */
  personOverlayApplied: number;
  /** Overlay rows that named nobody — reported, never guessed at. */
  personOverlayUnresolved: Unresolved[];
}

/**
 * Every file promotion reads that is not the staged rows themselves.
 *
 * Named rather than positional, and required rather than defaulted, because
 * half of these paths point at files that exist only on the machine that
 * fetched or wrote them — `data/legacy/*` is gitignored, and so are
 * `data/corrections.csv` and `data/person-overlay.csv`. A defaulted parameter
 * a caller forgets is answered silently by whatever is in the developer's
 * working copy, which is a test that passes here and means nothing anywhere
 * else. So there is no default to forget: the ingest CLI names LIVE_INPUTS,
 * tests name their fixtures, and the type will not let either skip one
 * (beeline-cqk).
 */
export interface PromotionInputs {
  /** Curated legacy taxonomy, fetched beside the occurrence dump. */
  taxonomyCsv: string;
  determinerAliases: string;
  determinerRegister: string;
  /** Git-curated corrections (ADR 0004). */
  legacyCorrections: string;
  /** Corrections the app wrote, which win over the curated ones. */
  appCorrections: string;
  /** Git-curated staff decisions about people. */
  curatedOverlay: string;
  /** Overlay rows the app wrote, merged over the curated ones. */
  appOverlay: string;
  collectorAliases: string;
  /** The legacy name register (beeline-8t8); absent reads as empty. */
  usernameRegister: string;
}

/**
 * What a real ingest reads. Named in one place so that adding an input is one
 * edit rather than one per call site, and so the gitignored paths are all
 * visible together.
 */
export const LIVE_INPUTS: PromotionInputs = {
  taxonomyCsv: "data/legacy/taxonomy.csv",
  determinerAliases: "ingest/determiner-aliases.csv",
  determinerRegister: "ingest/determiner-register.csv",
  legacyCorrections: "ingest/legacy-corrections.csv",
  appCorrections: "data/corrections.csv",
  curatedOverlay: CURATED_OVERLAY,
  appOverlay: "data/person-overlay.csv",
  collectorAliases: "ingest/collector-aliases.csv",
  usernameRegister: "data/legacy/usernames.csv",
};

/** Promote staged legacy_occurrence rows into the model. Fresh model only. */
export async function promoteLegacy(
  conn: DuckDBConnection,
  inputs: PromotionInputs,
): Promise<PromotionCounts> {
  const {
    taxonomyCsv, determinerAliases, determinerRegister, legacyCorrections,
    appCorrections, curatedOverlay, appOverlay, collectorAliases, usernameRegister,
  } = inputs;
  const scalar = async (sql: string): Promise<number> => {
    const [[v]] = (await (await conn.run(sql)).getRows()) as [[bigint]];
    return Number(v);
  };
  if ((await scalar("SELECT count(*) FROM person")) > 0) {
    throw new Error("model already contains people — promotion runs only against a freshly built database");
  }
  await ensureCorrectionsFile(appCorrections); // read_csv fails on a missing file
  const promoteSql = await readFile(`${INGEST_DIR}promote-legacy.sql`, "utf8");
  await conn.run(
    promoteSql
      .replaceAll("{{LEGACY_CORRECTIONS}}", legacyCorrections.replaceAll("'", "''"))
      .replaceAll("{{APP_CORRECTIONS}}", appCorrections.replaceAll("'", "''"))
      .replaceAll("{{COLLECTOR_ALIASES}}", collectorAliases.replaceAll("'", "''")),
  );
  // Names come apart before anything reads them apart (beeline-qcd).
  await conn.run(await readFile(`${INGEST_DIR}parse-names.sql`, "utf8"));
  const seedSql = await readFile(`${INGEST_DIR}seed-animals.sql`, "utf8");
  await conn.run(seedSql.replaceAll("{{TAXONOMY_CSV}}", taxonomyCsv.replaceAll("'", "''")));
  const detSql = await readFile(`${INGEST_DIR}promote-determinations.sql`, "utf8");
  await conn.run(
    detSql
      .replaceAll("{{DETERMINER_ALIASES}}", determinerAliases.replaceAll("'", "''"))
      .replaceAll("{{DETERMINER_REGISTER}}", determinerRegister.replaceAll("'", "''")),
  );
  // Last: people and their accounts exist by now, so every reference an
  // overlay row can name is there to be resolved.
  const overlay = await applyPersonOverlay(
    conn,
    mergeOverlays(await readOverlay(curatedOverlay), await readOverlay(appOverlay)),
  );
  // After the overlay: the register is compared against the bindings that
  // survive it, so a login the overlay rebound is not reported as a conflict
  // against the account it used to have.
  const registerSql = await readFile(`${INGEST_DIR}promote-register.sql`, "utf8");
  await conn.run(registerSql.replaceAll("{{REGISTER_SOURCE}}", registerSource(usernameRegister)));

  return {
    staged: await scalar("SELECT count(*) FROM legacy_occurrence"),
    people: await scalar("SELECT count(*) FROM person"),
    samples: await scalar("SELECT count(*) FROM sample"),
    specimens: await scalar("SELECT count(*) FROM specimen"),
    locations: await scalar("SELECT count(*) FROM sample_location"),
    animals: await scalar("SELECT count(*) FROM animal"),
    determinations: await scalar("SELECT count(*) FROM determination"),
    blockedRows: await scalar(
      "SELECT count(DISTINCT _id) FROM legacy_promotion_finding WHERE severity = 'blocking'",
    ),
    unresolvedDeterminations: await scalar("SELECT count(*) FROM legacy_unresolved_determination"),
    unresolvedDeterminerNames: await scalar("SELECT count(*) FROM legacy_determiner_unresolved"),
    unusedCollectorAliases: await scalar("SELECT count(*) FROM legacy_collector_alias_unused"),
    collectorDuplicateLogins: await scalar(
      "SELECT count(DISTINCT login) FROM legacy_collector_duplicate_candidate",
    ),
    correctionsApplied: await scalar(
      "SELECT count(*) FROM legacy_correction_state WHERE status IN ('applies', 'conflict')",
    ),
    correctionsRetired: await scalar(
      "SELECT count(*) FROM legacy_correction_state WHERE status = 'retired'",
    ),
    registerStaged: await scalar("SELECT count(*) FROM legacy_username_register"),
    registerNameConflicts: await scalar("SELECT count(*) FROM legacy_register_name_conflict"),
    personOverlayApplied: overlay.applied,
    personOverlayUnresolved: overlay.unresolved,
    correctionConflicts: await scalar(
      "SELECT count(*) FROM legacy_correction_state WHERE status = 'conflict'",
    ),
  };
}

// CLI: pnpm legacy:promote [db]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? DEFAULT_DB;
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const counts = await promoteLegacy(conn, LIVE_INPUTS);

  // The admin seed, before the history is recorded rather than at the app's
  // next boot. The people in the bootstrap roster hold their rights through
  // this seed alone — never through an overlay row — so a freshly promoted
  // store has nobody who can administer it until something applies it, and
  // the change log would have recorded that gap as a revocation and the next
  // boot as a re-grant: a flap, twice per rebuild, that no person performed.
  //
  // Through the app's own configuration, not through the constant behind it:
  // a deployment that sets BEELINE_ADMIN_LOGINS or BEELINE_PERSON_OVERLAY has
  // said who its admins are and where its decisions live, and a seed reading
  // past both could re-grant somebody whose revocation it never read — which
  // then sticks, because the app's boot seed skips anyone already holding a
  // row (beeline-2c3.38).
  const { createKysely } = await import("./db.js");
  const { seedAdmins } = await import("./app/db.js");
  const { configFromEnv } = await import("./app/config.js");
  const appConfig = configFromEnv();
  const db = createKysely(instance);
  const seeded = await seedAdmins(
    db,
    appConfig.adminLogins,
    mergeOverlays(await readOverlay(CURATED_OVERLAY), await readOverlay(appConfig.personOverlayPath)),
  );

  // Last of all, with the people this run produced finally settled: what a
  // rebuild did to them is a change like any other, and used to leave no
  // trace but the code that did it (beeline-o22). Compared against the log
  // rather than against the old store, which this run has already replaced.
  // The log belongs to the database this was pointed at — promoting a scratch
  // copy must not diff its people against the deployed store's history.
  const log = changeLogFor(dbPath, process.env);
  const recorded =
    log === null
      ? null
      : await recordPersonChanges(duckdbReader(conn), log, { source: "legacy_promotion" });
  if (log === null) {
    console.warn(
      `not recording person history: ${dbPath} is not the database this environment keeps a change log for ` +
        `(${process.env.BEELINE_DB ?? DEFAULT_DB})`,
    );
  }
  await db.destroy();
  conn.closeSync();
  console.log(JSON.stringify({ ...counts, adminsSeeded: seeded, personChangesRecorded: recorded?.appended ?? null }, null, 2));
  if (counts.specimens + counts.blockedRows !== counts.staged) {
    console.error("specimens + blocked rows ≠ staged rows — investigate before trusting this run");
    process.exit(1);
  }
}
