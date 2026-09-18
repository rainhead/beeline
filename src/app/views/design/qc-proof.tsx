import type { Messages } from "../../messages/index.js";
import { QcHome, type CoCollectors, type DashboardRow } from "../qc.js";
import { DesignPage, Specimen } from "./shell.js";

/**
 * QC-state proofing: QcHome rendered from fixture data, one panel per state
 * — the component is a pure function of (messages, rows, everSynced), so
 * every state is reachable without data gymnastics. This is also the
 * regression check for any change to the component library: the real page at
 * / runs through exactly this code path.
 */

const row = (over: Partial<DashboardRow>): DashboardRow => ({
  sample_id: 1,
  inat_observation_id: 123456789n,
  sample_number: "3",
  date_start: new Date("2026-07-14T12:00:00"),
  locality: "Corvallis",
  county: "BentonCo",
  state_province: "OR",
  latitude: 44.5646,
  longitude: -123.262,
  coordinate_uncertainty_m: 8,
  geoprivacy: null,
  taxon_geoprivacy: null,
  host_name: "Phacelia",
  host_rank: "genus",
  specimen_count: 3,
  pending_count: 0,
  printing_count: 0,
  printed_count: 0,
  printed_at: null,
  findings: [],
  ...over,
});

const WAITING: DashboardRow[] = [
  row({ pending_count: 3 }),
  // Frozen into a run, and then on paper: still waiting on labels until mailed.
  row({ sample_id: 5, sample_number: "5", printing_count: 3 }),
  row({ sample_id: 6, sample_number: "6", printed_count: 3, printed_at: new Date("2026-07-20T18:00:00Z") }),
  row({ sample_id: 7, sample_number: "4", pending_count: 1, host_name: null, host_rank: null }),
  row({
    sample_id: 8,
    sample_number: "OBAS-00657",
    date_start: new Date("2026-06-02T12:00:00"),
    locality: "Finley NWR",
    inat_observation_id: null,
    specimen_count: 2140,
    pending_count: 2140,
  }),
];

/** Someone else's numbering, your sample too (beeline-77j). */
const SHARED: CoCollectors = new Map([
  [6, ["Dan O’Loughlin"]],
  [7, ["Maggie Graham", "Henry Whitridge"]],
]);

const FIXTURES: Array<{
  label: string;
  rows: DashboardRow[];
  withOthers?: CoCollectors;
  everSynced: boolean;
}> = [
  { label: "All clear, nothing waiting", rows: [], everSynced: true },
  { label: "All clear, samples waiting on labels", rows: WAITING, everSynced: true },
  {
    label: "A shared trap line: samples numbered under the other collector",
    rows: [row({ sample_id: 7, sample_number: "OBAS-00658", inat_observation_id: null, specimen_count: 96, pending_count: 96 })],
    withOthers: SHARED,
    everSynced: true,
  },
  { label: "All clear, never synced", rows: [], everSynced: false },
  {
    label: "One sample: a required field missing, iNat-backed",
    rows: [
      row({
        locality: null,
        findings: [{ rule_name: "missing_required_field", details: "locality", severity: "blocking" }],
      }),
    ],
    everSynced: true,
  },
  {
    label: "Trap sample: no observation to fix",
    rows: [
      row({
        sample_id: 2,
        sample_number: "OBAS-00657",
        inat_observation_id: null,
        specimen_count: 2140,
        coordinate_uncertainty_m: 3200,
        findings: [{ rule_name: "coordinate_uncertainty", details: "3200 m > 250 m", severity: "blocking" }],
      }),
    ],
    everSynced: true,
  },
  {
    label: "A placeholder: numbered, still at 0 specimens",
    rows: [
      row({
        sample_id: null,
        sample_number: "12",
        date_start: new Date("2026-08-30T12:00:00"),
        specimen_count: 0,
        host_name: null,
        host_rank: null,
      }),
    ],
    everSynced: true,
  },
  {
    label: "A busy season: every column flagged somewhere",
    rows: [
      row({
        sample_id: 3,
        sample_number: "7",
        findings: [
          { rule_name: "duplicate_sample_number", details: "also sample 7 on 14 Jul 2026", severity: "blocking" },
          { rule_name: "coordinate_uncertainty", details: "3200 m > 250 m", severity: "blocking" },
        ],
        coordinate_uncertainty_m: 3200,
      }),
      row({
        sample_id: 4,
        sample_number: "8",
        locality: "5th St, Corvallis Oregon near the old mill by the river",
        findings: [
          { rule_name: "locality_format", details: "contains comma; street address", severity: "blocking" },
        ],
      }),
      row({
        sample_id: 5,
        sample_number: "9",
        date_start: new Date("2026-06-02T12:00:00"),
        host_name: "Marchantia",
        findings: [
          { rule_name: "non_tracheophyte_host", details: "Umbrella Liverworts (genus Marchantia)", severity: "blocking" },
        ],
      }),
      row({
        sample_id: 6,
        sample_number: "10",
        date_start: new Date("2026-06-02T12:00:00"),
        latitude: null,
        longitude: null,
        coordinate_uncertainty_m: null,
        geoprivacy: "obscured",
        findings: [{ rule_name: "obscured_no_true_coordinates", details: null, severity: "blocking" }],
      }),
      row({
        sample_id: 9,
        sample_number: "11",
        date_start: new Date("2026-06-02T12:00:00"),
        state_province: "Oregon",
        pending_count: 3,
        findings: [{ rule_name: "place_unrecognised", details: "Oregon", severity: "warning" }],
      }),
      row({
        sample_id: null,
        sample_number: "13",
        date_start: new Date("2026-06-01T12:00:00"),
        specimen_count: 0,
        host_name: null,
        host_rank: null,
      }),
    ],
    withOthers: SHARED,
    everSynced: true,
  },
];

export function QcProof({ m }: { m: Messages }) {
  return (
    <DesignPage
      current="/design/qc"
      title="QC states"
      lede="The dashboard rendered from fixture data, one panel per state it can be in. A flag marks the column it is about and states itself on the line under the row. Proof layout and copy here; the real page at / shows only your own samples."
    >
      {FIXTURES.map((state) => (
        <>
          <h2>{state.label}</h2>
          <Specimen>
            <QcHome m={m} rows={state.rows} withOthers={state.withOthers} everSynced={state.everSynced} />
          </Specimen>
        </>
      ))}
    </DesignPage>
  );
}
