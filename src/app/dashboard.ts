import { sql, type Kysely } from "kysely";
import type { Database, Geoprivacy, QcSeverity } from "../model.js";
import { DASHBOARD_RULES, type CoCollectors, type DashboardRow, type Finding } from "./views/qc.js";

/**
 * What the front page reads: the person's samples that want something this
 * season, and the observations they numbered but left at zero. The queries
 * are here rather than in the route so the page's membership rule can be
 * tested as a function of the store, the way the listings' are.
 *
 * "Mine" is any sample the person collected, not only the ones numbered
 * under their name: a second collector is not a spectator (beeline-77j).
 * The caller passes the *effective* person — while acting for somebody,
 * theirs (beeline-oyl).
 */
export interface Dashboard {
  rows: DashboardRow[];
  withOthers: CoCollectors;
  /** This person's flagged samples from settled seasons, kept off the table and counted (beeline-2c3.24). */
  settledFlagged: number;
  /**
   * The last day of the settled seasons, ISO — what the listing's "collected
   * to" filter is set to for the link to them, since the listing has no
   * season control of its own (Peter, 2026-09-16).
   */
  settledThrough: string;
  everSynced: boolean;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

interface RawSampleRow {
  sample_id: number;
  inat_observation_id: bigint | null;
  sample_number: string;
  date_start: Date;
  locality: string | null;
  county: string | null;
  state_province: string | null;
  latitude: unknown;
  longitude: unknown;
  coordinate_uncertainty_m: unknown;
  geoprivacy: Geoprivacy | null;
  taxon_geoprivacy: Geoprivacy | null;
  host_name: string | null;
  host_rank: string | null;
  specimen_count: unknown;
  pending_count: unknown;
  printing_count: unknown;
  printed_count: unknown;
  printed_at: Date | null;
  flagged: boolean;
  settled: boolean;
}

type RawPlaceholderRow = Omit<
  RawSampleRow,
  "sample_id" | "specimen_count" | "pending_count" | "printing_count" | "printed_count" | "printed_at" | "flagged" | "settled"
>;

export async function loadDashboard(db: Kysely<Database>, personId: number): Promise<Dashboard> {
  const rules = [...DASHBOARD_RULES.keys()];
  const ruleList = sql.join(rules.map((r) => sql`${r}`));
  const [samples, findings, placeholders, partners, sync, season] = await Promise.all([
    // A sample is on the page when a rule the page shows fires on it, or
    // when labels are waiting for it. The roll-up (sample_qc_finding), not
    // qc_finding: a finding on one of a sample's specimens is something to
    // fix about that sample (beeline-2c3.29). Settled seasons stay in this
    // one read and are split out below: asking twice would compute the
    // flag set twice, and that view is what the page costs (beeline-2c3.24).
    sql<RawSampleRow>`
      SELECT s.entity_id AS sample_id, s.inat_observation_id, s.sample_number, s.date_start,
             s.locality, s.county, s.state_province,
             loc.latitude, loc.longitude, loc.coordinate_uncertainty_m,
             s.geoprivacy, s.taxon_geoprivacy,
             s.host_name_as_observed AS host_name, s.host_rank,
             s.specimen_count, coalesce(p.pending_count, 0) AS pending_count,
             coalesce(lp.printing_count, 0) AS printing_count,
             coalesce(lp.printed_count, 0) AS printed_count, lp.printed_at,
             EXISTS (SELECT 1 FROM sample_qc_finding f
                     WHERE f.sample_id = s.entity_id AND f.rule_name IN (${ruleList})) AS flagged,
             EXISTS (SELECT 1 FROM settled_sample st WHERE st.sample_id = s.entity_id) AS settled
      FROM sample s
      LEFT JOIN sample_location loc ON loc.sample_id = s.entity_id
      LEFT JOIN pending_print_sample p ON p.sample_id = s.entity_id
      LEFT JOIN sample_label_in_progress lp ON lp.sample_id = s.entity_id
      WHERE EXISTS (SELECT 1 FROM sample_collector mine
                    WHERE mine.sample_id = s.entity_id AND mine.person_id = ${personId})
        AND (p.sample_id IS NOT NULL
             -- Frozen into a run is not the end of waiting: the labels are
             -- still on their way until the run is mailed (schema/155).
             OR lp.sample_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM sample_qc_finding f
                        WHERE f.sample_id = s.entity_id AND f.rule_name IN (${ruleList})))
      ORDER BY s.date_start DESC, length(s.sample_number) DESC, s.sample_number DESC, s.entity_id`.execute(db),
    sql<Finding & { sample_id: number }>`
      SELECT f.sample_id, f.rule_name, f.details, r.severity
      FROM sample_qc_finding f
      JOIN qc_rule r ON r.name = f.rule_name
      WHERE f.rule_name IN (${ruleList})
        AND EXISTS (SELECT 1 FROM sample_collector mine
                    WHERE mine.sample_id = f.sample_id AND mine.person_id = ${personId})
        AND NOT EXISTS (SELECT 1 FROM settled_sample st WHERE st.sample_id = f.sample_id)
      ORDER BY f.sample_id, f.rule_name`.execute(db),
    // The placeholders: numbered, dated, this season, still at 0, and not a
    // sample — minting refuses them (observation_sample_candidate) precisely
    // because 0 is the project's own signal that the catch is not counted
    // yet. Coordinates by the rule promotion applies: the private pair when
    // trust delivers one, the public pair when nothing obscures it, and
    // otherwise none — a shifted pair is not a reading.
    sql<RawPlaceholderRow>`
      SELECT f.inat_id AS inat_observation_id,
             trim(f.sample_number_raw) AS sample_number,
             f.observed_on AS date_start,
             ol.locality, op.county_name AS county, op.state_province,
             CASE WHEN f.private_latitude IS NOT NULL AND f.private_longitude IS NOT NULL THEN f.private_latitude
                  WHEN nullif(f.geoprivacy, 'open') IS NULL AND nullif(f.taxon_geoprivacy, 'open') IS NULL THEN f.latitude
             END AS latitude,
             CASE WHEN f.private_latitude IS NOT NULL AND f.private_longitude IS NOT NULL THEN f.private_longitude
                  WHEN nullif(f.geoprivacy, 'open') IS NULL AND nullif(f.taxon_geoprivacy, 'open') IS NULL THEN f.longitude
             END AS longitude,
             f.positional_accuracy AS coordinate_uncertainty_m,
             nullif(f.geoprivacy, 'open') AS geoprivacy,
             nullif(f.taxon_geoprivacy, 'open') AS taxon_geoprivacy,
             f.host_taxon_name AS host_name, f.host_taxon_rank AS host_rank
      FROM observation_field f
      JOIN inat_account a ON a.inat_user_id = f.user_id AND a.person_id = ${personId}
      CROSS JOIN season
      LEFT JOIN observation_locality ol ON ol.inat_id = f.inat_id
      LEFT JOIN observation_place op ON op.inat_id = f.inat_id
      WHERE try_cast(f.specimen_count_raw AS INTEGER) = 0
        AND nullif(trim(f.sample_number_raw), '') IS NOT NULL
        AND f.observed_on >= season.started_on
        AND NOT EXISTS (SELECT 1 FROM sample s WHERE s.inat_observation_id = f.inat_id)
      ORDER BY f.observed_on DESC, length(trim(f.sample_number_raw)) DESC, trim(f.sample_number_raw) DESC`.execute(db),
    // Who else collected those samples, so a row can say whose numbering
    // it is you are looking at.
    db
      .selectFrom("sample_collector as mine")
      .innerJoin("sample_collector as theirs", "theirs.sample_id", "mine.sample_id")
      .innerJoin("person", "person.entity_id", "theirs.person_id")
      .where("mine.person_id", "=", personId)
      .where("theirs.person_id", "!=", personId)
      .select(["mine.sample_id as sample_id", "person.display_name as display_name"])
      .orderBy("theirs.position")
      .execute(),
    db
      .selectFrom("sync_run")
      .select(({ fn }) => fn.max("completed_at").as("at"))
      .executeTakeFirst(),
    // Date minus an integer is a date in both engines (ADR 0001).
    sql<{ through: string }>`SELECT CAST(started_on - 1 AS TEXT) AS through FROM season`.execute(db),
  ]);

  const findingsBySample = new Map<number, Finding[]>();
  for (const f of findings.rows) {
    const list = findingsBySample.get(Number(f.sample_id)) ?? [];
    list.push({ rule_name: f.rule_name, details: f.details, severity: f.severity as QcSeverity });
    findingsBySample.set(Number(f.sample_id), list);
  }

  const rows: DashboardRow[] = [];
  let settledFlagged = 0;
  for (const s of samples.rows) {
    const sampleId = Number(s.sample_id);
    const pending = Number(s.pending_count);
    const printing = Number(s.printing_count);
    const printed = Number(s.printed_count);
    // A settled sample asks nothing: its flags are counted, and it stays on
    // the page only if labels are waiting for it — that is not a question
    // to the volunteer, and a season's end does not cancel a print job.
    if (s.settled && s.flagged) settledFlagged += 1;
    if (s.settled && pending === 0 && printing === 0 && printed === 0) continue;
    rows.push({
      sample_id: sampleId,
      inat_observation_id: s.inat_observation_id,
      sample_number: s.sample_number,
      date_start: s.date_start,
      locality: s.locality,
      county: s.county,
      state_province: s.state_province,
      latitude: num(s.latitude),
      longitude: num(s.longitude),
      coordinate_uncertainty_m: num(s.coordinate_uncertainty_m),
      geoprivacy: s.geoprivacy,
      taxon_geoprivacy: s.taxon_geoprivacy,
      host_name: s.host_name,
      host_rank: s.host_rank,
      specimen_count: Number(s.specimen_count),
      pending_count: pending,
      printing_count: printing,
      printed_count: printed,
      printed_at: s.printed_at === null ? null : new Date(s.printed_at),
      findings: s.settled ? [] : (findingsBySample.get(sampleId) ?? []),
    });
  }
  for (const p of placeholders.rows) {
    rows.push({
      sample_id: null,
      inat_observation_id: p.inat_observation_id,
      sample_number: p.sample_number,
      date_start: p.date_start,
      locality: p.locality,
      county: p.county,
      state_province: p.state_province,
      latitude: num(p.latitude),
      longitude: num(p.longitude),
      coordinate_uncertainty_m: num(p.coordinate_uncertainty_m),
      geoprivacy: p.geoprivacy,
      taxon_geoprivacy: p.taxon_geoprivacy,
      host_name: p.host_name,
      host_rank: p.host_rank,
      specimen_count: 0,
      pending_count: 0,
      printing_count: 0,
      printed_count: 0,
      printed_at: null,
      findings: [],
    });
  }
  // One order for both kinds: newest first, then by number as the listings sort it.
  rows.sort(
    (a, b) =>
      b.date_start.getTime() - a.date_start.getTime() ||
      b.sample_number.length - a.sample_number.length ||
      (b.sample_number < a.sample_number ? -1 : b.sample_number > a.sample_number ? 1 : 0),
  );

  const withOthers = new Map<number, string[]>();
  for (const row of partners as Array<{ sample_id: number; display_name: string }>) {
    const names = withOthers.get(Number(row.sample_id)) ?? [];
    names.push(row.display_name);
    withOthers.set(Number(row.sample_id), names);
  }

  return {
    rows,
    withOthers,
    settledFlagged,
    settledThrough: season.rows[0]?.through ?? "",
    everSynced: (sync?.at ?? null) !== null,
  };
}
