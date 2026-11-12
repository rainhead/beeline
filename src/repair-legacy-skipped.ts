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
 * a volunteer's identification the kept one lacked.
 *
 * NOT EVERY PAIR IS ONE PIN. Promotion calls two records the same specimen
 * when they share a collector, date, sample number and specimen number, and
 * looks at nothing else. Many pairs disagree on how the bee was caught: in
 * 2019 one collector's sample 1 of 8 August was netted (1925139 onward) and
 * also pan-trapped (2121499 onward), and the expert identified 1925139 as a
 * drone and 2121499 as a worker of the same species. Those are two
 * collections sharing a sample number. So this acts only on a pair that
 * looks like a reprint: the same method, recorded within a kilometre, and no
 * sex or caste stated on both records that differs, nor experts who named
 * different bees. The rest, 144 of 258 on that store, it ties to nothing,
 * and says so on the specimen (REMARKS, below). For each set-aside record of a reprint
 * whose kept partner became a specimen, this
 *   - carries its expert identification to the specimen if the specimen has
 *     no expert determination, and its volunteer identification if it has no
 *     volunteer determination, as promotion would have recorded them;
 *   - records it in legacy_duplicate_record, so the nightly import of the old
 *     Beeline's volunteer determinations follows it as well.
 * Which of the two field numbers is on the pin is not decided here: that
 * takes somebody looking at the pins.
 *
 * RECORDS MISSING A DETAIL. A record refused for a missing or unreadable
 * collector, sample number, specimen number or date, that names its
 * collector and leads to exactly one sample (by its observation, or by the
 * records Beeline holds of the same collector and sample number on one of
 * its dates), is a second record of a specimen of that sample if one of its
 * records carries the same specimen number, and joins the pairs above;
 * otherwise it becomes a specimen of the sample if its number is free, or,
 * with none, if the sample counts more specimens than Beeline holds. The
 * 2020 records numbered 0 beside a full series printed later for the same
 * observation are therefore left out: they are not bees.
 *
 * REMARKS. What this cannot settle it says on the specimen, as
 * occurrenceRemarks (writeRemarks): Andony's answer on GitHub #303 was to
 * flag the doubt where Linc or any taxonomist will read it, not to have
 * somebody settle it first.
 *
 * A DATE WRITTEN BACKWARDS, ON AN OBSERVATION BEELINE HOLDS. A record refused
 * only for its date (the end before the start, or unreadable), linked to an
 * iNaturalist observation that is already a sample in Beeline with no
 * specimens and the same collector, and no other sample, becomes a specimen
 * of that sample. The sample's date is the observation's, so the record's
 * own date is not needed. On the store of 9 November 2026 this was one net
 * sample of 2020, 34 specimens on observation 56359335, whose old records
 * say they were collected from 2 August to 1 August; the observation is
 * dated 2 August, and its fields put the collecting on 1 August.
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
  /** Of those, records refused for a missing detail that turned out to be a second record of a specimen. */
  tiedRefused: number;
  /** Pairs left alone because the two records disagree, by what they disagree on. */
  leftAlone: { reason: string; pairs: number }[];
  /** Identifications carried from them to a specimen that lacked one. */
  carriedExpert: number;
  carriedVolunteer: number;
  /** Records given a specimen in the sample of their observation. */
  attached: { observation: number; sampleId: number; specimens: number }[];
  /** Records refused for a missing detail, given a specimen in the one sample they lead to. */
  placed: number;
  /** Specimens given a remark saying what about their old records is in doubt, by what is (specimen_disposition). */
  remarked: { kind: "placed" | "pin" | "pair"; specimens: number }[];
  /** Specimens that would have had a remark but already carry one from somewhere else, left as they are. */
  remarkLeftAlone: number;
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
  "repair_unsure", "repair_reading", "repair_volunteer_target", "repair_vol_det_taxa", "repair_expert_target", "repair_det_taxa",
  "repair_staged", "repair_pair", "repair_attach", "repair_new", "repair_ancestry",
  "repair_loose", "repair_loose_sample", "repair_loose_one", "repair_loose_twin", "repair_placed", "repair_remark",
];

/** Kilometres between two legacy records' coordinates. */
const km = (a: string, b: string) =>
  `6371 * 2 * asin(sqrt(pow(sin(radians(${b}.p_lat - ${a}.p_lat) / 2), 2)
     + cos(radians(${a}.p_lat)) * cos(radians(${b}.p_lat)) * pow(sin(radians(${b}.p_lon - ${a}.p_lon) / 2), 2)))`;

/**
 * Why two records of one collector, date, sample and specimen number may not
 * be one pin printed twice, or null where nothing says so: `s` is the record
 * set aside, `k` the one Beeline holds.
 *
 * A second print must show it is one: the same method and coordinates
 * within a kilometre. A record refused for a missing detail (`sparse`) is
 * held only to not contradicting the one Beeline holds, because a blank is
 * what such a record is made of: the 2018 entries of Nicole Sanchez's 2017
 * specimens carry the expert's identification and nothing else, no method,
 * place or coordinates.
 */
const unsureCase = (s: string, k: string, sparse = false) => `
  CASE
    WHEN nullif(lower(trim(${s}."samplingProtocol")), '') IS DISTINCT FROM nullif(lower(trim(${k}."samplingProtocol")), '')
      ${sparse ? `AND nullif(trim(${s}."samplingProtocol"), '') IS NOT NULL AND nullif(trim(${k}."samplingProtocol"), '') IS NOT NULL` : ""}
      THEN 'caught by a different method'
    WHEN ${sparse ? "false" : `${s}.p_lat IS NULL OR ${s}.p_lon IS NULL OR ${k}.p_lat IS NULL OR ${k}.p_lon IS NULL`}
      THEN 'no coordinates to compare'
    WHEN ${km(s, k)} > 1
      THEN 'recorded more than a kilometre apart'
    WHEN legacy_sex_of(${s}.sex, ${s}.caste) <> legacy_sex_of(${k}.sex, ${k}.caste)
      OR legacy_caste_of(${s}.caste, ${s}.sex) <> legacy_caste_of(${k}.caste, ${k}.sex)
      OR legacy_sex_of(${s}."sexVolDet", ${s}."casteVolDet") <> legacy_sex_of(${k}."sexVolDet", ${k}."casteVolDet")
      OR legacy_caste_of(${s}."casteVolDet", ${s}."sexVolDet") <> legacy_caste_of(${k}."casteVolDet", ${k}."sexVolDet")
      THEN 'a different sex or caste'
  END`;

/** Who the remarks this repair writes are credited to, and where they came from (specimen_disposition). */
export const REMARK_STATED_BY = "Beeline, from the old Beeline's records";
export const REMARK_SOURCE = "pnpm legacy:repair-skipped (beeline-iuva, GitHub #303)";

/** A legacy record's specimen number: the one written, or else the last part of a 2017–2018 field number such as Nicole_Sanchez:17.006.006, whose middle part is the sample. */
const numberOf = (r: string) => `
  coalesce(CASE WHEN ${r}.p_specimen_number > 0 THEN ${r}.p_specimen_number END,
           CASE WHEN regexp_full_match(${r}."fieldNumber", '[^:]+:[0-9]+[.][0-9]+[.][0-9]+')
                 AND (${r}.sid IS NULL OR try_cast(${r}.sid AS INTEGER) = try_cast(regexp_extract(${r}."fieldNumber", ':[0-9]+[.]([0-9]+)[.]', 1) AS INTEGER))
                THEN nullif(try_cast(regexp_extract(${r}."fieldNumber", '[.]([0-9]+)$', 1) AS INTEGER), 0) END)`;

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Today's date where the program is, which is the date a remark is good for. */
const oregonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

/** Whether a legacy record carries an expert's, or a volunteer's, identification at all. */
const hasExpert = (r: string) => `(coalesce(nullif(trim(${r}.genus), ''), nullif(trim(${r}."scientificName"), '')) IS NOT NULL)`;
const hasVolunteer = (r: string) =>
  `(coalesce(nullif(trim(${r}."familyVolDet"), ''), nullif(trim(${r}."genusVolDet"), ''), nullif(trim(${r}."speciesVolDet"), '')) IS NOT NULL)`;

/** An identification as the old record gave it, read by promotion's rules: "Bombus vosnesenskii, female worker (expert)". */
const identification = (rd: string) => `
  concat_ws('; ',
    CASE WHEN ${rd}.e_name IS NOT NULL THEN concat(${rd}.e_name,
      CASE WHEN ${rd}.e_sex IS NOT NULL OR ${rd}.e_caste IS NOT NULL THEN concat(', ', concat_ws(' ', ${rd}.e_sex, ${rd}.e_caste)) END, ' (expert)') END,
    CASE WHEN ${rd}.v_name IS NOT NULL THEN concat(${rd}.v_name, ' (volunteer)') END)`;

/**
 * The remarks, one sentence for each thing in doubt about a specimen's old
 * records, written to specimen_disposition as occurrenceRemarks. Three kinds:
 *   placed: a record refused for a missing detail, placed by an assumption,
 *     which the sentence states;
 *   pin: a specimen printed twice whose identifications were entered under
 *     the number Beeline does not use, which is probably the one on the pin;
 *   pair: a specimen whose old records include another with its collector,
 *     date, sample and specimen number that differs from it, so may be a
 *     second bee.
 * A specimen that already has a remark from somewhere else (the 2025
 * inventory) is left as it is and counted, rather than have its words mixed
 * with these or credited to someone who did not write them. A specimen this
 * repair already remarked on is left as it is too, so a second run writes
 * nothing.
 */
async function writeRemarks(conn: DuckDBConnection, result: SkippedRepairResult, statedOn: string): Promise<void> {
  await conn.run(`CREATE OR REPLACE TEMP TABLE repair_remark (specimen_id INTEGER, kind TEXT, sentence TEXT)`);
  await conn.run(`
    INSERT INTO temp.repair_remark
    SELECT n_sp.entity_id, 'placed',
      concat('Old Beeline''s record of this specimen, field number ', p.field_number, ', ',
        coalesce(nullif(concat_ws(', and ',
          CASE
            WHEN p.p_date_start IS NULL AND p.day = '' AND p.month = '' THEN concat('gives only the year it was collected, ', p.year)
            WHEN p.p_date_start IS NULL AND p.day = '' THEN concat('gives no day of collection, only ', p.month, '/', p.year)
            WHEN p.p_date_start IS NULL THEN concat('gives its collection date as ', p.day, '/', p.month, '/', p.year)
            WHEN p.year2 <> '' AND (p.p_date_end IS NULL OR p.p_date_end < p.p_date_start)
              THEN concat('gives its collection dates as ', p.day, '/', p.month, '/', p.year, ' to ', p.day2, '/', p.month2, '/', p.year2,
                          ', which end before they start')
          END,
          CASE WHEN p.sid IS NULL THEN 'has no sample number' END,
          CASE WHEN p.p_specimen_number > 0 THEN NULL
               WHEN p.specimen_written IS NULL THEN 'has no specimen number'
               ELSE concat('gives its specimen number as ', p.specimen_written) END
        ), ''), 'could not be placed as written'),
        ', so new Beeline placed it ',
        CASE WHEN p.by_collector
             THEN concat('with the collector''s other specimens of sample ', p.sample_number, ' from ', strftime(p.sample_date, '%-d %B %Y'))
             ELSE 'in the sample of its iNaturalist observation' END,
        CASE WHEN p.p_specimen_number > 0 THEN ''
             WHEN p.number IS NOT NULL THEN concat(', reading its specimen number, ', p.number, ', from its field number')
             ELSE ', as the specimen that sample counted but Beeline did not hold' END,
        '.')
    FROM temp.repair_placed p
    JOIN temp.repair_numbered nb ON nb._id = p._id
    JOIN specimen n_sp ON n_sp.sample_id = nb.sample_id AND n_sp.specimen_number = nb.specimen_number`);
  await conn.run(`
    INSERT INTO temp.repair_remark
    SELECT d.specimen_id, 'pin',
      concat('Old Beeline recorded this specimen twice, as ', k."fieldNumber", ' and ', s."fieldNumber", '. ',
        CASE WHEN ${hasExpert("s")} AND NOT ${hasExpert("k")} AND ${hasVolunteer("s")} AND NOT ${hasVolunteer("k")}
               THEN 'Its identifications were'
             WHEN ${hasExpert("s")} AND NOT ${hasExpert("k")} THEN 'Its expert identification was'
             ELSE 'Its volunteer identification was' END,
        ' entered under ', s."fieldNumber", ', so that is probably the number on the pin.')
    FROM legacy_duplicate_record d
    JOIN legacy_ranked s ON s._id = d._id
    JOIN legacy_specimen_map m ON m.specimen_id = d.specimen_id
    JOIN legacy_ranked k ON k._id = m._id
    WHERE (${hasExpert("s")} AND NOT ${hasExpert("k")}) OR (${hasVolunteer("s")} AND NOT ${hasVolunteer("k")})`);
  await conn.run(`
    INSERT INTO temp.repair_remark
    SELECT u.specimen_id, 'pair',
      concat('Old Beeline also has field number ', u.skipped_fn, ' for this collector, date, sample number and specimen number, but ',
        CASE u.unsure
          WHEN 'caught by a different method' THEN concat('that record says ',
            coalesce(nullif(lower(trim(s."samplingProtocol")), ''), 'nothing about the method'), ' and this one ',
            coalesce(nullif(lower(trim(k."samplingProtocol")), ''), 'nothing'))
          WHEN 'recorded more than a kilometre apart' THEN concat('the two were recorded ', printf('%.1f', ${km("s", "k")}), ' km apart')
          WHEN 'a different sex or caste' THEN 'the two give the bee a different sex or caste'
          WHEN 'the experts named different bees' THEN 'their experts named different bees'
          ELSE 'one of the two has no coordinates, so Beeline cannot tell whether they were caught in the same place'
        END,
        ', so it may be a second bee. ',
        CASE WHEN rd.e_name IS NOT NULL OR rd.v_name IS NOT NULL
             THEN concat('That record identifies it as ', ${identification("rd")}, '.')
             ELSE 'That record has no identification.' END)
    FROM temp.repair_unsure u
    JOIN legacy_ranked s ON s._id = u.skipped_id
    JOIN legacy_ranked k ON k._id = u.kept_id
    LEFT JOIN temp.repair_reading rd ON rd._id = u.skipped_id`);

  await conn.run(`
    CREATE OR REPLACE TEMP TABLE repair_remark_new AS
    SELECT specimen_id,
           string_agg(sentence, ' ' ORDER BY CASE kind WHEN 'placed' THEN 1 WHEN 'pin' THEN 2 ELSE 3 END, sentence) AS remarks,
           list(DISTINCT kind) AS kinds
    FROM temp.repair_remark r
    WHERE NOT EXISTS (SELECT 1 FROM specimen_disposition d WHERE d.specimen_id = r.specimen_id)
    GROUP BY specimen_id`);
  result.remarked = (
    await rowsOf(
      conn,
      `SELECT kind, count(*) FROM (SELECT unnest(kinds) AS kind FROM temp.repair_remark_new)
       GROUP BY 1 ORDER BY CASE kind WHEN 'placed' THEN 1 WHEN 'pin' THEN 2 ELSE 3 END`,
    )
  ).map(([kind, n]) => ({ kind: kind as "placed" | "pin" | "pair", specimens: Number(n) }));
  result.remarkLeftAlone = await scalar(
    conn,
    `SELECT count(DISTINCT r.specimen_id) FROM temp.repair_remark r
     JOIN specimen_disposition d ON d.specimen_id = r.specimen_id WHERE d.source <> ${sqlString(REMARK_SOURCE)}`,
  );
  await conn.run(`
    INSERT INTO specimen_disposition (specimen_id, disposition, remarks, stated_by, stated_on, source)
    SELECT specimen_id, NULL, remarks, ${sqlString(REMARK_STATED_BY)}, DATE ${sqlString(statedOn)}, ${sqlString(REMARK_SOURCE)}
    FROM temp.repair_remark_new ORDER BY specimen_id`);
}

export async function repairSkippedLegacyRecords(
  conn: DuckDBConnection,
  opts: { dryRun?: boolean; statedOn?: string } = {},
): Promise<SkippedRepairResult> {
  await conn.run("BEGIN TRANSACTION");
  try {
    // Every set-aside second print whose kept partner became a specimen. A
    // group split by observation ranks within each observation, so the
    // partner is the kept record of the same observation.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_pair AS
      SELECT rs._id AS skipped_id, rs."fieldNumber" AS skipped_fn, k._id AS kept_id, k."fieldNumber" AS kept_fn,
             m.specimen_id, sp.sample_id, ${unsureCase("rs", "k")} AS unsure, false AS refused
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
        AND (SELECT count(*) FROM sample o WHERE o.inat_observation_id = s.inat_observation_id) = 1
        AND EXISTS (SELECT 1 FROM legacy_person_map pm JOIN sample_primary_collector pc ON pc.person_id = pm.person_id
                    WHERE pm.fn IS NOT DISTINCT FROM r.fn AND pm.ln IS NOT DISTINCT FROM r.ln AND pc.sample_id = s.entity_id)`);

    // Every other record refused for a missing or unreadable detail that
    // names its collector, and the samples it could belong to: the sample
    // of its iNaturalist observation, where that is one sample of the same
    // collector, and the sample of any record Beeline holds with the same
    // collector and sample number, dated on one of its dates or, where its
    // own date cannot be read, in the same year and month.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_loose AS
      SELECT r._id, r."fieldNumber" AS field_number, r.fn, r.ln, r.sid, r.p_date_start, r.p_date_end,
             coalesce(trim(r.day), '') AS day, coalesce(trim(r.month), '') AS month, coalesce(trim(r.year), '') AS year,
             coalesce(trim(r.day2), '') AS day2, coalesce(trim(r.month2), '') AS month2, coalesce(trim(r.year2), '') AS year2,
             r.p_specimen_number, nullif(trim(r."specimenId"), '') AS specimen_written,
             CASE WHEN regexp_matches(r.url, '/observations/[0-9]+$') THEN r.p_inat_obs_id END AS obs,
             ${numberOf("r")} AS number
      FROM legacy_ranked r
      WHERE r.dup_rank = 1
        AND (r.fn IS NOT NULL OR r.ln IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM legacy_specimen_number n WHERE n._id = r._id)
        AND NOT EXISTS (SELECT 1 FROM legacy_duplicate_record d WHERE d._id = r._id)
        AND r._id NOT IN (SELECT _id FROM temp.repair_attach)
        AND EXISTS (SELECT 1 FROM legacy_promotion_finding f WHERE f._id = r._id AND f.severity = 'blocking')`);
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_loose_sample AS
      SELECT l._id, s.entity_id AS sample_id, 'observation' AS via
      FROM temp.repair_loose l JOIN sample s ON s.inat_observation_id = l.obs
      WHERE (SELECT count(*) FROM sample o WHERE o.inat_observation_id = l.obs) = 1
        AND EXISTS (SELECT 1 FROM legacy_person_map pm JOIN sample_primary_collector pc ON pc.person_id = pm.person_id
                    WHERE pm.fn IS NOT DISTINCT FROM l.fn AND pm.ln IS NOT DISTINCT FROM l.ln AND pc.sample_id = s.entity_id)
      UNION
      SELECT l._id, n.sample_id, 'collector'
      FROM temp.repair_loose l
      JOIN legacy_ranked k
        ON k.fn IS NOT DISTINCT FROM l.fn AND k.ln IS NOT DISTINCT FROM l.ln AND k.sid = l.sid
       AND (k.p_date_start = l.p_date_start OR k.p_date_start = l.p_date_end
            OR (l.p_date_start IS NULL AND k.year = l.year
                AND (legacy_month(l.month) IS NULL OR legacy_month(k.month) = legacy_month(l.month))))
      JOIN legacy_specimen_number n ON n._id = k._id`);
    // Only a record that leads to exactly one sample is placed anywhere.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_loose_one AS
      SELECT _id, min(sample_id) AS sample_id, bool_or(via = 'collector') AS by_collector
      FROM temp.repair_loose_sample GROUP BY _id HAVING count(DISTINCT sample_id) = 1`);
    // A record whose specimen number one record of that sample already
    // carries is a second record of that specimen: the 2017 field numbers
    // were entered again in 2018 under an 18 for the 17
    // (Nicole_Sanchez:18.006.006 and 17.006.006). It joins the pairs, to be
    // tied or left alone by the same tests as a set-aside second print.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_loose_twin AS
      SELECT o._id, k._id AS kept_id, k."fieldNumber" AS kept_fn, m.specimen_id, o.sample_id
      FROM temp.repair_loose_one o
      JOIN temp.repair_loose l USING (_id)
      JOIN legacy_specimen_number n ON n.sample_id = o.sample_id
      JOIN legacy_ranked k ON k._id = n._id
      JOIN legacy_specimen_map m ON m._id = k._id
      WHERE ${numberOf("k")} = l.number
      QUALIFY count(*) OVER (PARTITION BY o._id) = 1`);
    await conn.run(`
      INSERT INTO temp.repair_pair (skipped_id, skipped_fn, kept_id, kept_fn, specimen_id, sample_id, unsure, refused)
      SELECT t._id, r."fieldNumber", t.kept_id, t.kept_fn, t.specimen_id, t.sample_id, ${unsureCase("r", "k", true)}, true
      FROM temp.repair_loose_twin t JOIN legacy_ranked r ON r._id = t._id JOIN legacy_ranked k ON k._id = t.kept_id`);
    // The rest go into their sample as a specimen of it, if their number is
    // one no record of the sample carries, or, with no number, if the sample
    // counts more specimens than Beeline holds for it. Two records claiming
    // one number in one sample are left out, both.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_placed AS
      SELECT l.*, o.sample_id, o.by_collector, s.sample_number, s.date_start AS sample_date
      FROM temp.repair_loose l
      JOIN temp.repair_loose_one o USING (_id)
      JOIN sample s ON s.entity_id = o.sample_id
      WHERE l._id NOT IN (SELECT _id FROM temp.repair_loose_twin)
      QUALIFY CASE
        WHEN l.number IS NOT NULL THEN count(*) OVER (PARTITION BY o.sample_id, l.number) = 1
        ELSE s.specimen_count - (SELECT count(*) FROM specimen sp WHERE sp.sample_id = o.sample_id)
             >= count(*) FILTER (WHERE l.number IS NULL) OVER (PARTITION BY o.sample_id)
      END`);

    // A pair that does not look like one pin printed twice is left alone.
    await conn.run(`CREATE OR REPLACE TEMP TABLE repair_unsure AS SELECT * FROM temp.repair_pair WHERE unsure IS NOT NULL`);
    await conn.run(`DELETE FROM temp.repair_pair WHERE unsure IS NOT NULL`);

    // Promotion's name rules, over these records only.
    await conn.run(`
      CREATE OR REPLACE TEMP VIEW repair_staged AS
      SELECT * FROM legacy_ranked
      WHERE _id IN (SELECT skipped_id FROM temp.repair_pair UNION ALL SELECT skipped_id FROM temp.repair_unsure
                    UNION ALL SELECT _id FROM temp.repair_attach UNION ALL SELECT _id FROM temp.repair_placed)`);
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

    // Experts who named different bees: both records carry an expert
    // identification and neither is the other's taxon or an ancestor of it.
    // That pair is not one pin either, but it is not plainly two: sample
    // 103780's observation says it holds three bees, which Beeline has, so
    // its set-aside 2012711 (Halictus tripartitus against 2045567's Andrena
    // lawrencei) is more likely one of those three numbered in another order
    // than a fourth. So it is left alone too.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_ancestry AS
      WITH RECURSIVE up(node_id, anc_id) AS (
        SELECT entity_id, entity_id FROM animal
        UNION ALL
        SELECT up.node_id, a.parent_id FROM up JOIN animal a ON a.entity_id = up.anc_id WHERE a.parent_id IS NOT NULL
      ) SELECT * FROM up`);
    await conn.run(`
      INSERT INTO temp.repair_unsure
      SELECT p.* REPLACE ('the experts named different bees' AS unsure)
      FROM temp.repair_pair p JOIN temp.repair_reading rd ON rd._id = p.skipped_id
      WHERE rd.e_animal IS NOT NULL
        AND EXISTS (SELECT 1 FROM determination d WHERE d.specimen_id = p.specimen_id AND d.is_expert AND d.channel = 'legacy_import')
        AND NOT EXISTS (
          SELECT 1 FROM determination d
          WHERE d.specimen_id = p.specimen_id AND d.is_expert AND d.channel = 'legacy_import'
            AND (EXISTS (SELECT 1 FROM temp.repair_ancestry x WHERE x.node_id = d.animal_id AND x.anc_id = rd.e_animal)
                 OR EXISTS (SELECT 1 FROM temp.repair_ancestry x WHERE x.node_id = rd.e_animal AND x.anc_id = d.animal_id)))`);
    await conn.run(`DELETE FROM temp.repair_pair WHERE skipped_id IN (SELECT skipped_id FROM temp.repair_unsure)`);
    // Names of identifications that would be recorded, but match no taxon.
    const unresolved = (
      await rowsOf(
        conn,
        `SELECT DISTINCT n FROM (
           SELECT _id, e_name AS n FROM temp.repair_reading WHERE e_name IS NOT NULL AND e_animal IS NULL
           UNION ALL SELECT _id, v_name FROM temp.repair_reading WHERE v_name IS NOT NULL AND v_animal IS NULL
         ) WHERE _id NOT IN (SELECT skipped_id FROM temp.repair_unsure) ORDER BY 1`,
      )
    ).map(([n]) => String(n));
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE repair_new AS
      SELECT _id, field_number, sample_id, inat_observation_id, p_specimen_number FROM temp.repair_attach
      UNION ALL
      SELECT _id, field_number, sample_id, NULL, number FROM temp.repair_placed`);
    // A specimen printed three times would have two set-aside records, which
    // could carry two different identifications to it with nothing to say
    // which stands. None did on the store of 9 November 2026; were one to,
    // it waits for somebody to look rather than be guessed at.
    const crowded = (
      await rowsOf(
        conn,
        `SELECT string_agg(skipped_fn, ' and ' ORDER BY skipped_fn) FROM temp.repair_pair
         GROUP BY specimen_id HAVING count(*) > 1 ORDER BY 1`,
      )
    ).map(([fns]) => String(fns));
    if (crowded.length > 0) {
      throw new Error(`more than one set-aside record is a second print of the same specimen, so nothing was repaired: ${crowded.join("; ")}`);
    }

    const result: SkippedRepairResult = {
      tied: await scalar(conn, `SELECT count(*) FROM temp.repair_pair`),
      leftAlone: (
        await rowsOf(conn, `SELECT unsure, count(*) FROM temp.repair_unsure GROUP BY 1 ORDER BY 2 DESC, 1`)
      ).map(([reason, n]) => ({ reason: String(reason), pairs: Number(n) })),
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
      tiedRefused: await scalar(conn, `SELECT count(*) FROM temp.repair_pair WHERE refused`),
      attached: (
        await rowsOf(
          conn,
          `SELECT inat_observation_id, sample_id, count(*) FROM temp.repair_attach GROUP BY ALL ORDER BY 1`,
        )
      ).map(([o, s, n]) => ({ observation: Number(o), sampleId: Number(s), specimens: Number(n) })),
      placed: await scalar(conn, `SELECT count(*) FROM temp.repair_placed`),
      remarked: [],
      remarkLeftAlone: 0,
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
    // A sample that now holds more specimens than it counted counts them all.
    await conn.run(`
      UPDATE sample SET specimen_count = h.held
      FROM (SELECT sample_id, CAST(count(*) AS INTEGER) AS held FROM specimen
            WHERE sample_id IN (SELECT sample_id FROM temp.repair_numbered) GROUP BY 1) h
      WHERE sample.entity_id = h.sample_id AND h.held > sample.specimen_count`);

    // What is in doubt, said on the specimen, where a taxonomist or the
    // collector will read it and every export carries it as
    // occurrenceRemarks (Andony on GitHub #303: flag it, rather than wait
    // for somebody to settle it).
    await writeRemarks(conn, result, opts.statedOn ?? oregonToday());

    await conn.run(opts.dryRun ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (err) {
    await conn.run("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    for (const t of [...TEMP, "repair_carry", "repair_numbered", "repair_new_reading", "repair_remark_new"]) {
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
    `${r.leftAlone.reduce((a, x) => a + x.pairs, 0)} pair(s) left alone for somebody to look at: ${r.leftAlone.map((x) => `${x.pairs} ${x.reason}`).join(", ") || "none"}`,
    `${r.tiedRefused} of those tied ${verb} records refused for a missing detail, a second record of a specimen Beeline holds`,
    `${r.attached.reduce((a, x) => a + x.specimens, 0)} ${verb} made specimens of the sample of their observation: ${r.attached.map((a) => `${a.specimens} on observation ${a.observation} (sample ${a.sampleId})`).join(", ") || "none"}`,
    `${r.placed} record(s) refused for a missing detail ${verb} placed in the one sample they lead to`,
    `${r.newSpecimenDeterminations} identification(s) ${verb} recorded for the new specimens`,
    `${r.remarked.reduce((a, x) => a + x.specimens, 0)} specimen(s) ${verb} given a remark: ${r.remarked.map((x) => `${x.specimens} ${x.kind}`).join(", ") || "none"}` +
      (r.remarkLeftAlone > 0 ? `; ${r.remarkLeftAlone} already carry another remark and ${verb} left as they are` : ""),
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
