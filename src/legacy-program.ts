/**
 * Which program an old-Beeline record belongs to, for the two staff pages that
 * describe those records (/exports/held-back and /exports/changes,
 * beeline-z0pi). The pages describe those records as they stood at
 * cutover, when no season was in progress, so they count by program and not by
 * season: "these features pertain only to cutover. The current season is not
 * 'in progress', so it is not special" (Peter, 2026-11-20).
 *
 * A record new Beeline carried over belongs to the atlas its sample files
 * under (`sample_atlas`); a second record the repair tied to a specimen, to
 * that specimen's sample. A record new Beeline does not hold belongs to the
 * atlas of the sample its iNaturalist observation is in Beeline, where there
 * is one, and otherwise to the atlas `atlas_region` assigns to the state or
 * province it wrote. A sample or a state with no atlas is At large, the word
 * the listings use (`scope.outside`, a test pins the two together). A record
 * that writes no state and has no sample is a different case and has its own
 * group, which the pages show only where it has records.
 *
 * The records this reads are the ones new Beeline does not hold, which have
 * no specimen to ask; a pair both sides hold takes its specimen's program
 * (src/compare-legacy-export.ts), and this is its fallback only where no
 * specimen carries the field number.
 *
 * A program is named by its abbreviation (`program_abbreviation`: WABA, where
 * the code is WaBA), and programs are ordered as the program table is, then
 * At large, then the group with no state.
 */

export const AT_LARGE = "At large";
export const NO_STATE_WRITTEN = "No state written";

/** Programs in the order the program table holds them, by the name people read: the SELECT that gives them. */
export const PROGRAM_ORDER_SQL = `
  SELECT coalesce(ab.abbreviation, p.code) AS label FROM program p
  LEFT JOIN program_abbreviation ab ON ab.program_id = p.entity_id
  ORDER BY p.entity_id`;

/** The programs present among `labels`, in the order the pages show them. `known` is what PROGRAM_ORDER_SQL gave. */
export function orderPrograms(labels: Iterable<string>, known: readonly string[]): string[] {
  const order = [...known, AT_LARGE, NO_STATE_WRITTEN];
  const rank = (l: string) => {
    const i = order.indexOf(l);
    return i === -1 ? order.length : i;
  };
  return [...new Set(labels)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * SQL for a region's program label: where `state` (an expression) is written
 * and `atlas_region` assigns it an atlas, that atlas, else At large; where it
 * is blank, the group with no state.
 */
export const regionProgramSql = (state: string) => `CASE
    WHEN nullif(trim(${state}), '') IS NULL THEN ${sqlString(NO_STATE_WRITTEN)}
    ELSE coalesce((SELECT coalesce(ab.abbreviation, pr.code) FROM atlas_region rg
                   JOIN program pr ON pr.entity_id = rg.atlas_id
                   LEFT JOIN program_abbreviation ab ON ab.program_id = pr.entity_id
                   WHERE rg.state_province = upper(trim(${state}))), ${sqlString(AT_LARGE)})
  END`;

/**
 * Common table expressions, to follow `WITH` (and a comma where more follow):
 * `program_label`, `sample_program` (each sample's program, At large where it
 * files under none) and `legacy_program` (the program of every staged record,
 * by `_id`).
 */
export const PROGRAM_CTES = `
  program_label AS (
    SELECT p.entity_id AS program_id, coalesce(ab.abbreviation, p.code) AS label
    FROM program p LEFT JOIN program_abbreviation ab ON ab.program_id = p.entity_id),
  sample_program AS (
    SELECT s.entity_id AS sample_id, coalesce(pl.label, ${sqlString(AT_LARGE)}) AS program
    FROM sample s
    LEFT JOIN sample_atlas sa ON sa.sample_id = s.entity_id
    LEFT JOIN program_label pl ON pl.program_id = sa.atlas_id),
  legacy_tied AS (
    SELECT r._id, sp.program
    FROM legacy_duplicate_record r
    JOIN specimen s ON s.entity_id = r.specimen_id
    JOIN sample_program sp ON sp.sample_id = s.sample_id),
  legacy_observed AS (
    SELECT s.inat_observation_id, arg_min(sp.program, s.entity_id) AS program
    FROM sample s JOIN sample_program sp ON sp.sample_id = s.entity_id
    WHERE s.inat_observation_id IS NOT NULL
    GROUP BY s.inat_observation_id),
  legacy_program AS (
    SELECT o._id,
           coalesce(t.program, ob.program, ${regionProgramSql('o."stateProvince"')}) AS program
    FROM legacy_occurrence o
    LEFT JOIN legacy_tied t ON t._id = o._id
    LEFT JOIN legacy_observed ob
      ON ob.inat_observation_id = try_cast(regexp_extract(o.url, '/observations/([0-9]+)$', 1) AS BIGINT))`;

/** The program of each specimen, by field number, as a SELECT: the sample it is in, At large where that files under no atlas. */
export const SPECIMEN_PROGRAM_SELECT = `
  SELECT sp.field_number, min(spr.program) AS program
  FROM specimen sp JOIN sample_program spr ON spr.sample_id = sp.sample_id
  WHERE sp.field_number IS NOT NULL
  GROUP BY sp.field_number`;

/** Counts by program, in the pages' order, as `WABA 12, OBA 3`. */
export function describePrograms(counts: Readonly<Record<string, number>>, programs: readonly string[]): string {
  return programs
    .filter((p) => (counts[p] ?? 0) > 0)
    .map((p) => `${p} ${counts[p]!.toLocaleString("en-US")}`)
    .join(", ");
}
