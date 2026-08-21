import { DuckDBInstance } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";

/**
 * Phase-2 acceptance (roadmap): reconcile our derived QC findings against
 * production's stored errorFlags, per rule, per staged row. Runs against a
 * fully promoted database. Reports a confusion matrix for each comparable
 * rule; categories the model deliberately doesn't implement yet are listed
 * as exclusions, not buried.
 */

// Their flag name → predicate over our per-sample findings.
const COMPARISONS: Array<{ theirs: string; ours: string; predicate: string }> = [
  { theirs: "locality", ours: "locality_format or missing locality",
    predicate: "rule_name = 'locality_format' OR (rule_name = 'missing_required_field' AND details LIKE '%locality%')" },
  { theirs: "coordinateUncertaintyInMeters", ours: "coordinate_uncertainty",
    predicate: "rule_name = 'coordinate_uncertainty'" },
  { theirs: "county", ours: "missing_recommended_field",
    predicate: "rule_name = 'missing_recommended_field'" },
  { theirs: "samplingProtocol", ours: "missing protocol",
    predicate: "rule_name = 'missing_required_field' AND details LIKE '%protocol%'" },
  { theirs: "country", ours: "missing/unabbreviated country",
    predicate: "(rule_name = 'missing_required_field' AND details LIKE '%country%') OR (rule_name = 'place_unabbreviated' AND details LIKE '%country%')" },
  { theirs: "stateProvince", ours: "missing/unabbreviated state",
    predicate: "(rule_name = 'missing_required_field' AND details LIKE '%state_province%') OR (rule_name = 'place_unabbreviated' AND details LIKE '%state_province%')" },
  { theirs: "decimalLatitude", ours: "missing location",
    predicate: "rule_name = 'missing_required_field' AND details LIKE '%location%'" },
];

// Their flags with no model-level counterpart yet, with why.
const EXCLUSIONS = [
  "phylumPlant (non-tracheophyte host: needs iNat taxon ancestry, phase 3 — beeline-kw8.6)",
  "firstName/lastName/sampleId/specimenId/day/month/year (identity gaps stay in staging as promotion findings; such rows mostly never promote)",
];

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dbPath = process.argv[2] ?? "beeline.duckdb";
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  const q = async (sql: string) => (await (await conn.run(sql)).getRows()) as unknown[][];

  // One row per promoted staged occurrence with its sample's finding rules.
  await conn.run(`
    CREATE OR REPLACE TEMP VIEW reconcile_base AS
    SELECT r._id, r.errorFlags, sm2.sample_id
    FROM legacy_promotable r
    JOIN legacy_person_map m ON m.fn IS NOT DISTINCT FROM r.fn AND m.ln IS NOT DISTINCT FROM r.ln
    JOIN legacy_sample_map sm2
      ON sm2.person_id = m.person_id AND sm2.sid = r.sid
     AND sm2.p_date_start IS NOT DISTINCT FROM r.p_date_start
  `);

  console.log("rule-by-rule agreement (rows: promoted staged occurrences)\n");
  let worstDisagreement = 0;
  for (const c of COMPARISONS) {
    const [[both, onlyTheirs, onlyOurs, neither]] = (await q(`
      WITH ours AS (
        SELECT DISTINCT sample_id FROM qc_finding WHERE ${c.predicate}
      )
      SELECT
        count(*) FILTER (theirs AND ours2),
        count(*) FILTER (theirs AND NOT ours2),
        count(*) FILTER (NOT theirs AND ours2),
        count(*) FILTER (NOT theirs AND NOT ours2)
      FROM (
        SELECT list_contains(string_split(b.errorFlags, ';'), '${c.theirs}') AS theirs,
               b.sample_id IN (SELECT sample_id FROM ours) AS ours2
        FROM reconcile_base b
      )
    `)) as [[bigint, bigint, bigint, bigint]];
    const disagree = Number(onlyTheirs) + Number(onlyOurs);
    worstDisagreement = Math.max(worstDisagreement, disagree);
    console.log(
      `${c.theirs.padEnd(30)} vs ${c.ours.padEnd(36)} both=${both} only-legacy=${onlyTheirs} only-ours=${onlyOurs} agree-clean=${neither}`,
    );
  }

  console.log("\nexcluded from comparison:");
  for (const e of EXCLUSIONS) console.log(`  - ${e}`);

  const [[blocked]] = (await q(
    "SELECT count(DISTINCT _id) FROM legacy_promotion_finding WHERE severity = 'blocking'",
  )) as [[bigint]];
  console.log(`  - ${blocked} rows blocked from promotion entirely (their flags live in legacy_promotion_finding)`);
  conn.closeSync();
}
