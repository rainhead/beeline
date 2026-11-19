import type { Messages } from "../messages/index.js";
import { driveFileHref } from "../upload-archive.js";
import type { SamplesSummary, StaffSummary, VolunteerSummary } from "../upload-notes.js";
import type { SeasonSplit, UnrecognisedColumn } from "../upload-plan.js";
import { Button, Callout, Card, DataTable, EmptyState, Field, LinkButton, Meta, PageHeader, TextField } from "./components/index.js";

/**
 * An edited copy of the specimens download (beeline-kgyd): the form and the
 * person's earlier uploads, and one upload's page. The page is a few counts
 * and two actions, never a list of rows: what is wrong with a row is a note on
 * that row of the file handed back (src/app/upload-notes.ts; Peter,
 * 2026-11-18). Staff's upload changes nothing; a volunteer's saves their own
 * identifications to Identify specimens (beeline-kgyd.7).
 */

export const uploadHref = (id: number) => `/uploads/${id}`;

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

/** Where the file with a note on each row is downloaded. */
export const notesHref = (id: number) => `${uploadHref(id)}/notes`;

/** What a volunteer's page shows beyond the counts: whether there is something to save, and whether it was saved. */
export interface VolunteerPreview {
  summary: VolunteerSummary;
  /** What saving would write, carried by the form so that saving refuses a page that went stale. */
  digest: string;
  /** The person looking is the uploader, and there is something not yet saved. */
  canSave: boolean;
  /** When the identifications were saved, and how many. */
  applied: { at: Date; count: number } | null;
  /** Saving was asked for, but something had changed since the page was shown, so this is how things stand now. */
  changedSince: boolean;
}

/** What the samples file's page shows beyond the counts: the form that applies it, and what applying has done. */
export interface SamplesPreview {
  /** What applying would do, carried by the form so that applying refuses a page that went stale. */
  digest: string;
  /** The person looking is the staff member who uploaded the file, it is not applied yet, and there are rows to apply. */
  canApply: boolean;
  /** When it was applied and by whom, once it was. */
  applied: { at: Date; by: string } | null;
  /** Applying was asked for, and why nothing was applied. */
  notice: "changed" | "busy" | "nothing_ticked" | null;
}

/** Columns the file has that Beeline did not read, and tabs it did not read: a line each, only where there are any. */
function NotRead({ m, unrecognised, otherSheets, read }: { m: Messages; unrecognised: UnrecognisedColumn[]; otherSheets: string[]; read?: string }) {
  const p = m.uploads.page;
  return (
    <>
      {unrecognised.length > 0 && (
        <p>{p.unrecognised(m.format.list(unrecognised.map((c) => (c.probably === null ? c.header : p.probably(c.header, c.probably)))))}</p>
      )}
      {otherSheets.length > 0 && <p>{p.otherSheets(m.format.list(otherSheets), read)}</p>}
    </>
  );
}

export function UploadPreview({
  m,
  upload,
  unrecognised,
  otherSheets,
  volunteer = null,
  staffSummary = null,
  samplesSummary = null,
  samples = null,
  staff = true,
  notesCopy = false,
}: {
  m: Messages;
  upload: UploadDetail;
  unrecognised: UnrecognisedColumn[];
  otherSheets: string[];
  /** A volunteer's file. */
  volunteer?: VolunteerPreview | null;
  /** Staff's file, which changes nothing. */
  staffSummary?: StaffSummary | null;
  /** The samples file. */
  samplesSummary?: SamplesSummary | null;
  /** The samples file's form and state. */
  samples?: SamplesPreview | null;
  /** Whether the reader is staff, who alone can open the copy kept in the program's shared drive. */
  staff?: boolean;
  /** The file with notes is a copy Beeline makes, since the person's own file cannot have a column added safely. */
  notesCopy?: boolean;
}) {
  const p = m.uploads.page;
  const rows = volunteer?.summary.rows ?? staffSummary?.rows ?? samplesSummary?.rows ?? upload.row_count;
  // Only the counts that are not zero: a line that says nothing is left off.
  const lines: string[] = [];
  if (volunteer !== null) {
    const s = volunteer.summary;
    if (s.ready > 0 && volunteer.applied === null) lines.push(p.ready(s.ready));
    if (s.notSaved > 0) lines.push(p.notSaved(s.notSaved));
    if (s.same > 0) lines.push(p.same(s.same));
    if (s.grey > 0) lines.push(p.grey(s.grey));
  } else if (staffSummary !== null) {
    const s = staffSummary;
    if (s.differ > 0) lines.push(p.differ(s.differ));
    if (s.cantUse > 0) lines.push(p.cantUse(s.cantUse));
    if (s.same > 0) lines.push(p.same(s.same));
    if (s.grey > 0) lines.push(p.staffGrey(s.grey));
  }
  if (samplesSummary !== null) {
    const c = samplesSummary.counts;
    const total = (split: SeasonSplit) => split.active + split.settled + split.unplaced;
    // Each count says how many of its rows are in the active seasons and how many in settled ones.
    const split = (of: SeasonSplit) => p.split(of.active, of.settled, of.unplaced);
    const o = samplesSummary.outcomes;
    if (o !== null) {
      if (o.pending > 0) lines.push(p.samplesApplying(o.total - o.pending, o.total));
      if (o.created > 0) lines.push(p.samplesCreated(o.created));
      if (o.notCreated > 0) lines.push(p.samplesNotCreated(o.notCreated));
    }
    if (total(c.newReady) > 0) lines.push(p.samplesNew(total(c.newReady), split(c.newReady)));
    if (total(c.newHeld) > 0) lines.push(p.samplesHeld(total(c.newHeld), split(c.newHeld)));
    if (total(c.cantUse) > 0) lines.push(p.samplesCantUse(total(c.cantUse), split(c.cantUse)));
    if (total(c.differ) > 0) lines.push(p.samplesDiffer(total(c.differ), split(c.differ)));
    if (total(c.same) > 0) lines.push(p.samplesSame(total(c.same), split(c.same)));
  }
  const notes =
    volunteer !== null
      ? volunteer.summary.notSaved + volunteer.summary.grey > 0
      : staffSummary !== null
        ? staffSummary.same < staffSummary.rows
        : samplesSummary !== null && samplesSummary.counts.same.active + samplesSummary.counts.same.settled + samplesSummary.counts.same.unplaced < samplesSummary.rows;
  return (
    <>
      <PageHeader title={p.title(upload.file_name)} lede={p.rows(rows)} meta={p.uploaded(m.format.dateTime(upload.uploaded_at), upload.uploader)} />
      <p>
        <a href="/uploads">{p.back}</a>
      </p>
      {upload.reference !== null && <Meta block>{p.reference(upload.reference)}</Meta>}
      {staff && upload.drive_file_id !== null && (
        <Meta block>
          <a href={driveFileHref(upload.drive_file_id)}>{p.keptInDrive}</a>
        </Meta>
      )}
      {volunteer?.applied != null && (
        <Callout tone="success">
          {p.saved(m.format.dateTime(volunteer.applied.at), volunteer.applied.count)} <a href="/determinations">{p.identifyLink}</a>
        </Callout>
      )}
      {volunteer !== null && volunteer.changedSince && <Callout tone="warning">{p.changedSince}</Callout>}
      {staffSummary !== null && <Callout>{p.staffNothingChanged}</Callout>}
      {samplesSummary !== null && samples?.notice === "changed" && <Callout tone="warning">{p.samplesChangedSince}</Callout>}
      {samplesSummary !== null && samples?.notice === "nothing_ticked" && <Callout tone="warning">{p.samplesNothingTicked}</Callout>}
      {samplesSummary !== null && samples?.notice === "busy" && <Callout tone="warning">{p.samplesBusy}</Callout>}
      {samplesSummary !== null && samples?.applied == null && <Callout>{p.samplesNothingChanged}</Callout>}
      {samplesSummary !== null && samples?.applied != null && (
        <Callout tone="success">
          {p.samplesApplied(m.format.dateTime(samples.applied.at), samples.applied.by)} {p.samplesExistingNotApplied}
        </Callout>
      )}
      {lines.map((line) => (
        <p>{line}</p>
      ))}
      {samplesSummary !== null && samplesSummary.unknownCollectors.length > 0 && (
        <p>{p.samplesUnknownCollectors(m.format.list(samplesSummary.unknownCollectors.map((c) => p.samplesUnknownCollector(c.name, c.rows))))}</p>
      )}
      <NotRead m={m} unrecognised={unrecognised} otherSheets={otherSheets} read={samplesSummary !== null ? "samples" : undefined} />
      {samples !== null && samples.canApply && samplesSummary !== null && (
        <form method="post" action={`${uploadHref(upload.entity_id)}/apply-samples`}>
          <input type="hidden" name="digest" value={samples.digest} />
          {samplesSummary.held.length > 0 && (
            <>
              <h2>{p.heldHeading}</h2>
              <p>{p.heldRule}</p>
              <DataTable columns={[p.heldColumns.row, p.heldColumns.number, p.heldColumns.like, p.heldColumns.anyway]}>
                {samplesSummary.held.map((h) => (
                  <tr>
                    <td>{m.format.number(h.row)}</td>
                    <td>{h.sampleNumber}</td>
                    <td>
                      <a href={`/samples/${h.likeId}`}>{h.likeNumber}</a>
                    </td>
                    <td>
                      <input type="checkbox" name="anyway" value={String(h.row)} aria-label={p.heldAnyway(h.row)} />
                    </td>
                  </tr>
                ))}
              </DataTable>
            </>
          )}
          <p class="row">
            <Button>{p.samplesApply}</Button>
          </p>
          <Meta block>{p.samplesApplyNote}</Meta>
        </form>
      )}
      <div class="row">
        {volunteer !== null && volunteer.canSave && (
          <form method="post" action={`${uploadHref(upload.entity_id)}/apply`}>
            <input type="hidden" name="digest" value={volunteer.digest} />
            <Button>{p.save(volunteer.summary.ready)}</Button>
          </form>
        )}
        {notes && (
          <LinkButton href={notesHref(upload.entity_id)} variant="tonal">
            {volunteer !== null ? p.download : p.downloadStaff}
          </LinkButton>
        )}
      </div>
      {(staffSummary !== null || samplesSummary !== null) && notes && <Meta block>{p.staffNotes}</Meta>}
      {notes && notesCopy && <Meta block>{p.notesCopy}</Meta>}
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
