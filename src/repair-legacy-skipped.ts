import type { DuckDBConnection } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";

/**
 * A one-time repair of what legacy promotion left behind (beeline-iuva).
 * Production is never rebuilt (ADR 0006), so this works on the live store,
 * in one transaction, and touches only records promotion did not take.
 *
 * SECOND PRINTS. The old Beeline sometimes printed one specimen twice under
 * two field numbers, and promotion keeps one record of each pair: the later
 * print, or, when both claim the same print date (most say 31 December), the
 * higher field number (legacy_ranked, ingest/promote-legacy.sql). Measured on
 * the store of 9 November 2026, that was often the record nobody had
 * identified: in 120 of 258 pairs the set-aside record carried an expert's or
 * a volunteer's identification the kept one lacked, and Beeline held none
 * for the specimen. For each set-aside record whose kept partner became a
 * specimen, this
 *   - carries its expert identification to the specimen if the specimen has
 *     no expert determination, and its volunteer identification if it has no
 *     volunteer determination, as promotion would have recorded them;
 *   - records it in legacy_duplicate_record, so the nightly import of the old
 *     Beeline's volunteer determinations follows it as well.
 * Which of the two field numbers is on the pin is not decided here: that
 * takes somebody looking at the pins.
 *
 * TWO BEES UNDER ONE NUMBER. Where both records of a pair carry an expert
 * identification and neither names the other's taxon or one of its
 * ancestors, they are two pins that share a sample and specimen number, not
 * one pin printed twice. The set-aside record becomes a specimen of its own
 * in the same sample, numbered after the sample's last, with its own field
 * number and identifications, and a row in legacy_specimen_number as
 * promotion gives every record it takes.
 *
 * A DATE WRITTEN BACKWARDS, ON AN OBSERVATION BEELINE HOLDS. A record refused
 * only for its date (the end before the start, or unreadable), linked to an
 * iNaturalist observation that is already a sample in Beeline with no
 * specimens and the same collector, becomes a specimen of that sample. The
 * sample's date is the observation's, so the record's own date is not
 * needed. On the store of 9 November 2026 this was one trap sample of 2020,
 * 34 specimens on observation 56359335, whose old records say 2 to 1 August
 * where the observation's own fields say the trap went out and came in on
 * 1 August.
 *
 * The identifications are read by promotion's own rules: the views that
 * apply them (legacy_det_taxa, legacy_expert_target, legacy_vol_det_taxa,
 * legacy_volunteer_target) are copied for this transaction from the store's
 * own definitions, reading the set-aside records instead of the promoted
 * ones, so a name is parsed exactly as it was at cutover.
 */

export interface SkippedRepairResult {
  /** Set-aside second prints tied to their specimen. */
  tied: number;
  /** Identifications carried from them to a specimen that lacked one. */
  carriedExpert: number;
  carriedVolunteer: number;
  /** Field numbers given a specimen of their own: the second bee of a pair. */
  separated: { fieldNumber: string; keptFieldNumber: string }[];
  /** Records given a specimen in the sample of their observation. */
  attached: { observation: number; sampleId: number; specimens: number }[];
  /** Determinations recorded for new specimens. */
  newSpecimenDeterminations: number;
  /** Names that match no taxon, which no determination could be made of. */
  unresolved: string[];
  dryRun: boolean;
}

const rowsOf = async (conn: DuckDBConnection, sql: string): Promise<unknown[][]> => (await conn.runAndReadAll(sql)).getRows();
const scalar = async (conn: DuckDBConnection, sql: string): Promise<number> => Number((await rowsOf(conn, sql))[0]?.[0] ?? 0);

/** Promotion's view, as the store defines it, made a temporary view reading other rows. */
async function repoint(conn: DuckDBConnection, view: string, as: string, from: string, to: string): Promise<void> {
  const [[sql]] = (await rowsOf(conn, `SELECT sql FROM duckdb_views() WHERE view_name = '${view}' AND NOT temporary`)) as [[string]];
  const create = new RegExp(`^CREATE VIEW (main\\.)?${view} AS`, "i");
  const reads = new RegExp(`\\bFROM ${from}\\b`, "g");
  if (!create.test(sql) || (sql.match(reads) ?? []).length !== 1) {
    throw new Error(`${view} is not defined as this repair expects: it should read ${from} exactly once`);
  }
  await conn.run(sql.replace(create, `CREATE OR REPLACE TEMP VIEW ${as} AS`).replace(reads, `FROM ${to}`));
}

const TEMP = [
  "repair_reading", "repair_volunteer_target", "repair_vol_det_taxa", "repair_expert_target", "repair_det_taxa",
  "repair_staged", "repair_pair", "repair_attach", "repair_new", "repair_ancestry",
];

export async function repairSkippedLegacyRecords(conn: DuckDBConnection, opts: { dryRun?: boolean } = {}): Promise<SkippedRepairResult> {
  await conn.run("BEGIN TRANSACTION");
  try {
    // Every set-aside second print whose kept partner became a specimen. A
    // group split by observation ranks within each observation, so the
    // partner is the kept record of the same observation.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_pair AS
      SELECT rs._id AS skipped_id, rs."fieldNumber" AS skipped_fn, k._id AS kept_id, k."fieldNumber" AS kept_fn,
             m.specimen_id, sp.sample_id
      FROM legacy_ranked rs
      JOIN legacy_ranked k
        ON k.fn IS NOT DISTINCT FROM rs.fn AND k.ln IS NOT DISTINCT FROM rs.ln AND k.sid = rs.sid
       AND k.p_date_start = rs.p_date_start AND k.p_specimen_number = rs.p_specimen_number AND k.dup_rank = 1
      JOIN legacy_specimen_map m ON m._id = k._id
      JOIN specimen sp ON sp.entity_id = m.specimen_id
      WHERE rs.dup_rank > 1
        AND NOT EXISTS (SELECT 1 FROM legacy_specimen_number n WHERE n._id = rs._id)
        AND NOT EXISTS (SELECT 1 FROM legacy_duplicate_record d WHERE d._id = rs._id)
        AND NOT EXISTS (SELECT 1 FROM legacy_promotion_finding f
                        WHERE f._id = rs._id AND f.severity = 'blocking' AND f.rule <> 'duplicate_specimen')
      QUALIFY row_number() OVER (PARTITION BY rs._id ORDER BY (k.p_inat_obs_id IS NOT DISTINCT FROM rs.p_inat_obs_id) DESC, k._id) = 1`);

    // Records refused only for their date, on an observation Beeline holds
    // as a sample with no specimens, collected by the same person.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_attach AS
      SELECT r._id, r."fieldNumber" AS field_number, r.p_specimen_number, s.entity_id AS sample_id, s.inat_observation_id
      FROM legacy_ranked r
      JOIN sample s ON s.inat_observation_id = r.p_inat_obs_id
      WHERE regexp_matches(r.url, '/observations/[0-9]+$')
        AND NOT EXISTS (SELECT 1 FROM legacy_specimen_number n WHERE n._id = r._id)
        AND (SELECT list(DISTINCT f.rule) FROM legacy_promotion_finding f WHERE f._id = r._id AND f.severity = 'blocking') = ['bad_date']
        AND NOT EXISTS (SELECT 1 FROM specimen sp WHERE sp.sample_id = s.entity_id)
        AND EXISTS (SELECT 1 FROM legacy_person_map pm JOIN sample_primary_collector pc ON pc.person_id = pm.person_id
                    WHERE pm.fn IS NOT DISTINCT FROM r.fn AND pm.ln IS NOT DISTINCT FROM r.ln AND pc.sample_id = s.entity_id)`);

    // Promotion's name rules, over these records only.
    await conn.run(`
      CREATE OR REPLACE TEMP VIEW repair_staged AS
      SELECT * FROM legacy_ranked
      WHERE _id IN (SELECT skipped_id FROM temp.repair_pair UNION ALL SELECT _id FROM temp.repair_attach)`);
    await repoint(conn, "legacy_det_taxa", "repair_det_taxa", "legacy_promotable", "temp.repair_staged");
    await repoint(conn, "legacy_expert_target", "repair_expert_target", "legacy_det_taxa", "temp.repair_det_taxa");
    await repoint(conn, "legacy_vol_det_taxa", "repair_vol_det_taxa", "legacy_promotable", "temp.repair_staged");
    await repoint(conn, "legacy_volunteer_target", "repair_volunteer_target", "legacy_vol_det_taxa", "temp.repair_vol_det_taxa");

    // Each record's two identifications, as promote-determinations.sql reads them.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_reading AS
      SELECT r._id,
             e.name AS e_name, ae.entity_id AS e_animal, e.qualifier AS e_qualifier,
             coalesce(e.verbatim, CASE WHEN e.written IS DISTINCT FROM e.name THEN e.written END) AS e_verbatim,
             legacy_sex_of(r.sex, r.caste) AS e_sex, legacy_caste_of(r.caste, r.sex) AS e_caste,
             dp.person_id AS e_determiner, nullif(trim(r."identifiedBy"), '') AS e_determiner_name,
             v.name AS v_name, av.entity_id AS v_animal,
             CASE WHEN v.written IS DISTINCT FROM v.name THEN v.written END AS v_verbatim,
             legacy_sex_of(r."sexVolDet", r."casteVolDet") AS v_sex, legacy_caste_of(r."casteVolDet", r."sexVolDet") AS v_caste
      FROM temp.repair_staged r
      LEFT JOIN temp.repair_expert_target e ON e._id = r._id AND e.rank IS NOT NULL
      LEFT JOIN animal ae ON ae.rank = e.rank AND ae.scientific_name = e.name
      LEFT JOIN temp.repair_volunteer_target v ON v._id = r._id AND v.rank IS NOT NULL
      LEFT JOIN animal av ON av.rank = v.rank AND av.scientific_name = v.name
      LEFT JOIN legacy_determiner_person dp ON dp.alias = trim(r."identifiedBy")`);
    const unresolved = (
      await rowsOf(
        conn,
        `SELECT DISTINCT n FROM (
           SELECT e_name AS n FROM temp.repair_reading WHERE e_name IS NOT NULL AND e_animal IS NULL
           UNION ALL SELECT v_name FROM temp.repair_reading WHERE v_name IS NOT NULL AND v_animal IS NULL) ORDER BY 1`,
      )
    ).map(([n]) => String(n));

    // Two bees: both records carry an expert identification and neither is
    // the other's taxon or an ancestor of it.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_ancestry AS
      WITH RECURSIVE up(node_id, anc_id) AS (
        SELECT entity_id, entity_id FROM animal
        UNION ALL
        SELECT up.node_id, a.parent_id FROM up JOIN animal a ON a.entity_id = up.anc_id WHERE a.parent_id IS NOT NULL
      ) SELECT * FROM up`);
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_new AS
      SELECT p.skipped_id AS _id, p.skipped_fn AS field_number, p.kept_fn, p.sample_id, NULL::BIGINT AS inat_observation_id,
             0 AS p_specimen_number
      FROM temp.repair_pair p JOIN temp.repair_reading rd ON rd._id = p.skipped_id
      WHERE rd.e_animal IS NOT NULL
        AND EXISTS (SELECT 1 FROM determination d WHERE d.specimen_id = p.specimen_id AND d.is_expert AND d.channel = 'legacy_import')
        AND NOT EXISTS (
          SELECT 1 FROM determination d
          WHERE d.specimen_id = p.specimen_id AND d.is_expert AND d.channel = 'legacy_import'
            AND (EXISTS (SELECT 1 FROM temp.repair_ancestry x WHERE x.node_id = d.animal_id AND x.anc_id = rd.e_animal)
                 OR EXISTS (SELECT 1 FROM temp.repair_ancestry x WHERE x.node_id = rd.e_animal AND x.anc_id = d.animal_id)))
      UNION ALL
      SELECT _id, field_number, NULL, sample_id, inat_observation_id, p_specimen_number FROM temp.repair_attach`);
    await conn.run(`DELETE FROM temp.repair_pair WHERE skipped_id IN (SELECT _id FROM temp.repair_new)`);

    const result: SkippedRepairResult = {
      tied: await scalar(conn, `SELECT count(*) FROM temp.repair_pair`),
      carriedExpert: await scalar(
        conn,
        `SELECT count(*) FROM temp.repair_pair p JOIN temp.repair_reading rd ON rd._id = p.skipped_id
         WHERE rd.e_animal IS NOT NULL AND NOT EXISTS (SELECT 1 FROM determination d WHERE d.specimen_id = p.specimen_id AND d.is_expert)`,
      ),
      carriedVolunteer: await scalar(
        conn,
        `SELECT count(*) FROM temp.repair_pair p JOIN temp.repair_reading rd ON rd._id = p.skipped_id
         WHERE rd.v_animal IS NOT NULL AND NOT EXISTS (SELECT 1 FROM determination d WHERE d.specimen_id = p.specimen_id AND NOT d.is_expert)`,
      ),
      separated: (
        await rowsOf(conn, `SELECT field_number, kept_fn FROM temp.repair_new WHERE kept_fn IS NOT NULL ORDER BY field_number`)
      ).map(([f, k]) => ({ fieldNumber: String(f), keptFieldNumber: String(k) })),
      attached: (
        await rowsOf(
          conn,
          `SELECT inat_observation_id, sample_id, count(*) FROM temp.repair_new WHERE inat_observation_id IS NOT NULL GROUP BY ALL ORDER BY 1`,
        )
      ).map(([o, s, n]) => ({ observation: Number(o), sampleId: Number(s), specimens: Number(n) })),
      newSpecimenDeterminations: await scalar(
        conn,
        `SELECT count(rd.e_animal) + count(rd.v_animal) FROM temp.repair_new n JOIN temp.repair_reading rd USING (_id)`,
      ),
      unresolved,
      dryRun: opts.dryRun ?? false,
    };

    // Carry what each specimen lacks, from its set-aside second print, and
    // tie the record to it. The counts above are taken before, so the
    // volunteer insert does not see the expert one.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_carry AS
      SELECT p.skipped_id, p.specimen_id, pc.person_id AS collector_id, rd.*,
             NOT EXISTS (SELECT 1 FROM determination d WHERE d.specimen_id = p.specimen_id AND d.is_expert) AS lacks_expert,
             NOT EXISTS (SELECT 1 FROM determination d WHERE d.specimen_id = p.specimen_id AND NOT d.is_expert) AS lacks_volunteer
      FROM temp.repair_pair p
      JOIN temp.repair_reading rd ON rd._id = p.skipped_id
      LEFT JOIN sample_primary_collector pc ON pc.sample_id = p.sample_id`);
    await conn.run(`
      INSERT INTO determination (specimen_id, animal_id, qualifier, verbatim_identification, sex, caste,
                                 determiner_id, determiner_name, is_expert, channel)
      SELECT specimen_id, e_animal, e_qualifier, e_verbatim, e_sex, e_caste, e_determiner, e_determiner_name, true, 'legacy_import'
      FROM temp.repair_carry WHERE lacks_expert AND e_animal IS NOT NULL ORDER BY specimen_id`);
    await conn.run(`
      INSERT INTO determination (specimen_id, animal_id, verbatim_identification, sex, caste, determiner_id, is_expert, channel)
      SELECT specimen_id, v_animal, v_verbatim, v_sex, v_caste, collector_id, false, 'legacy_import'
      FROM temp.repair_carry WHERE lacks_volunteer AND v_animal IS NOT NULL ORDER BY specimen_id`);
    await conn.run(`INSERT INTO legacy_duplicate_record (_id, specimen_id) SELECT skipped_id, specimen_id FROM temp.repair_pair`);

    // New specimens, numbered after their sample's last, in the old numbering's order.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_numbered AS
      SELECT n._id, n.sample_id, nullif(n.field_number, '') AS field_number,
             CAST(coalesce((SELECT max(sp.specimen_number) FROM specimen sp WHERE sp.sample_id = n.sample_id), 0)
                  + row_number() OVER (PARTITION BY n.sample_id ORDER BY n.p_specimen_number, n._id) AS INTEGER) AS specimen_number
      FROM temp.repair_new n`);
    await conn.run(`
      INSERT INTO specimen (sample_id, specimen_number, field_number)
      SELECT sample_id, specimen_number, field_number FROM temp.repair_numbered ORDER BY sample_id, specimen_number`);
    await conn.run(`INSERT INTO legacy_specimen_number (_id, sample_id, specimen_number) SELECT _id, sample_id, specimen_number FROM temp.repair_numbered`);
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_new_reading AS
      SELECT sp.entity_id AS specimen_id, pc.person_id AS collector_id, rd.*
      FROM temp.repair_numbered n
      JOIN specimen sp ON sp.sample_id = n.sample_id AND sp.specimen_number = n.specimen_number
      JOIN temp.repair_reading rd ON rd._id = n._id
      LEFT JOIN sample_primary_collector pc ON pc.sample_id = n.sample_id`);
    await conn.run(`
      INSERT INTO determination (specimen_id, animal_id, qualifier, verbatim_identification, sex, caste,
                                 determiner_id, determiner_name, is_expert, channel)
      SELECT specimen_id, e_animal, e_qualifier, e_verbatim, e_sex, e_caste, e_determiner, e_determiner_name, true, 'legacy_import'
      FROM temp.repair_new_reading WHERE e_animal IS NOT NULL ORDER BY specimen_id`);
    await conn.run(`
      INSERT INTO determination (specimen_id, animal_id, verbatim_identification, sex, caste, determiner_id, is_expert, channel)
      SELECT specimen_id, v_animal, v_verbatim, v_sex, v_caste, collector_id, false, 'legacy_import'
      FROM temp.repair_new_reading WHERE v_animal IS NOT NULL ORDER BY specimen_id`);

    await conn.run(opts.dryRun ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (err) {
    await conn.run("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    for (const t of [...TEMP, "repair_carry", "repair_numbered", "repair_new_reading"]) {
      await conn.run(`DROP VIEW IF EXISTS temp.${t}`).catch(() => {});
      await conn.run(`DROP TABLE IF EXISTS temp.${t}`).catch(() => {});
    }
  }
}

/** What the repair did, or would do, for the CLI. */
export function describeSkippedRepair(r: SkippedRepairResult): string {
  const verb = r.dryRun ? "would be" : "were";
  const lines = [
    `${r.tied} set-aside second print(s) ${verb} tied to their specimen; ${r.carriedExpert} expert and ${r.carriedVolunteer} volunteer identification(s) ${verb} carried to a specimen that lacked one`,
    `${r.separated.length} ${verb} made specimens of their own, the second bee of a pair: ${r.separated.map((s) => `${s.fieldNumber} (beside ${s.keptFieldNumber})`).join(", ") || "none"}`,
    `${r.attached.reduce((a, x) => a + x.specimens, 0)} ${verb} made specimens of the sample of their observation: ${r.attached.map((a) => `${a.specimens} on observation ${a.observation} (sample ${a.sampleId})`).join(", ") || "none"}`,
    `${r.newSpecimenDeterminations} identification(s) ${verb} recorded for the new specimens`,
  ];
  if (r.unresolved.length > 0) lines.push(`names matching no taxon, not recorded: ${r.unresolved.join(", ")}`);
  return lines.join("\n");
}

// CLI: pnpm legacy:repair-skipped [db] [--dry-run]
// Against a store the app is not holding: production in maintenance mode, or a copy.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  for (const f of flags) if (f !== "--dry-run") throw new Error(`unknown option ${f}`);
  const dbPath = args.find((a) => !a.startsWith("--")) ?? process.env.BEELINE_DB ?? "beeline.duckdb";
  const { openDuckDb } = await import("./db.js");
  const instance = await openDuckDb(dbPath);
  const conn = await instance.connect();
  try {
    const result = await repairSkippedLegacyRecords(conn, { dryRun: flags.has("--dry-run") });
    console.log(describeSkippedRepair(result));
    if (!flags.has("--dry-run")) await conn.run("CHECKPOINT");
  } finally {
    conn.closeSync();
  }
}
