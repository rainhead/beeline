import type { Child } from "hono/jsx";
import type { PrintRunState } from "../../model.js";
import type { Messages } from "../messages/index.js";
import type { RunDetail, RunLabelRow, RunListRow, ScopeCounts } from "../print-runs.js";
import { sampleHref, specimenHref } from "../record.js";
import {
  Absent,
  Button,
  Callout,
  Card,
  Chip,
  DataTable,
  EmptyState,
  LinkButton,
  Meta,
  OrAbsent,
  PageHeader,
  SelectField,
  TextField,
} from "./components/index.js";

/**
 * Print runs (beeline-1kb.2): the list with its Prepare form, and one run
 * — the proofing surface and the four buttons. Staff pages, read from the
 * catalog like everything else.
 */

export const printRunHref = (id: number) => `/print-runs/${id}`;

const TONE: Record<PrintRunState, "neutral" | "success" | "warning" | "blocking"> = {
  prepared: "neutral",
  approved: "warning",
  printed: "success",
  mailed: "success",
  canceled: "blocking",
};

export function StateChip({ m, state }: { m: Messages; state: PrintRunState }) {
  return <Chip tone={TONE[state]}>{m.printRuns.state[state] ?? state}</Chip>;
}

function Scope({ m, run }: { m: Messages; run: Pick<RunListRow, "atlas_code"> }) {
  return run.atlas_code === null ? <Meta>{m.printRuns.scopeProgram}</Meta> : <>{run.atlas_code}</>;
}

/** A date the run has not reached yet is said, never left blank. */
function When({ m, at }: { m: Messages; at: Date | null }) {
  return at === null ? <Absent label={m.printRuns.notYet} /> : <>{m.format.date(at)}</>;
}

export function PrintRuns({
  m,
  runs,
  scope,
  nothingPrepared = false,
}: {
  m: Messages;
  runs: RunListRow[];
  scope: ScopeCounts;
  /** The last Prepare found nothing pending in its scope. */
  nothingPrepared?: boolean;
}) {
  const p = m.printRuns;
  const covered = scope.atlases.filter((a) => !a.own).map((a) => a.code);
  const waiting = (labels: number, samples: number) =>
    labels === 0 ? p.prepare.nothingWaiting : p.prepare.waiting(labels, samples);
  const options: ReadonlyArray<readonly [string, Child]> = [
    ["", `${p.prepare.program} — ${waiting(scope.program.labels, scope.program.samples)}`],
    ...scope.atlases.map(
      (a) =>
        [
          String(a.atlas_id),
          `${a.name}${a.own ? ` (${p.prepare.own})` : ""} — ${waiting(a.labels, a.samples)}`,
        ] as const,
    ),
  ];
  return (
    <>
      <PageHeader title={p.heading} lede={p.intro} />
      {nothingPrepared && <Callout>{p.prepare.nothingToPrepare}</Callout>}

      <Card>
        <h2>{p.prepare.heading}</h2>
        <form method="post" action="/print-runs" class="form-column">
          <SelectField
            id="atlas_id"
            name="atlas_id"
            label={p.prepare.scopeLabel}
            value=""
            options={options}
            hint={p.prepare.programCovers(covered)}
          />
          <Meta block>{p.prepare.hint}</Meta>
          <p class="row">
            <Button>{p.prepare.button}</Button>
          </p>
        </form>
      </Card>

      <h2>{p.title}</h2>
      {runs.length === 0 ? (
        <EmptyState>{p.none}</EmptyState>
      ) : (
        <DataTable
          columns={[
            p.colRun,
            p.colScope,
            p.colState,
            p.colPrepared,
            p.colLabels,
            p.colSamples,
            p.colCollectors,
            p.colSheets,
            p.colPrinted,
            p.colMailed,
          ]}
        >
          {runs.map((run) => (
            <tr>
              <td>
                <a href={printRunHref(run.print_run_id)}>{p.run.title(run.print_run_id)}</a>
              </td>
              <td>
                <Scope m={m} run={run} />
              </td>
              <td>
                <StateChip m={m} state={run.state} />
              </td>
              <td>
                {m.format.date(run.prepared_at)}
                <Meta block>{run.prepared_by}</Meta>
              </td>
              <td>{m.format.number(run.label_count)}</td>
              <td>{m.format.number(run.sample_count)}</td>
              <td>{m.format.number(run.collector_count)}</td>
              <td>{m.format.number(run.sheet_count)}</td>
              <td>
                <When m={m} at={run.printed_at} />
              </td>
              <td>
                <When m={m} at={run.mailed_at} />
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}

/** The one action the run's state allows next, with the note it may carry. */
function NextAction({ m, run }: { m: Messages; run: RunDetail }) {
  const r = m.printRuns.run;
  const action = printRunHref(run.print_run_id);
  const next =
    run.state === "prepared"
      ? { path: "approve", label: r.approve, hint: r.approveHint }
      : run.state === "approved"
        ? { path: "printed", label: r.markPrinted, hint: r.markPrintedHint }
        : run.state === "printed"
          ? { path: "mailed", label: r.markMailed, hint: r.markMailedHint }
          : null;
  if (next === null) {
    return (
      <Meta block>
        {run.state === "canceled" ? r.canceledAt(m.format.dateTime(run.canceled_at!), run.note) : r.done}
      </Meta>
    );
  }
  const canCancel = run.state === "prepared" || run.state === "approved";
  return (
    <>
      <form id="next-form" method="post" action={`${action}/${next.path}`} class="form-column">
        <TextField id="note" name="note" label={r.note} hint={r.noteHint} value={run.note} />
        <Meta block>{next.hint}</Meta>
      </form>
      {/* One form, two destinations: the note belongs to whichever button is
          pressed, so Cancel submits the same fields to its own action rather
          than an empty form of its own, which lost the reason typed for it. */}
      <p class="row">
        <Button form="next-form">{next.label}</Button>
        {canCancel && (
          <Button form="next-form" formaction={`${action}/cancel`} variant="outlined">
            {r.cancel}
          </Button>
        )}
      </p>
      {canCancel && <Meta block>{r.cancelHint}</Meta>}
    </>
  );
}

export function PrintRun({ m, run, labels }: { m: Messages; run: RunDetail; labels: RunLabelRow[] }) {
  const r = m.printRuns.run;
  const warned = labels.filter((l) => l.warnings !== null);
  return (
    <>
      <p>
        <a href="/print-runs">{r.back}</a>
      </p>
      <PageHeader
        title={r.title(run.print_run_id)}
        lede={
          <>
            {run.atlas_name === null ? r.scopeProgram : r.scopeAtlas(run.atlas_name)}{" "}
            {r.counts(run.label_count, run.sample_count, run.collector_count, run.sheet_count)}
          </>
        }
        meta={
          <>
            <StateChip m={m} state={run.state} /> {r.preparedBy(run.prepared_by, m.format.dateTime(run.prepared_at))}
          </>
        }
      />

      <Card>
        {/* A canceled run's labels were never printed and never will be:
            their numbers are burned and its samples are waiting again, so
            there are no sheets to offer. The table below stays, as history. */}
        {run.state !== "canceled" && (
          <p class="row">
            <LinkButton href={`${printRunHref(run.print_run_id)}/labels.pdf`} variant="tonal">
              {r.download}
            </LinkButton>
          </p>
        )}
        <NextAction m={m} run={run} />
      </Card>

      {run.split_samples > 0 && <Callout tone="warning">{r.splitSamples(run.split_samples)}</Callout>}

      <Card>
        <h2>{warned.length === 0 ? r.warningsNone : r.warnings(warned.length)}</h2>
        {warned.length > 0 && (
          <>
            <Meta block>{r.warningsIntro}</Meta>
            <LabelTable m={m} labels={warned} />
          </>
        )}
      </Card>

      <h2>{r.labels}</h2>
      {labels.length === 0 ? <EmptyState>{r.noLabels}</EmptyState> : <LabelTable m={m} labels={labels} />}
    </>
  );
}

/** The six strings as they will print, one row per label, in sheet order. */
function LabelTable({ m, labels }: { m: Messages; labels: RunLabelRow[] }) {
  const r = m.printRuns.run;
  return (
    <DataTable
      columns={[
        r.colSheet,
        r.colCell,
        r.colNumber,
        r.colCollector,
        r.colDate,
        r.colLocation,
        r.colCoordinates,
        r.colMethod,
        r.colSample,
        r.colWarnings,
      ]}
    >
      {labels.map((l) => (
        <tr>
          <td>{m.format.number(l.sheet)}</td>
          <td>{m.format.number(l.cell)}</td>
          <td>
            <a href={specimenHref(l.specimen_id)} class="mono">
              {l.number_text}
            </a>
          </td>
          <td>{l.collector_text}</td>
          <td class="nowrap">{l.date_text}</td>
          <td>{l.location_text}</td>
          <td class="nowrap">{l.coordinates_text}</td>
          <td>{l.method_text}</td>
          <td>
            <a href={sampleHref(l.sample_id)}>{l.sample_number}</a>
          </td>
          <td>
            <OrAbsent value={l.warnings} label={m.absence.none} />
          </td>
        </tr>
      ))}
    </DataTable>
  );
}
