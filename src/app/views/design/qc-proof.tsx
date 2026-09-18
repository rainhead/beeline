import type { Messages } from "../../messages/index.js";
import { QcHome, type CoCollectors, type DashboardRow, type Finding } from "../qc.js";
import { DesignPage, Specimen } from "./shell.js";

/**
 * QC-state proofing: QcHome rendered from fixture data, one panel per state
 * — the component is a pure function of (messages, rows, everSynced), so
 * every state is reachable without data gymnastics. This is also the
 * regression check for any change to the component library: the real page at
 * / runs through exactly this code path.
 */

/**
 * A fixture finding. Prose by default; the one rule whose detail is a taxon
 * passes `taxon` instead, and the difference is what the "a name, not a
 * machine value" panel below proofs (beeline-dys).
 */
const finding = (
  rule_name: string,
  details: string | null,
  severity: "blocking" | "warning",
  taxon?: { name: string; rank: string },
): Finding => ({
  rule_name,
  details,
  detail_taxon_name: taxon?.name ?? null,
  detail_taxon_rank: taxon?.rank ?? null,
  severity,
});

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
        findings: [finding("missing_required_field", "locality", "blocking")],
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
        findings: [finding("coordinate_uncertainty", "3200 m > 250 m", "blocking")],
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
          finding("duplicate_sample_number", "also sample 7 on 14 Jul 2026", "blocking"),
          finding("coordinate_uncertainty", "3200 m > 250 m", "blocking"),
        ],
        coordinate_uncertainty_m: 3200,
      }),
      row({
        sample_id: 4,
        sample_number: "8",
        locality: "5th St, Corvallis Oregon near the old mill by the river",
        findings: [
          finding("locality_format", "contains comma; street address", "blocking"),
        ],
      }),
      row({
        sample_id: 5,
        sample_number: "9",
        date_start: new Date("2026-06-02T12:00:00"),
        host_name: "Marchantia",
        findings: [
          finding("non_tracheophyte_host", null, "blocking", { name: "Marchantia", rank: "genus" }),
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
        findings: [finding("obscured_no_true_coordinates", null, "blocking")],
      }),
      row({
        sample_id: 9,
        sample_number: "11",
        date_start: new Date("2026-06-02T12:00:00"),
        state_province: "Oregon",
        pending_count: 3,
        findings: [finding("place_unrecognised", "Oregon", "warning")],
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
  {
    // A scientific name is set by rank, not by eye: Homo sapiens and Andrena
    // take italics, Insecta and Life do not, and `stateofmatter` is a rank
    // the store has never heard of and so renders upright — which is right.
    // All four came out of the same <code> before beeline-dys.
    label: "A host that is not a plant: the detail is a name, not a machine value",
    rows: [
      row({
        sample_id: 20,
        sample_number: "20",
        host_name: "Homo sapiens",
        host_rank: "species",
        findings: [finding("non_tracheophyte_host", null, "blocking", { name: "Homo sapiens", rank: "species" })],
      }),
      row({
        sample_id: 21,
        sample_number: "21",
        host_name: "Andrena",
        host_rank: "genus",
        findings: [finding("non_tracheophyte_host", null, "blocking", { name: "Andrena", rank: "genus" })],
      }),
      row({
        sample_id: 22,
        sample_number: "22",
        host_name: "Insecta",
        host_rank: "class",
        findings: [finding("non_tracheophyte_host", null, "blocking", { name: "Insecta", rank: "class" })],
      }),
      row({
        sample_id: 23,
        sample_number: "23",
        host_name: "Life",
        host_rank: "stateofmatter",
        findings: [finding("non_tracheophyte_host", null, "blocking", { name: "Life", rank: "stateofmatter" })],
      }),
      // iNaturalist gave an id and no name: the rule falls back to prose,
      // which is still a machine value and still belongs in a <code>.
      row({
        sample_id: 24,
        sample_number: "24",
        host_name: null,
        host_rank: null,
        findings: [finding("non_tracheophyte_host", "observation taxon 47126 is not a vascular plant", "blocking")],
      }),
    ],
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
