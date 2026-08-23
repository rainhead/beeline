import type { Messages } from "../../messages/index.js";
import { QcHome, type FindingRow, type PendingRow } from "../qc.js";
import { DesignPage, Specimen } from "./shell.js";

/**
 * QC-state proofing: QcHome rendered from fixture data, one panel per state
 * — the component is a pure function of (messages, findings, syncedAt), so
 * every state is reachable without data gymnastics. This is also the
 * regression check for any change to the component library: the real page at
 * / runs through exactly this code path.
 */

const row = (over: Partial<FindingRow>): FindingRow => ({
  sample_id: 1,
  rule_name: "missing_required_field",
  details: "locality",
  severity: "blocking",
  sample_number: "3",
  date_start: new Date("2026-07-14T12:00:00"),
  locality: "Corvallis",
  county: "BentonCo",
  state_province: "OR",
  specimen_count: 3,
  inat_observation_id: 123456789n,
  ...over,
});

const SYNCED = new Date("2026-08-21T02:50:00");

const pendingRow = (over: Partial<PendingRow>): PendingRow => ({
  sample_id: 1,
  sample_number: "3",
  date_start: new Date("2026-07-14T12:00:00"),
  locality: "Corvallis",
  county: "BentonCo",
  state_province: "OR",
  pending_count: 3,
  ...over,
});

const WAITING: PendingRow[] = [
  pendingRow({}),
  pendingRow({ sample_id: 7, sample_number: "4", pending_count: 1 }),
  pendingRow({
    sample_id: 8,
    sample_number: "OBAS-00657",
    date_start: new Date("2026-06-02T12:00:00"),
    locality: "Finley NWR",
    pending_count: 2140,
  }),
];

const FIXTURES: Array<{ label: string; findings: FindingRow[]; pending: PendingRow[]; syncedAt: Date | null }> = [
  { label: "All clear, nothing waiting", findings: [], pending: [], syncedAt: SYNCED },
  { label: "All clear, samples waiting on labels", findings: [], pending: WAITING, syncedAt: SYNCED },
  { label: "All clear, never synced", findings: [], pending: [], syncedAt: null },
  {
    label: "One sample: blocking + warning, iNat-backed",
    findings: [
      row({ details: "locality, protocol" }),
      row({ rule_name: "missing_recommended_field", details: "county", severity: "warning", county: null }),
    ],
    pending: [],
    syncedAt: SYNCED,
  },
  {
    label: "Trap sample: no observation to fix",
    findings: [
      row({
        sample_id: 2,
        rule_name: "within_sample_disagreement",
        details: "protocol: vane trap | 6 Vane Traps",
        severity: "warning",
        sample_number: "OBAS-00657",
        inat_observation_id: null,
        specimen_count: 2140,
      }),
    ],
    pending: [],
    syncedAt: SYNCED,
  },
  {
    label: "A busy season: several samples, mixed severities",
    findings: [
      row({ sample_id: 3, sample_number: "7", details: "locality" }),
      row({
        sample_id: 3,
        sample_number: "7",
        rule_name: "coordinate_uncertainty",
        details: "3200 m > 250 m",
      }),
      row({
        sample_id: 4,
        sample_number: "8",
        rule_name: "locality_format",
        details: "longer than 18 chars; contains comma",
        locality: "5th St, Corvallis Oregon near the old mill by the river",
      }),
      row({
        sample_id: 5,
        sample_number: "9",
        date_start: new Date("2026-06-02T12:00:00"),
        rule_name: "non_tracheophyte_host",
        details: "Umbrella Liverworts (genus Marchantia)",
      }),
      row({
        sample_id: 6,
        sample_number: "10",
        date_start: new Date("2026-06-02T12:00:00"),
        rule_name: "count_mismatch",
        details: "observation says 4, sample says 6",
        severity: "warning",
      }),
    ],
    // Sample 10's finding is a warning, which doesn't block printing — so it
    // is honestly in both lists at once.
    pending: [pendingRow({ sample_id: 6, sample_number: "10", date_start: new Date("2026-06-02T12:00:00") })],
    syncedAt: SYNCED,
  },
];

export function QcProof({ m }: { m: Messages }) {
  return (
    <DesignPage
      current="/design/qc"
      title="QC states"
      lede="The dashboard rendered from fixture data, one panel per state it can be in — findings above, samples waiting on labels below. Proof layout and copy here; the real page at / shows only your own samples."
    >
      {FIXTURES.map((state) => (
        <>
          <h2>{state.label}</h2>
          <Specimen>
            <QcHome m={m} findings={state.findings} pending={state.pending} syncedAt={state.syncedAt} />
          </Specimen>
        </>
      ))}
    </DesignPage>
  );
}
