import { EMPTY_QUERY, listingHref, MINE } from "../listings.js";
import { sampleHref } from "../record.js";
import type { Geoprivacy, QcSeverity } from "../../model.js";
import type { Messages } from "../messages/index.js";
import { Callout, Chip, DataTable, EmptyState, LinkButton, Meta, PageHeader, TaxonName } from "./components/index.js";

/**
 * The front page: one table of this season's samples that want something —
 * a flag to fix, labels still to print, or a count still at zero — and a
 * link to the rest. Reimagined as a table with Peter and Nora on the sandbox
 * (2026-09-16): the cards said the same things at three times the length,
 * and a volunteer reading down a column can see at once *where* a sample
 * is wrong. So a flag names a column — place, coordinates, host plant,
 * specimens, or the sample itself — and that cell is marked, with the
 * flag's own words on a full-width line under the row.
 *
 * Findings are derived views: fixing the observation makes one vanish on
 * the next nightly read, so the page states the schedule instead of
 * tracking any "fixed" state. It never says "sync" — volunteers do not
 * know the word (beeline-yso will add a button for the impatient).
 */

/** Which column a rule is about, so the table can mark the cell. */
export type FlagColumn = "sample" | "place" | "coordinates" | "host" | "specimens";

/**
 * The rules a volunteer sees here, and the column each is about. A rule
 * absent from this map is not a volunteer's problem on this page — a count
 * that fell after labels printed just means labels to discard, a legacy
 * disagreement is staff residue, a recommended field is not worth a row —
 * and beeline-69t is the review of where each of those belongs instead.
 * Two rules block printing and name no single column: a required field
 * marks whichever column the missing field belongs to (columnsOf), and an
 * observation gone missing upstream is about the record as a whole.
 */
export const DASHBOARD_RULES: ReadonlyMap<string, FlagColumn | null> = new Map([
  ["duplicate_sample_number", "sample"],
  ["locality_format", "place"],
  ["place_unabbreviated", "place"],
  ["place_unrecognised", "place"],
  ["obscured_no_true_coordinates", "coordinates"],
  ["coordinate_uncertainty", "coordinates"],
  ["coordinate_out_of_region", "coordinates"],
  ["non_tracheophyte_host", "host"],
  ["missing_required_field", null],
  ["observation_missing_upstream", null],
]);

export interface Finding {
  rule_name: string;
  details: string | null;
  severity: QcSeverity;
}

/**
 * One row of the table. A sample, or — when `sample_id` is null — an
 * observation the volunteer numbered and left at zero specimens: a
 * placeholder, made before the catch was counted, that Beeline will not
 * turn into a sample until it says how many. It is on this page precisely
 * because the volunteer may have forgotten it (Peter, 2026-09-16).
 */
export interface DashboardRow {
  sample_id: number | null;
  inat_observation_id: bigint | null;
  sample_number: string;
  date_start: Date;
  locality: string | null;
  county: string | null;
  state_province: string | null;
  /** Believed-true coordinates only: an obscured pair is not a weaker reading, it is no reading. */
  latitude: number | null;
  longitude: number | null;
  coordinate_uncertainty_m: number | null;
  geoprivacy: Geoprivacy | null;
  taxon_geoprivacy: Geoprivacy | null;
  host_name: string | null;
  host_rank: string | null;
  specimen_count: number;
  /** Labels still to print; 0 when nothing is waiting or nothing can print. */
  pending_count: number;
  findings: Finding[];
}

/** sample_id → the other people who collected it, in recordedBy order. */
export type CoCollectors = ReadonlyMap<number, string[]>;

export function isPlaceholder(row: DashboardRow): boolean {
  return row.sample_id === null;
}

/**
 * The required-field rule names the fields it found empty (schema/120), and
 * most of them are a column here: the place fields mark the place, and
 * "location" — no believed-true coordinates on an unobscured sample — marks
 * the coordinates. Protocol has no column and marks nothing.
 */
const REQUIRED_FIELD_COLUMN: ReadonlyMap<string, FlagColumn> = new Map([
  ["country", "place"],
  ["state_province", "place"],
  ["locality", "place"],
  ["location", "coordinates"],
]);

function columnsOf(f: Finding): FlagColumn[] {
  if (f.rule_name === "missing_required_field") {
    const columns = new Set<FlagColumn>();
    for (const field of (f.details ?? "").split(", ")) {
      const column = REQUIRED_FIELD_COLUMN.get(field);
      if (column !== undefined) columns.add(column);
    }
    return [...columns];
  }
  const column = DASHBOARD_RULES.get(f.rule_name);
  return column === undefined || column === null ? [] : [column];
}

/** The columns a row's flags mark, with the strongest severity for each. */
export function flaggedColumns(row: DashboardRow): Map<FlagColumn, QcSeverity> {
  const out = new Map<FlagColumn, QcSeverity>();
  for (const f of row.findings) {
    for (const column of columnsOf(f)) {
      if (out.get(column) !== "blocking") out.set(column, f.severity);
    }
  }
  if (isPlaceholder(row)) out.set("specimens", "warning");
  return out;
}

/** Blocking first, then in the order the rules were reported. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1));
}

function cellClass(marks: Map<FlagColumn, QcSeverity>, column: FlagColumn): string | undefined {
  const severity = marks.get(column);
  return severity === undefined ? undefined : `flagged ${severity}`;
}

function Coordinates({ m, row }: { m: Messages; row: DashboardRow }) {
  if (row.latitude !== null && row.longitude !== null) {
    return (
      <>
        <span class="mono">{m.qc.coordinates(row.latitude.toFixed(4), row.longitude.toFixed(4))}</span>
        {row.coordinate_uncertainty_m !== null && <Meta block>{m.qc.accuracy(row.coordinate_uncertainty_m)}</Meta>}
      </>
    );
  }
  // No believed-true pair. Say why, where the observation says why.
  const hidden = row.geoprivacy !== null || row.taxon_geoprivacy !== null;
  return <Meta>{hidden ? m.qc.coordinatesObscured : m.qc.coordinatesNone}</Meta>;
}

function Row({ m, row, others }: { m: Messages; row: DashboardRow; others: string[] }) {
  const marks = flaggedColumns(row);
  const placeholder = isPlaceholder(row);
  const observationHref =
    row.inat_observation_id === null ? null : `https://www.inaturalist.org/observations/${row.inat_observation_id}`;
  const fixHref = observationHref ?? (row.sample_id === null ? null : `/samples/${row.sample_id}/edit`);
  const fixLabel = observationHref !== null ? m.qc.fixOnInat : m.qc.editSample;
  const findings = sortFindings(row.findings);
  return (
    <>
      <tr>
        <td class={cellClass(marks, "sample")}>
          {/* A sample links to its record; a placeholder has none yet and
              links to the observation it will be made from. */}
          {row.sample_id !== null ? (
            <a href={sampleHref(row.sample_id)}>{m.qc.sampleTitle(row.sample_number, row.date_start)}</a>
          ) : (
            <a href={observationHref ?? "#"}>{m.qc.sampleTitle(row.sample_number, row.date_start)}</a>
          )}
          {others.length > 0 && <Meta block>{m.qc.collectedWith(m.format.list(others))}</Meta>}
        </td>
        <td class={cellClass(marks, "place")}>{m.format.place([row.locality, row.county, row.state_province])}</td>
        <td class={cellClass(marks, "coordinates")}>
          <Coordinates m={m} row={row} />
        </td>
        <td class={cellClass(marks, "host")}>
          {row.host_name === null ? (
            <Meta>{m.qc.hostNone}</Meta>
          ) : (
            <TaxonName rank={row.host_rank ?? ""} scientificName={row.host_name} />
          )}
        </td>
        <td class={cellClass(marks, "specimens")}>
          {m.format.number(row.specimen_count)}
          {row.pending_count > 0 && <Meta block>{m.qc.labelsWaiting(row.pending_count)}</Meta>}
        </td>
      </tr>
      {placeholder && (
        <tr class="flag">
          <td colspan={5}>
            <div class="flag-body">
              <Chip tone="warning">{m.qc.placeholder.chip}</Chip> {m.qc.placeholder.note}
              {observationHref !== null && (
                <>
                  {" "}
                  <a href={observationHref}>{m.qc.fixOnInat}</a>
                </>
              )}
            </div>
          </td>
        </tr>
      )}
      {findings.map((f) => (
        <tr class="flag">
          <td colspan={5}>
            <div class="flag-body">
              <Chip tone={f.severity === "blocking" ? "blocking" : "warning"}>
                {f.severity === "blocking" ? m.qc.blocksPrinting : m.qc.headsUp}
              </Chip>{" "}
              {m.qcInstructions[f.rule_name] ?? f.rule_name}
              {f.details && (
                <>
                  {" "}
                  <code>{f.details}</code>
                </>
              )}
              {fixHref !== null && (
                <>
                  {" "}
                  <a href={fixHref}>{fixLabel}</a>
                </>
              )}
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

export function QcHome(props: {
  m: Messages;
  rows: DashboardRow[];
  /** Absent on proofing surfaces that render no shared samples. */
  withOthers?: CoCollectors;
  /** Whether this store has ever read from iNaturalist — a fresh instance says so instead of promising a schedule it has never kept. */
  everSynced: boolean;
  /**
   * How many of this person's samples from closed seasons still carry flags.
   * They are deliberately not in `rows` — settling is what keeps the list
   * about this season — so the page says the number out loud instead of
   * letting them vanish (beeline-2c3.24).
   */
  settledFlagged?: number;
}) {
  const { m, rows } = props;
  const withOthers: CoCollectors = props.withOthers ?? new Map();
  const flagged = rows.filter((r) => r.findings.length > 0).length;
  const blocking = rows.filter((r) => r.findings.some((f) => f.severity === "blocking")).length;
  const waiting = rows.filter((r) => r.pending_count > 0).length;
  const placeholders = rows.filter(isPlaceholder).length;
  const settledFlagged = props.settledFlagged ?? 0;
  const mineHref = listingHref("/samples", EMPTY_QUERY, { scope: MINE });

  return (
    <>
      <PageHeader title={m.qc.heading} lede={m.qc.lede} />
      <Callout>
        <Meta block>{props.everSynced ? m.qc.refreshNote : m.qc.neverSynced}</Meta>
      </Callout>
      {settledFlagged > 0 && (
        <Callout>
          <Meta block>
            {m.qc.settled.note(settledFlagged)}{" "}
            {/* Exactly what settling took off this page: earlier seasons, this
                person's own, flagged. Built through listingHref so the URL cannot
                drift from what the listing parses — and with the scope named, so
                a staff member's remembered scope does not answer instead. */}
            <a href={listingHref("/samples", EMPTY_QUERY, { scope: MINE, qc: "flagged", season: "settled" })}>
              {m.qc.settled.link}
            </a>
          </Meta>
        </Callout>
      )}
      {rows.length === 0 ? (
        <EmptyState>{m.qc.allClear}</EmptyState>
      ) : (
        <>
          <Meta block>{m.qc.summary(flagged, blocking, waiting, placeholders)}</Meta>
          <DataTable columns={[m.qc.col.sample, m.qc.col.place, m.qc.col.coordinates, m.qc.col.host, m.qc.col.specimens]}>
            {rows.map((row) => (
              <Row m={m} row={row} others={row.sample_id === null ? [] : (withOthers.get(row.sample_id) ?? [])} />
            ))}
          </DataTable>
        </>
      )}
      <p>
        <LinkButton href={mineHref}>{m.qc.allMine}</LinkButton>
      </p>
    </>
  );
}
