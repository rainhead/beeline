import type { Child } from "hono/jsx";
import type { Messages } from "../messages/index.js";
import { sampleHref, specimenHref } from "../record.js";
import {
  CHANGE_KINDS,
  HOLD_REASONS,
  type CellChange,
  type HeldItem,
  type SampleChange,
  type SeasonSplit,
  type SpecimenChange,
  type UnitCell,
  type UploadPlan,
} from "../upload-plan.js";
import { Absent, Button, Callout, Card, DataTable, EmptyState, Field, Meta, PageHeader, TextField } from "./components/index.js";

/**
 * Comparing an edited copy of the specimens download (beeline-kgyd): the form
 * and the person's earlier uploads, and one upload's preview. Staff pages. The
 * preview says what differs and what is held; it changes nothing.
 */

export const uploadHref = (id: number) => `/uploads/${id}`;

/** The most lines any one list shows; the rest are counted. */
export const LIST_CAP = 200;

export interface UploadListRow {
  entity_id: number;
  file_name: string;
  uploaded_at: Date;
  row_count: number;
}

export interface UploadDetail extends UploadListRow {
  uploader: string;
  reference: string | null;
}

export function Uploads({
  m,
  uploads,
  refusal = null,
}: {
  m: Messages;
  uploads: UploadListRow[];
  /** Why the last file was refused, as the catalog's words. */
  refusal?: string | null;
}) {
  const u = m.uploads;
  return (
    <>
      <PageHeader title={u.heading} lede={u.intro} />
      {refusal !== null && <Callout tone="warning">{refusal}</Callout>}
      <Card>
        <h2>{u.form.heading}</h2>
        <form method="post" action="/uploads" enctype="multipart/form-data" class="form-column">
          <Field id="file" label={u.form.fileLabel} hint={u.form.fileHint}>
            <input id="file" name="file" type="file" accept=".csv,text/csv" required />
          </Field>
          <TextField id="reference" name="reference" label={u.form.referenceLabel} hint={u.form.referenceHint} />
          <p class="row">
            <Button>{u.form.button}</Button>
          </p>
        </form>
      </Card>
      <h2>{u.earlier}</h2>
      {uploads.length === 0 ? (
        <EmptyState>{u.none}</EmptyState>
      ) : (
        <DataTable columns={[u.colFile, u.colWhen, u.colRows]}>
          {uploads.map((row) => (
            <tr>
              <td>
                <a href={uploadHref(row.entity_id)}>{row.file_name}</a>
              </td>
              <td>{m.format.dateTime(row.uploaded_at)}</td>
              <td>{m.format.number(row.row_count)}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}

const Said = ({ m, value }: { m: Messages; value: string }) =>
  value === "" ? <Absent label={m.uploads.page.nothing} spelled /> : <q>{value}</q>;

const SpecimenLink = ({ m, id, fieldNumber }: { m: Messages; id: number; fieldNumber: string | null }) => (
  <a href={specimenHref(id)}>{fieldNumber ?? m.uploads.page.specimen(id)}</a>
);

/** A list cut at LIST_CAP lines, with the rest counted. */
function Capped<T>({ m, items, line }: { m: Messages; items: readonly T[]; line: (item: T) => Child }) {
  return (
    <>
      <ul>
        {items.slice(0, LIST_CAP).map((item) => (
          <li>{line(item)}</li>
        ))}
      </ul>
      {items.length > LIST_CAP && <Meta block>{m.uploads.page.more(items.length - LIST_CAP)}</Meta>}
    </>
  );
}

function Cells({ m, cells }: { m: Messages; cells: UnitCell[] }) {
  const p = m.uploads.page;
  const differing = cells.filter((c) => c.differs);
  return (
    <>
      {differing.map((c, i) => (
        <>
          {i > 0 && "; "}
          {c.column}: {p.was} <Said m={m} value={c.was} />, {p.fileSays} <Said m={m} value={c.fileSays} />
        </>
      ))}
    </>
  );
}

function CellLine({ m, c }: { m: Messages; c: CellChange }) {
  const p = m.uploads.page;
  return (
    <>
      <SpecimenLink m={m} id={c.specimenId} fieldNumber={c.fieldNumber} /> <Meta>{p.row(c.row)}</Meta> {c.column}: {p.was}{" "}
      <Said m={m} value={c.was} />, {p.fileSays} <Said m={m} value={c.fileSays} />
    </>
  );
}

function SpecimenLine({ m, c }: { m: Messages; c: SpecimenChange }) {
  const p = m.uploads.page;
  return (
    <>
      <SpecimenLink m={m} id={c.specimenId} fieldNumber={c.fieldNumber} /> <Meta>{p.row(c.row)}</Meta> <Cells m={m} cells={c.cells} />
    </>
  );
}

function SampleLine({ m, c }: { m: Messages; c: SampleChange }) {
  const p = m.uploads.page;
  return (
    <>
      <a href={sampleHref(c.sampleId)}>{c.sampleNumber}</a> <Meta>{p.row(c.rows[0]!)}</Meta> <Cells m={m} cells={c.cells} />{" "}
      <Meta>
        {p.sampleSpecimens(c.specimensInFile, c.specimensInSample)}; {c.printed ? p.printed : p.notPrinted}
      </Meta>
    </>
  );
}

function HeldLine({ m, h }: { m: Messages; h: HeldItem }) {
  const p = m.uploads.page;
  const others = h.cells.filter((c) => c.column !== h.column);
  return (
    <>
      {h.specimenId !== null && <SpecimenLink m={m} id={h.specimenId} fieldNumber={h.fieldNumber} />}
      {h.specimenId === null && h.sampleNumber !== null && <>{h.sampleNumber}</>} <Meta>{h.rows.length > 1 ? h.rows.map(p.row).join(", ") : p.row(h.row)}</Meta>
      {h.column !== null && <> {h.column}</>}: {p.heldDetail[h.reason] ?? ""} {h.detail === "" ? <Absent label={p.nothing} spelled /> : <q>{h.detail}</q>}
      {others.length > 0 && (
        <>
          {" "}
          <Meta>{p.heldWith}</Meta>{" "}
          {others.map((c, i) => (
            <>
              {i > 0 && "; "}
              {c.column}: {p.fileSays} <Said m={m} value={c.fileSays} />
            </>
          ))}
        </>
      )}
    </>
  );
}

const total = (s: SeasonSplit) => s.active + s.settled + s.unplaced;

export function UploadPreview({ m, upload, plan }: { m: Messages; upload: UploadDetail; plan: UploadPlan }) {
  const p = m.uploads.page;
  const split: Array<[string, SeasonSplit]> = [
    [p.rowsTotal, plan.counts.rows],
    [p.rowsUnchanged, plan.counts.unchanged],
    [p.rowsChanged, plan.counts.withChanges],
    [p.rowsHeld, plan.counts.held],
  ];
  const sampleChangesOf = (kind: string) => plan.sampleChanges.filter((c) => c.unit === kind);
  const changesOf = (kind: string) => plan.changes.filter((c) => c.unit === kind);
  const kinds = CHANGE_KINDS.filter((k) => k !== "not_applied");
  const anyChange = plan.changes.length > 0 || plan.sampleChanges.length > 0;
  const heldBy = (reason: string) => plan.held.filter((h) => h.reason === reason);
  return (
    <>
      <PageHeader title={p.title(upload.file_name)} meta={p.uploaded(m.format.dateTime(upload.uploaded_at), upload.uploader)} />
      <p>
        <a href="/uploads">{p.back}</a>
      </p>
      {upload.reference !== null && <Meta block>{p.reference(upload.reference)}</Meta>}
      <Callout>{p.notChanged}</Callout>

      <h2>{p.countsHeading}</h2>
      <DataTable columns={["", p.colActive, p.colSettled, p.colUnplaced, p.colCount]}>
        {split.map(([label, s]) => (
          <tr>
            <td>{label}</td>
            <td>{m.format.number(s.active)}</td>
            <td>{m.format.number(s.settled)}</td>
            <td>{m.format.number(s.unplaced)}</td>
            <td>{m.format.number(total(s))}</td>
          </tr>
        ))}
      </DataTable>

      <h2>{p.changesHeading}</h2>
      {!anyChange && <EmptyState>{p.noChanges}</EmptyState>}
      {kinds.map((kind) => {
        const own = changesOf(kind);
        const samples = sampleChangesOf(kind);
        if (own.length === 0 && samples.length === 0) return null;
        return (
          <section>
            <h3>
              {p.kind[kind]} <Meta>{m.format.number(own.length + samples.length)}</Meta>
            </h3>
            <Meta block>{samples.length > 0 ? `${p.sampleNote} ${p.unitNote}` : p.unitNote}</Meta>
            <Capped m={m} items={samples} line={(c) => <SampleLine m={m} c={c} />} />
            <Capped m={m} items={own} line={(c) => <SpecimenLine m={m} c={c} />} />
          </section>
        );
      })}

      <h2>{p.heldHeading}</h2>
      {plan.held.length === 0 && <EmptyState>{p.noHeld}</EmptyState>}
      {HOLD_REASONS.map((reason) => {
        const items = heldBy(reason);
        if (items.length === 0) return null;
        return (
          <section>
            <h3>
              {p.held[reason]} <Meta>{m.format.number(items.length)}</Meta>
            </h3>
            <Capped m={m} items={items} line={(h) => <HeldLine m={m} h={h} />} />
          </section>
        );
      })}

      {plan.notApplied.length > 0 && (
        <details>
          <summary>
            {p.notAppliedHeading} <Meta>{m.format.number(plan.notApplied.length)}</Meta>
          </summary>
          <Meta block>{p.notAppliedNote}</Meta>
          <Capped m={m} items={plan.notApplied} line={(c) => <CellLine m={m} c={c} />} />
        </details>
      )}
    </>
  );
}

/** An upload whose kept file cannot be read again. */
export function UploadProblem({ m, message }: { m: Messages; message: string }) {
  return (
    <>
      <PageHeader title={m.uploads.title} />
      <Callout tone="warning">{message}</Callout>
      <p>
        <a href="/uploads">{m.uploads.page.back}</a>
      </p>
    </>
  );
}
