import type { DuckDBConnection } from "@duckdb/node-api";
import { LEGACY_COPY_ID_PREFIX, OldBeelineApi, type OldBeelineCredentials } from "./legacy-copy.js";

/**
 * The determinations volunteers enter in the old Beeline, brought home nightly
 * (beeline-c43w). The old Beeline stays open at old.melittologist.org for
 * volunteer determinations through February 2027, and the only thing that
 * changes there until then is its five volunteer columns (familyVolDet,
 * genusVolDet, speciesVolDet, sexVolDet, casteVolDet). Legacy promotion read
 * them once, at cutover; this reads them again every night and records what
 * changed as a determination on channel `legacy_import`, made by the
 * specimen's collector, as promotion did.
 *
 * THROUGH THE OLD SYSTEM'S API, as the copy writes (src/legacy-copy.ts): an
 * admin login over HTTPS, which production already holds, where the old
 * system's database is reached only over SSH with a root key to its host
 * (Peter, 2026-11-09). The API selects records whose column is non-empty, so
 * only the 73,000 or so records naming a volunteer family, genus or species
 * are read, of the 397,000 the old system holds. A record naming only a sex is
 * not read: a determination must name a taxon, so it could not become one.
 *
 * THE SAME RULES AS PROMOTION. Each record's columns come apart by the rules
 * of ingest/parse-names.sql and the sex and caste words of
 * ingest/promote-determinations.sql, using the macros that promotion left in
 * the store (name_genus, legacy_genus_alias, legacy_sex_of and the rest). The
 * two views that apply them, legacy_vol_det_taxa and legacy_volunteer_target,
 * read the staged rows by name and cannot be pointed at tonight's, so their
 * few lines of CASE are repeated below; test/legacy-volunteer-import.test.ts
 * holds the two to the same answers by feeding the staged rows back in as
 * though the old system had sent them, which must record nothing.
 *
 * WHICH SPECIMEN. A record the old system made is the specimen promotion made
 * from it, by its `_id` (legacy_specimen_map), or, for a second print that
 * promotion set aside, the specimen a repair tied it to
 * (legacy_duplicate_record, beeline-iuva). A record whose `_id` starts
 * `beeline-specimen-` is Beeline's own copy of a specimen printed here, keyed
 * by the specimen's entity id (src/legacy-copy.ts). A record matching neither
 * is one promotion did not take, a duplicate or a blocked row, and is
 * reported, not recorded.
 *
 * WHAT COUNTS AS NEW. A record is compared with the newest `legacy_import`
 * volunteer determination of its specimen: the last thing the old system was
 * heard to say, not the newest determination of any kind. So a volunteer who
 * identified a specimen in the old Beeline and has since changed it in this
 * one is not overruled every night by the old record, which still says what
 * it said. A copy of a specimen printed here needs one more rule. Where the
 * old record had no volunteer determination, the copy writes Beeline's own
 * there, so a value read back from a copy may be Beeline's and not a
 * volunteer's: it is new only if Beeline holds no volunteer determination
 * saying the same of that specimen. The one case that rule gets wrong is a
 * volunteer going back in the old Beeline to a name they had given in this
 * one, which is not recorded.
 *
 * WHEN. A change is recorded with the night it was read as its `recorded_at`,
 * since the old system keeps no time of change. A determination made the same
 * day in each Beeline is therefore ordered arbitrarily, which Peter accepted
 * on 2026-10-31.
 *
 * WHAT IS NOT RECORDED, AND SAYS SO. A name Beeline's tree lacks; a specimen
 * two old records describe differently; and a volunteer determination
 * cleared in the old Beeline, which no determination can say. The last is
 * counted against what Beeline holds, and a night on which more than one in a
 * hundred of the old system's volunteer determinations seem to have
 * vanished records nothing and fails, since that is the old system answering
 * wrongly and not a hundred volunteers changing their minds.
 */

/** One old record's volunteer columns, as the API returned them. */
export interface OldVolunteerRecord {
  id: string;
  fieldNumber: string;
  family: string;
  genus: string;
  species: string;
  sex: string;
  caste: string;
}

export interface VolunteerImportResult {
  /** Old records naming a volunteer taxon. */
  read: number;
  /** Determinations added. */
  recorded: number;
  /** Records saying what Beeline last heard from the old system. */
  unchanged: number;
  /** Copies of specimens printed here holding a determination Beeline already has. */
  beelineOwn: number;
  /** Field numbers of records matching no specimen. */
  notInBeeline: string[];
  /** Names matching no taxon, with how many records give each. */
  unresolved: { name: string; records: number }[];
  /** Field numbers of specimens whose old records disagree. */
  conflicting: string[];
  /** Field numbers of specimens Beeline holds an old-system volunteer determination of, whose old record names nothing now. */
  cleared: string[];
  dryRun: boolean;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/**
 * Every old record naming a volunteer family, genus or species. The three
 * selections do not overlap, so no record is read twice; a record appearing
 * twice anyway, because the old system changed while it was being paged, is
 * kept once.
 */
export async function readOldVolunteerRecords(
  credentials: OldBeelineCredentials,
  opts: { signal?: AbortSignal; log?: (m: string) => void } = {},
): Promise<OldVolunteerRecord[]> {
  const api = new OldBeelineApi(credentials, opts.signal);
  await api.login();
  const selections: Record<string, string>[] = [
    { familyVolDet: "(non-empty)" },
    { familyVolDet: "(empty)", genusVolDet: "(non-empty)" },
    { familyVolDet: "(empty)", genusVolDet: "(empty)", speciesVolDet: "(non-empty)" },
  ];
  const byId = new Map<string, OldVolunteerRecord>();
  for (const filter of selections) {
    for await (const page of api.pages(filter)) {
      for (const r of page) {
        byId.set(r._id, {
          id: r._id,
          fieldNumber: str(r.fieldNumber),
          family: str(r.familyVolDet),
          genus: str(r.genusVolDet),
          species: str(r.speciesVolDet),
          sex: str(r.sexVolDet),
          caste: str(r.casteVolDet),
        });
      }
      opts.log?.(`${byId.size} old records read`);
    }
  }
  return [...byId.values()];
}

/**
 * The volunteer columns of `source` (_id, family, genus, species, sex, caste)
 * as the taxon and sex each record asserts: legacy_vol_det_taxa and
 * legacy_volunteer_target (ingest/), over any rows rather than the staged
 * ones. `written` is the spelling the volunteer used, kept only where a
 * curated spelling alias moved the name (beeline-bph).
 */
export const volunteerTargetSql = (source: string): string => `
      WITH cols AS (
        SELECT _id,
          nullif(trim(family), '')                  AS family,
          name_genus(genus)                         AS written_genus,
          name_genus(legacy_genus_alias(genus))     AS base_genus,
          name_bracketed(legacy_genus_alias(genus)) AS sub,
          name_epithet(species)                     AS written_epithet,
          legacy_sex_of(sex, caste)                 AS model_sex,
          legacy_caste_of(caste, sex)               AS model_caste
        FROM ${source}
      ), aliased AS (
        SELECT *, legacy_species_alias(written_genus, written_epithet) AS species_alias FROM cols
      ), parted AS (
        SELECT *,
          coalesce(split_part(species_alias, ' ', 1), base_genus)    AS genus_p,
          coalesce(split_part(species_alias, ' ', 2), written_epithet) AS epithet_p
        FROM aliased
      )
      SELECT _id, model_sex AS sex, model_caste AS caste,
        CASE
          WHEN sub IS NOT NULL THEN NULL
          WHEN written_genus IS NOT NULL AND written_epithet IS NOT NULL THEN concat(written_genus, ' ', written_epithet)
          WHEN written_genus IS NOT NULL THEN written_genus
        END AS written,
        CASE
          WHEN epithet_p IS NOT NULL AND genus_p IS NOT NULL THEN 'species'
          WHEN sub IS NOT NULL AND genus_p IS NOT NULL THEN 'subgenus'
          WHEN genus_p IS NOT NULL THEN 'genus'
          WHEN family IS NOT NULL THEN 'family'
        END AS rank,
        CASE
          WHEN epithet_p IS NOT NULL AND genus_p IS NOT NULL THEN concat(genus_p, ' ', epithet_p)
          WHEN sub IS NOT NULL AND genus_p IS NOT NULL THEN concat(genus_p, ' (', sub, ')')
          WHEN genus_p IS NOT NULL THEN genus_p
          WHEN family IS NOT NULL THEN family
        END AS name
      FROM parted`;

const rowsOf = async (conn: DuckDBConnection, sql: string): Promise<unknown[][]> => (await conn.runAndReadAll(sql)).getRows();
const scalar = async (conn: DuckDBConnection, sql: string): Promise<number> => Number((await rowsOf(conn, sql))[0]?.[0] ?? 0);

/** The macros promotion leaves in the store, which the rules below are made of. */
const MACROS = ["name_genus", "name_bracketed", "name_epithet", "legacy_genus_alias", "legacy_species_alias", "legacy_sex_of", "legacy_caste_of"];

/**
 * Compare tonight's old records with what Beeline holds, and record each
 * change as a determination. A dry run says what it would record and records
 * nothing. `clearedLimit` is how many vanished determinations a night may
 * show before it is taken for the old system answering wrongly: one in a
 * hundred of those Beeline holds, and never fewer than ten.
 */
export async function recordOldVolunteerDeterminations(
  conn: DuckDBConnection,
  records: OldVolunteerRecord[],
  opts: { dryRun?: boolean; clearedLimit?: number } = {},
): Promise<VolunteerImportResult> {
  const present = await scalar(
    conn,
    `SELECT count(DISTINCT function_name) FROM duckdb_functions()
     WHERE function_name IN (${MACROS.map((m) => `'${m}'`).join(", ")})`,
  );
  const mapped = (await scalar(conn, `SELECT count(*) FROM duckdb_views() WHERE view_name = 'legacy_specimen_map'`)) > 0;
  if (present !== MACROS.length || !mapped) {
    throw new Error("this store holds no legacy promotion (its name macros and legacy_specimen_map), so the old Beeline's records cannot be read against it");
  }

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(`CREATE OR REPLACE TEMP TABLE old_vol_record (
      _id VARCHAR, field_number VARCHAR, family VARCHAR, genus VARCHAR, species VARCHAR, sex VARCHAR, caste VARCHAR)`);
    const appender = await conn.createAppender("old_vol_record", "main", "temp");
    for (const r of records) {
      for (const v of [r.id, r.fieldNumber, r.family, r.genus, r.species, r.sex, r.caste]) appender.appendVarchar(v);
      appender.endRow();
    }
    appender.closeSync();

    await conn.run(`CREATE OR REPLACE TEMP TABLE old_vol_target AS ${volunteerTargetSql("temp.old_vol_record")}`);

    // Each record's specimen and taxon. The copy's key is its prefix and the
    // specimen's entity id, written without leading zeros (legacyCopyId).
    const prefixLength = LEGACY_COPY_ID_PREFIX.length;
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE old_vol_claim AS
      SELECT r._id, r.field_number, t.rank, t.name, t.written, t.sex, t.caste,
             coalesce(m.specimen_id, cp.entity_id)  AS specimen_id,
             coalesce(m.collector_id, pc.person_id) AS determiner_id,
             cp.entity_id IS NOT NULL               AS is_copy,
             an.entity_id                           AS animal_id
      FROM temp.old_vol_record r
      JOIN temp.old_vol_target t USING (_id)
      LEFT JOIN (
        SELECT _id, specimen_id, collector_id FROM legacy_specimen_map
        UNION ALL
        SELECT d._id, d.specimen_id, pc.person_id
        FROM legacy_duplicate_record d
        JOIN specimen sp ON sp.entity_id = d.specimen_id
        LEFT JOIN sample_primary_collector pc ON pc.sample_id = sp.sample_id
      ) m ON m._id = r._id
      LEFT JOIN specimen cp
        ON regexp_full_match(r._id, '${LEGACY_COPY_ID_PREFIX}[1-9][0-9]*')
       AND cp.entity_id = try_cast(substr(r._id, ${prefixLength + 1}) AS INTEGER)
      LEFT JOIN sample_primary_collector pc ON pc.sample_id = cp.sample_id
      LEFT JOIN animal an ON an.rank = t.rank AND an.scientific_name = t.name`);

    // What Beeline last heard from the old system about each specimen.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE old_vol_held AS
      SELECT specimen_id, animal_id, sex, caste
      FROM determination
      WHERE channel = 'legacy_import' AND NOT is_expert
      QUALIFY row_number() OVER (PARTITION BY specimen_id ORDER BY recorded_at DESC, entity_id DESC) = 1`);

    await conn.run(`
      CREATE OR REPLACE TEMP TABLE old_vol_status AS
      WITH readings AS (
        SELECT specimen_id, count(*) AS n
        FROM (SELECT DISTINCT specimen_id, animal_id, sex, caste FROM temp.old_vol_claim
              WHERE specimen_id IS NOT NULL AND animal_id IS NOT NULL)
        GROUP BY specimen_id
      ), c AS (
        SELECT c.*, coalesce(rd.n, 0) AS readings,
               row_number() OVER (PARTITION BY c.specimen_id, c.animal_id, c.sex, c.caste ORDER BY c._id) AS nth
        FROM temp.old_vol_claim c LEFT JOIN readings rd USING (specimen_id)
      )
      SELECT c.*, CASE
        WHEN specimen_id IS NULL THEN 'not_in_beeline'
        WHEN animal_id IS NULL THEN 'unresolved_name'
        WHEN readings > 1 THEN 'conflicting'
        WHEN nth > 1 THEN 'duplicate'
        WHEN EXISTS (SELECT 1 FROM temp.old_vol_held h
                     WHERE h.specimen_id = c.specimen_id AND h.animal_id = c.animal_id
                       AND h.sex IS NOT DISTINCT FROM c.sex AND h.caste IS NOT DISTINCT FROM c.caste) THEN 'unchanged'
        WHEN is_copy AND EXISTS (SELECT 1 FROM determination d
                     WHERE d.specimen_id = c.specimen_id AND NOT d.is_expert AND d.animal_id = c.animal_id
                       AND d.sex IS NOT DISTINCT FROM c.sex AND d.caste IS NOT DISTINCT FROM c.caste) THEN 'beeline_own'
        ELSE 'recorded' END AS status
      FROM c`);

    const count = (status: string) => scalar(conn, `SELECT count(*) FROM temp.old_vol_status WHERE status = '${status}'`);
    const fieldNumbers = async (sql: string) => (await rowsOf(conn, sql)).map(([n]) => str(n));
    const cleared = await fieldNumbers(`
      SELECT coalesce(sp.field_number, concat('specimen ', sp.entity_id)) FROM temp.old_vol_held h
      JOIN specimen sp ON sp.entity_id = h.specimen_id
      WHERE NOT EXISTS (SELECT 1 FROM temp.old_vol_claim c WHERE c.specimen_id = h.specimen_id)
      ORDER BY 1`);
    const held = await scalar(conn, `SELECT count(*) FROM temp.old_vol_held`);
    const result: VolunteerImportResult = {
      read: records.length,
      recorded: await count("recorded"),
      unchanged: (await count("unchanged")) + (await count("duplicate")),
      beelineOwn: await count("beeline_own"),
      notInBeeline: await fieldNumbers(
        `SELECT coalesce(nullif(field_number, ''), concat('old record ', _id)) FROM temp.old_vol_status WHERE status = 'not_in_beeline' ORDER BY 1`,
      ),
      unresolved: (
        await rowsOf(
          conn,
          `SELECT coalesce(name, '(no name)'), count(*) FROM temp.old_vol_status WHERE status = 'unresolved_name' GROUP BY 1 ORDER BY 2 DESC, 1`,
        )
      ).map(([name, n]) => ({ name: str(name), records: Number(n) })),
      conflicting: await fieldNumbers(`
        SELECT DISTINCT coalesce(sp.field_number, concat('specimen ', sp.entity_id)) FROM temp.old_vol_status s
        JOIN specimen sp ON sp.entity_id = s.specimen_id WHERE s.status = 'conflicting' ORDER BY 1`),
      cleared,
      dryRun: opts.dryRun ?? false,
    };

    const limit = opts.clearedLimit ?? Math.max(10, Math.floor(held / 100));
    if (cleared.length > limit) {
      throw new Error(
        `${cleared.length} of the ${held} specimens Beeline holds an old-Beeline volunteer determination of have none there now ` +
          `(more than ${limit}): taken for the old system answering wrongly, so nothing was recorded. ${describeVolunteerImport(result)}`,
      );
    }
    if (!opts.dryRun) {
      await conn.run(`
        INSERT INTO determination (specimen_id, animal_id, verbatim_identification, sex, caste, determiner_id, is_expert, channel)
        SELECT specimen_id, animal_id, CASE WHEN written IS DISTINCT FROM name THEN written END, sex, caste,
               determiner_id, false, 'legacy_import'
        FROM temp.old_vol_status WHERE status = 'recorded'
        ORDER BY specimen_id`);
    }
    await conn.run(opts.dryRun ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (err) {
    await conn.run("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    for (const t of ["old_vol_record", "old_vol_target", "old_vol_claim", "old_vol_held", "old_vol_status"]) {
      await conn.run(`DROP TABLE IF EXISTS temp.${t}`).catch(() => {});
    }
  }
}

const some = (xs: string[], n = 10) => `${xs.slice(0, n).join(", ")}${xs.length > n ? ", …" : ""}`;

/** One line for job_run.detail and the CLI. */
export function describeVolunteerImport(r: VolunteerImportResult): string {
  const verb = r.dryRun ? "would be" : "were";
  const parts = [
    `${r.read} old record(s) name a volunteer determination`,
    `${r.recorded} ${verb} recorded as new`,
    `${r.unchanged} say what Beeline last heard from the old system`,
  ];
  if (r.beelineOwn > 0) parts.push(`${r.beelineOwn} are Beeline's own, copied there`);
  if (r.notInBeeline.length > 0) parts.push(`${r.notInBeeline.length} match no specimen here: ${some(r.notInBeeline)}`);
  if (r.unresolved.length > 0) {
    const n = r.unresolved.reduce((a, u) => a + u.records, 0);
    parts.push(`${n} name a taxon Beeline lacks: ${some(r.unresolved.map((u) => `${u.name} (${u.records})`))}`);
  }
  if (r.conflicting.length > 0) parts.push(`${r.conflicting.length} specimen(s) have old records that disagree: ${some(r.conflicting)}`);
  if (r.cleared.length > 0) parts.push(`${r.cleared.length} specimen(s) no longer have one there, which no determination can say: ${some(r.cleared)}`);
  return parts.join("; ");
}
