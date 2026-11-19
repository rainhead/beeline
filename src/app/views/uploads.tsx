import type { Child } from "hono/jsx";
import type { Messages } from "../messages/index.js";
import { sampleHref, specimenHref } from "../record.js";
import { driveFileHref } from "../upload-archive.js";
import type { DraftLine } from "../upload-drafts.js";
import {
  CHANGE_KINDS,
  HOLD_REASONS,
  type CellChange,
  type HeldItem,
  type SampleLabel,
  type SampleDifference,
  type SeasonSplit,
  type SpecimenDifference,
  type UnrecognisedColumn,
  type UploadPlan,
} from "../upload-plan.js";
import { Absent, Button, Callout, Card, DataTable, EmptyState, Field, Meta, PageHeader, TextField } from "./components/index.js";

/**
 * Comparing an edited copy of the specimens download (beeline-kgyd): the form
 * and the person's earlier uploads, and one upload's preview. The preview says
 * what differs and what is held. Staff's changes nothing; a volunteer's offers
 * to save their identifications as drafts on Identify specimens (beeline-kgyd.7).
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
  /** The copy in the Drive folder of received files, if one was kept. */
  drive_file_id: string | null;
}

export function Uploads({
  m,
  uploads,
  refusal = null,
  staff = true,
}: {
  m: Messages;
  uploads: UploadListRow[];
  /** Why the last file was refused, as the catalog's words. */
  refusal?: string | null;
  /** Staff's page, or a volunteer's, whose file becomes drafts and whose form does not ask for a request. */
  staff?: boolean;
}) {
  const u = m.uploads;
  return (
    <>
      <PageHeader title={staff ? u.heading : u.headingVolunteer} lede={staff ? u.intro : u.introVolunteer} />
      {refusal !== null && <Callout tone="warning">{refusal}</Callout>}
      <Card>
        <h2>{u.form.heading}</h2>
        <form method="post" action="/uploads" enctype="multipart/form-data" class="form-column">
          <Field id="file" label={u.form.fileLabel} hint={staff ? u.form.fileHint : u.form.fileHintVolunteer}>
            <input id="file" name="file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
          </Field>
          {staff && <TextField id="reference" name="reference" label={u.form.referenceLabel} hint={u.form.referenceHint} />}
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

/** A column as the person sees it in their spreadsheet: a literal, set as the app sets one. */
const Col = ({ name }: { name: string }) => <code>{name}</code>;

/** `column: was X, file says Y`, one for each cell, with the cells' own words. */
function Cells({ m, cells }: { m: Messages; cells: ReadonlyArray<{ column: string; was: string; fileSays: string; rows?: number[]; moreRows?: number }> }) {
  const p = m.uploads.page;
  return (
    <>
      {cells.map((c, i) => (
        <>
          {i > 0 && "; "}
          <Col name={c.column} />: {p.was} <Said m={m} value={c.was} />, {p.fileSays} <Said m={m} value={c.fileSays} />
          {c.rows !== undefined && <> <Meta>({p.heldRows(c.rows.join(", "), c.moreRows ?? 0)})</Meta></>}
        </>
      ))}
    </>
  );
}

/** A sample as the listings name it: its number as a link, then who collected it and when. */
function SampleName({ m, sample }: { m: Messages; sample: SampleLabel }) {
  const by = sample.collectors.length === 0 ? "" : `${m.format.list(sample.collectors)}, `;
  return (
    <>
      <a href={sampleHref(sample.id)}>{sample.number}</a>{" "}
      <Meta>
        {by}
        {m.format.dateRange(sample.dateStart, sample.dateEnd)}
      </Meta>
    </>
  );
}

function CellLine({ m, c }: { m: Messages; c: CellChange }) {
  const p = m.uploads.page;
  return (
    <>
      <SpecimenLink m={m} id={c.specimenId} fieldNumber={c.fieldNumber} /> <Meta>{p.row(c.row)}</Meta>{" "}
      <Cells m={m} cells={[{ column: c.column, was: c.was, fileSays: c.fileSays }]} />
    </>
  );
}

function SpecimenLine({ m, c, replacesDraft = false }: { m: Messages; c: SpecimenDifference; replacesDraft?: boolean }) {
  const p = m.uploads.page;
  return (
    <>
      <SpecimenLink m={m} id={c.specimenId} fieldNumber={c.fieldNumber} /> <Meta>{p.row(c.row)}</Meta>{" "}
      <Cells m={m} cells={c.cells.filter((x) => x.differs)} />
      {replacesDraft && <> <Meta>({p.replacesDraft})</Meta></>}
    </>
  );
}

function SampleLine({ m, c }: { m: Messages; c: SampleDifference }) {
  const p = m.uploads.page;
  return (
    <>
      <SampleName m={m} sample={c.sample} /> <Meta>{p.row(c.rows[0]!)}</Meta>{" "}
      <Cells m={m} cells={c.cells.filter((x) => x.differs)} />{" "}
      <Meta>
        {p.sampleSpecimens(c.specimensInFile, c.specimensInSample)}; {c.printed ? p.printed : p.notPrinted}
      </Meta>
    </>
  );
}

/** Reasons whose detail is something the reader can use; the others are told by the cells or the heading alone. */
const SHOWS_DETAIL: readonly string[] = ["no_id", "repeated", "no_specimen", "number_disagrees", "rows_disagree", "column_missing"];

function HeldLine({ m, h }: { m: Messages; h: HeldItem }) {
  const p = m.uploads.page;
  return (
    <>
      {h.specimenId !== null && <SpecimenLink m={m} id={h.specimenId} fieldNumber={h.fieldNumber} />}
      {h.specimenId === null && h.sample !== null && <SampleName m={m} sample={h.sample} />}{" "}
      <Meta>{h.rows.length > 1 || h.moreRows > 0 ? p.heldRows(h.rows.join(", "), h.moreRows) : p.row(h.row)}</Meta>
      {h.cells.length > 0 && (
        <>
          {" "}
          <Cells m={m} cells={h.cells} />
        </>
      )}
      {SHOWS_DETAIL.includes(h.reason) && (
        <>
          {" "}
          {p.heldDetail[h.reason] ?? ""} {h.detail === "" ? <Absent label={p.nothing} spelled /> : <q>{h.detail}</q>}
        </>
      )}
    </>
  );
}

/** Columns of the file that Beeline did not read, near the top because they may hold edits that will not be used. */
function Unrecognised({ m, columns }: { m: Messages; columns: UnrecognisedColumn[] }) {
  const p = m.uploads.page;
  return (
    <section>
      <h2>{p.unrecognisedHeading}</h2>
      <p>{p.unrecognisedNote}</p>
      <ul>
        {columns.map((c) => (
          <li>
            <Col name={c.header} /> <Meta>{p.unrecognised(c.letter)}</Meta>
            {c.probably !== null && (
              <>
                {" "}
                {p.unrecognisedMeant} <Col name={c.probably} />. {p.unrecognisedFix}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const total = (s: SeasonSplit) => s.active + s.settled + s.unplaced;

/** What the preview of a volunteer's file shows beyond staff's: the drafts it would save, and whether it has. */
export interface VolunteerPreview {
  lines: DraftLine[];
  /** Rows for specimens the person may not name. */
  notYours: number;
  /** What saving would write, carried by the form so that saving refuses a plan that changed since. */
  digest: string;
  /** The person looking is the uploader, and there is something to save that has not been saved. */
  canSave: boolean;
  /** When the drafts were saved, and how many. */
  applied: { at: Date; count: number } | null;
  /** Saving was asked for, but the plan had changed since the preview, so this is the new one. */
  changedSince: boolean;
}

/** The volunteer's form: save the listed identifications as drafts. */
function SaveDrafts({ m, uploadId, volunteer }: { m: Messages; uploadId: number; volunteer: VolunteerPreview }) {
  const p = m.uploads.page;
  return (
    <form method="post" action={`${uploadHref(uploadId)}/apply`} class="form-column">
      <input type="hidden" name="digest" value={volunteer.digest} />
      <p>{p.saveNote(volunteer.lines.length, volunteer.lines.filter((l) => l.replacesDraft).length)}</p>
      <p class="row">
        <Button>{p.save}</Button>
      </p>
    </form>
  );
}

export function UploadPreview({
  m,
  upload,
  plan,
  volunteer = null,
}: {
  m: Messages;
  upload: UploadDetail;
  plan: UploadPlan;
  /** A volunteer's file; null for staff's, which changes nothing. */
  volunteer?: VolunteerPreview | null;
}) {
  const p = m.uploads.page;
  const split: Array<[string, SeasonSplit]> = [
    [p.rowsTotal, plan.counts.rows],
    [p.rowsUnchanged, plan.counts.unchanged],
    [p.rowsChanged, plan.counts.withDifferences],
    [p.rowsHeld, plan.counts.held],
  ];
  const sampleChangesOf = (kind: string) => plan.sampleDifferences.filter((c) => c.unit === kind);
  const changesOf = (kind: string) => plan.differences.filter((c) => c.unit === kind);
  const kinds = CHANGE_KINDS.filter((k) => k !== "not_applied");
  const anyChange = plan.differences.length > 0 || plan.sampleDifferences.length > 0;
  const heldBy = (reason: string) => plan.held.filter((h) => h.reason === reason);
  const replacing = new Set((volunteer?.lines ?? []).filter((l) => l.replacesDraft).map((l) => l.write.specimenId));
  const head = (
    <>
      <PageHeader title={p.title(upload.file_name)} lede={p.uploadedCopy} meta={p.uploaded(m.format.dateTime(upload.uploaded_at), upload.uploader)} />
      <p>
        <a href="/uploads">{p.back}</a>
      </p>
      {upload.reference !== null && <Meta block>{p.reference(upload.reference)}</Meta>}
      {upload.drive_file_id !== null && (
        <Meta block>
          <a href={driveFileHref(upload.drive_file_id)}>{p.keptInDrive}</a>
        </Meta>
      )}
      {volunteer === null && <Callout>{p.notChanged}</Callout>}
    </>
  );
  // Once saved, the file is compared no more: the drafts it made are what the person's own identification now is,
  // so every row would read as changed since the file was downloaded.
  if (volunteer?.applied != null) {
    return (
      <>
        {head}
        <Callout tone="success">
          {p.applied(m.format.dateTime(volunteer.applied.at), volunteer.applied.count)} <a href="/determinations">{p.identifyLink}</a>
        </Callout>
      </>
    );
  }
  return (
    <>
      {head}
      {volunteer !== null && volunteer.changedSince && <Callout tone="warning">{p.changedSince}</Callout>}
      {volunteer !== null && <Callout>{p.notSavedYet}</Callout>}
      {plan.unrecognised.length > 0 && <Unrecognised m={m} columns={plan.unrecognised} />}
      {plan.otherSheets.length > 0 && (
        <section>
          <h2>{p.otherSheetsHeading}</h2>
          <p>{p.otherSheetsNote}</p>
          <ul>
            {plan.otherSheets.map((name) => (
              <li>
                <Col name={name} />
              </li>
            ))}
          </ul>
        </section>
      )}

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
      {volunteer !== null && volunteer.notYours > 0 && <Meta block>{p.notYours(volunteer.notYours)}</Meta>}

      <h2>{p.changesHeading}</h2>
      {!anyChange && <EmptyState>{p.nothingDiffers(plan.held.length > 0, plan.notApplied.length > 0)}</EmptyState>}
      {kinds.map((kind) => {
        const own = changesOf(kind);
        const samples = sampleChangesOf(kind);
        if (own.length === 0 && samples.length === 0) return null;
        return (
          <section>
            <h3>
              {p.kind[kind]} <Meta>{m.format.number(own.length + samples.length)}</Meta>
            </h3>
            {samples.length > 0 && <Meta block>{p.sampleNote}</Meta>}
            {p.unitNote[kind] !== undefined && <Meta block>{p.unitNote[kind]}</Meta>}
            <Capped m={m} items={samples} line={(c) => <SampleLine m={m} c={c} />} />
            <Capped m={m} items={own} line={(c) => <SpecimenLine m={m} c={c} replacesDraft={replacing.has(c.specimenId)} />} />
          </section>
        );
      })}

      {volunteer !== null && volunteer.canSave && <SaveDrafts m={m} uploadId={upload.entity_id} volunteer={volunteer} />}

      <h2>{p.heldHeading}</h2>
      {plan.held.length === 0 ? <EmptyState>{p.noHeld}</EmptyState> : <p>{p.heldIntro}</p>}
      {HOLD_REASONS.map((reason) => {
        const items = heldBy(reason);
        if (items.length === 0) return null;
        return (
          <section>
            <h3>
              {p.held[reason]} <Meta>{m.format.number(items.length)}</Meta>
            </h3>
            {p.heldTodo[reason] !== undefined && <p>{p.heldTodo[reason]}</p>}
            {[...new Set(items.flatMap((h) => (h.unit === null ? [] : [h.unit])))].map((unit) =>
              p.unitNote[unit] === undefined ? null : <Meta block>{p.unitNote[unit]}</Meta>,
            )}
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
