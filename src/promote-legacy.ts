import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ensureCorrectionsFile } from "./corrections.js";
import { applyPersonOverlay, type Unresolved } from "./apply-person-overlay.js";
import { mergeOverlays, readOverlay } from "./person-overlay.js";

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

/** Promote staged legacy_occurrence rows into the model. Fresh model only. */
export async function promoteLegacy(
  conn: DuckDBConnection,
  taxonomyCsvPath = "data/legacy/taxonomy.csv",
  determinerAliasesPath = "ingest/determiner-aliases.csv",
  determinerRegisterPath = "ingest/determiner-register.csv",
  legacyCorrectionsPath = "ingest/legacy-corrections.csv",
  appCorrectionsPath = "data/corrections.csv",
  curatedOverlayPath = "ingest/person-overlay.csv",
  appOverlayPath = "data/person-overlay.csv",
  collectorAliasesPath = "ingest/collector-aliases.csv",
  usernameRegisterPath = "data/legacy/usernames.csv",
): Promise<PromotionCounts> {
  const scalar = async (sql: string): Promise<number> => {
    const [[v]] = (await (await conn.run(sql)).getRows()) as [[bigint]];
    return Number(v);
  };
  if ((await scalar("SELECT count(*) FROM person")) > 0) {
    throw new Error("model already contains people — promotion runs only against a freshly built database");
  }
  await ensureCorrectionsFile(appCorrectionsPath); // read_csv fails on a missing file
  const promoteSql = await readFile(`${INGEST_DIR}promote-legacy.sql`, "utf8");
  await conn.run(
    promoteSql
      .replaceAll("{{LEGACY_CORRECTIONS}}", legacyCorrectionsPath.replaceAll("'", "''"))
      .replaceAll("{{APP_CORRECTIONS}}", appCorrectionsPath.replaceAll("'", "''"))
      .replaceAll("{{COLLECTOR_ALIASES}}", collectorAliasesPath.replaceAll("'", "''")),
  );
  const seedSql = await readFile(`${INGEST_DIR}seed-animals.sql`, "utf8");
  await conn.run(seedSql.replaceAll("{{TAXONOMY_CSV}}", taxonomyCsvPath.replaceAll("'", "''")));
  const detSql = await readFile(`${INGEST_DIR}promote-determinations.sql`, "utf8");
  await conn.run(
    detSql
      .replaceAll("{{DETERMINER_ALIASES}}", determinerAliasesPath.replaceAll("'", "''"))
      .replaceAll("{{DETERMINER_REGISTER}}", determinerRegisterPath.replaceAll("'", "''")),
  );
  // Last: people and their accounts exist by now, so every reference an
  // overlay row can name is there to be resolved.
  const overlay = await applyPersonOverlay(
    conn,
    mergeOverlays(await readOverlay(curatedOverlayPath), await readOverlay(appOverlayPath)),
  );
  // After the overlay: the register is compared against the bindings that
  // survive it, so a login the overlay rebound is not reported as a conflict
  // against the account it used to have.
  const registerSql = await readFile(`${INGEST_DIR}promote-register.sql`, "utf8");
  await conn.run(registerSql.replaceAll("{{REGISTER_SOURCE}}", registerSource(usernameRegisterPath)));

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
  const dbPath = process.argv[2] ?? "beeline.duckdb";
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const counts = await promoteLegacy(conn);
  conn.closeSync();
  console.log(JSON.stringify(counts, null, 2));
  if (counts.specimens + counts.blockedRows !== counts.staged) {
    console.error("specimens + blocked rows ≠ staged rows — investigate before trusting this run");
    process.exit(1);
  }
}
