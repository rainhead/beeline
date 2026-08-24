import type { QcSeverity } from "../../model.js";
import type { Messages } from "../messages/index.js";
import { Callout, Card, Chip, DataTable, EmptyState, LinkButton, Meta, PageHeader } from "./components/index.js";

/**
 * The flagship: a volunteer's samples that need attention, sample-keyed —
 * one card per sample, its findings inside, one fix-it link out to the
 * observation. Findings are derived views: fixing the observation makes a
 * finding vanish on the next sync, so the page states the sync times
 * instead of tracking any "fixed" state.
 */

export interface FindingRow {
  sample_id: number;
  rule_name: string;
  details: string | null;
  severity: QcSeverity;
  sample_number: string;
  date_start: Date;
  locality: string | null;
  county: string | null;
  state_province: string | null;
  specimen_count: number;
  inat_observation_id: bigint | null;
}

/** A clean sample with labels still to print (the pending_print_sample view). */
export interface PendingRow {
  sample_id: number;
  sample_number: string;
  date_start: Date;
  locality: string | null;
  county: string | null;
  state_province: string | null;
  pending_count: number;
}

/** Where a sample was collected, as one line, from whichever parts we have. */
const place = (s: { locality: string | null; county: string | null; state_province: string | null }) =>
  [s.locality, s.county, s.state_province].filter(Boolean).join(", ");

interface SampleGroup {
  rows: FindingRow[];
  blocking: number;
}

export function groupBySample(rows: FindingRow[]): SampleGroup[] {
  const groups = new Map<number, SampleGroup>();
  for (const row of rows) {
    let group = groups.get(row.sample_id);
    if (group === undefined) {
      group = { rows: [], blocking: 0 };
      groups.set(row.sample_id, group);
    }
    group.rows.push(row);
    if (row.severity === "blocking") group.blocking += 1;
  }
  for (const group of groups.values()) {
    group.rows.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1));
  }
  return [...groups.values()];
}

function SampleCard({ m, group, others }: { m: Messages; group: SampleGroup; others: string[] }) {
  const s = group.rows[0]!;
  return (
    <Card as="article">
      <h3 class="row baseline">
        {m.qc.sampleTitle(s.sample_number, s.date_start)}
        <Meta>
          {place(s)} · {m.qc.specimens(s.specimen_count)}
          {others.length > 0 && <> · {m.qc.collectedWith(m.format.list(others))}</>}
        </Meta>
      </h3>
      <ul class="stack plain">
        {group.rows.map((row) => (
          <li>
            <Chip tone={row.severity === "blocking" ? "blocking" : "warning"}>
              {row.severity === "blocking" ? m.qc.blocksPrinting : m.qc.headsUp}
            </Chip>{" "}
            {m.qcInstructions[row.rule_name] ?? row.rule_name}
            {row.details && (
              <>
                {" "}
                <code>{row.details}</code>
              </>
            )}
          </li>
        ))}
      </ul>
      {s.inat_observation_id !== null ? (
        <p>
          <LinkButton href={`https://www.inaturalist.org/observations/${s.inat_observation_id}`}>
            {m.qc.fixOnInat}
          </LinkButton>
        </p>
      ) : (
        <>
          <Meta block>{m.qc.notInatBacked}</Meta>
          <p>
            <LinkButton href={`/samples/${s.sample_id}/edit`}>{m.qc.editSample}</LinkButton>
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * What is waiting on labels. Deliberately inert: a clean sample needs
 * nothing from its collector, so the section reports and offers no actions.
 * Membership is the pending_print_sample view's business, not this file's.
 */
function PendingPrint({ m, rows, withOthers }: { m: Messages; rows: PendingRow[]; withOthers: CoCollectors }) {
  if (rows.length === 0) return null;
  const labels = rows.reduce((sum, r) => sum + r.pending_count, 0);
  return (
    <>
      <h2>{m.pendingPrint.heading}</h2>
      <Meta block>{m.pendingPrint.summary(rows.length, labels)}</Meta>
      <DataTable columns={[m.pendingPrint.colSample, m.pendingPrint.colPlace, m.pendingPrint.colLabels]}>
        {rows.map((r) => (
          <tr>
            <td>
              {m.qc.sampleTitle(r.sample_number, r.date_start)}
              {(withOthers.get(r.sample_id) ?? []).length > 0 && (
                <Meta block>{m.qc.collectedWith(m.format.list(withOthers.get(r.sample_id)!))}</Meta>
              )}
            </td>
            <td>{place(r)}</td>
            <td>{m.format.number(r.pending_count)}</td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

/** sample_id → the other people who collected it, in recordedBy order. */
export type CoCollectors = ReadonlyMap<number, string[]>;

export function QcHome(props: {
  m: Messages;
  findings: FindingRow[];
  pending: PendingRow[];
  /** Absent on proofing surfaces that render no shared samples. */
  withOthers?: CoCollectors;
  syncedAt: Date | null;
  /**
   * How many of this person's samples from closed seasons still carry flags.
   * They are deliberately not in `findings` — settling is what keeps the list
   * about this season — so the page says the number out loud instead of
   * letting them vanish (beeline-2c3.24).
   */
  settledFlagged?: number;
}) {
  const { m } = props;
  const withOthers: CoCollectors = props.withOthers ?? new Map();
  const groups = groupBySample(props.findings);
  const blocking = groups.reduce((sum, g) => sum + g.blocking, 0);
  const settledFlagged = props.settledFlagged ?? 0;
  const settledLine = settledFlagged > 0 && (
    <Callout>
      <Meta block>
        {m.qc.settled.note(settledFlagged)}{" "}
        <a href={`/samples?qc=flagged`}>{m.qc.settled.link}</a>
      </Meta>
    </Callout>
  );
  const syncLine = (
    <Callout>
      <Meta block>
        {props.syncedAt === null ? m.qc.neverSynced : m.qc.lastSynced(props.syncedAt)} {m.qc.clearsNote}
      </Meta>
    </Callout>
  );

  return (
    <>
      {groups.length === 0 ? (
        <>
          <PageHeader title={m.qc.allClearHeading} />
          <EmptyState>{m.qc.allClear}</EmptyState>
          {syncLine}
          {settledLine}
        </>
      ) : (
        <>
          <PageHeader title={m.qc.heading} lede={m.qc.summary(groups.length, blocking)} />
          {syncLine}
          {settledLine}
          {groups.map((group) => (
            <SampleCard m={m} group={group} others={withOthers.get(group.rows[0]!.sample_id) ?? []} />
          ))}
        </>
      )}
      <PendingPrint m={m} rows={props.pending} withOthers={withOthers} />
    </>
  );
}
