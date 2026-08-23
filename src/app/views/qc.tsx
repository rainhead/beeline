import type { QcSeverity } from "../../model.js";
import type { Messages } from "../messages/index.js";
import { Callout, Card, Chip, EmptyState, LinkButton, Meta, PageHeader } from "./components/index.js";

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

function SampleCard({ m, group }: { m: Messages; group: SampleGroup }) {
  const s = group.rows[0]!;
  const place = [s.locality, s.county, s.state_province].filter(Boolean).join(", ");
  return (
    <Card as="article">
      <h3 class="row baseline">
        {m.qc.sampleTitle(s.sample_number, s.date_start)}
        <Meta>
          {place} · {m.qc.specimens(s.specimen_count)}
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

export function QcHome(props: { m: Messages; findings: FindingRow[]; syncedAt: Date | null }) {
  const { m } = props;
  const groups = groupBySample(props.findings);
  const blocking = groups.reduce((sum, g) => sum + g.blocking, 0);
  const syncLine = (
    <Callout>
      <Meta block>
        {props.syncedAt === null ? m.qc.neverSynced : m.qc.lastSynced(props.syncedAt)} {m.qc.clearsNote}
      </Meta>
    </Callout>
  );

  if (groups.length === 0) {
    return (
      <>
        <PageHeader title={m.qc.allClearHeading} />
        <EmptyState>{m.qc.allClear}</EmptyState>
        {syncLine}
      </>
    );
  }
  return (
    <>
      <PageHeader title={m.qc.heading} lede={m.qc.summary(groups.length, blocking)} />
      {syncLine}
      {groups.map((group) => (
        <SampleCard m={m} group={group} />
      ))}
    </>
  );
}
