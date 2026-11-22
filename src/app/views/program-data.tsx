import type { Child } from "hono/jsx";
import type { Messages } from "../messages/index.js";
import { describeScope, type EcdysisCollection } from "../../fetch-ecdysis.js";
import {
  archiveHref,
  associationsHref,
  beingWritten,
  checkHref,
  idsOf,
  INCLUDE_NONE,
  UPLOAD_CONSTANTS,
  type DownloadView,
  type EcdysisCheck,
  type UploadState,
  type UploadYear,
} from "../ecdysis-upload.js";
import { EMPTY_QUERY, listingHref } from "../listings.js";
import { programDataHref, type ProgramDataAccess } from "../programs.js";
import { sharedLicense, type AllYearsEntry, type ArchiveEntry, type ArchiveManifest, type ChecklistEntry } from "../program-archives.js";
import { governanceFor, LICENSES, type LicenseId, type ProgramGovernance } from "../../program-governance.js";
import { Absent, Button, Callout, DataTable, EmptyState, Meta, PageHeader } from "./components/index.js";

/** The program's collection in Ecdysis, and what can be made for it, or why nothing can. */
export interface EcdysisUploadSection {
  collection: EcdysisCollection;
  state: UploadState;
  /** The finished downloads to list, whatever the state of the read (`downloadViewsOf`). */
  downloads: DownloadView[];
  /** Whether Ecdysis is being checked, or how the last check ended; null before any. */
  check: EcdysisCheck;
  /** Set when pressing the button started nothing because another job was running. */
  busy: boolean;
  /** Set when pressing the button started nothing because Ecdysis was checked a few minutes ago. */
  recent: boolean;
}

/** What the page knows about the program's nightly archives. */
export interface ProgramArchives {
  /** The program's ground: null where it has none, which has no archive. */
  scope: string | null;
  /** Null before the first night that wrote archives. */
  manifest: ArchiveManifest | null;
}

/**
 * A program's Data tab (beeline-q8di): the files that leave Beeline for it.
 * For the program's leads and for admins, since the files hold collectors'
 * names and true coordinates (`programDataAccess` states who and why). In
 * order: the licence and privacy policy the program has settled; the upload
 * to Ecdysis, where the program has a collection there, which is what a
 * person acts on; then the nightly Darwin Core archives, which are for
 * reference.
 *
 * The licence and policy read the decisions as they stand now, not as the
 * night's run found them, so a decision merged today shows at once. The file
 * beside them states the licence of the night it was written, so where the
 * two differ the row says which licence the file carries until it is
 * rewritten.
 */
export function ProgramData({
  m,
  program,
  tabs,
  archives,
  governance,
  ecdysis,
}: {
  m: Messages;
  program: ProgramDataAccess;
  /** The program page's tab bar, drawn above the heading's content. */
  tabs: Child;
  archives: ProgramArchives;
  governance: ProgramGovernance;
  ecdysis: EcdysisUploadSection | null;
}) {
  const d = m.programData;
  const entries = archives.manifest?.entries.filter((a) => a.program === program.code) ?? [];
  return (
    <>
      <PageHeader title={d.title(program.name)} lede={d.intro} />
      {tabs}
      <Licences m={m} code={program.code} entries={entries} governance={governance} />
      {ecdysis !== null && <EcdysisUploads m={m} section={ecdysis} />}
      <h2>{d.archives}</h2>
      <p>{d.archivesIntro}</p>
      <Callout tone="warning">{d.archivesCaution(ecdysis !== null)}</Callout>
      {archives.manifest === null ? (
        <EmptyState>{d.archivesMissing}</EmptyState>
      ) : (
        <>
          <Meta block>{d.written(m.format.dateTime(new Date(archives.manifest.writtenAt)))}</Meta>
          <ProgramSeasons
            m={m}
            program={program}
            scope={archives.scope}
            entries={entries}
            checklist={archives.manifest.checklists?.find((c) => c.program === program.code) ?? null}
            allYears={archives.manifest.allYears?.find((a) => a.program === program.code) ?? null}
            governance={governance}
          />
        </>
      )}
    </>
  );
}

/** A refusal shown at the address of a request that was refused: the sentence, and the way back to the tab. */
export function ProgramDataRefusal({ m, code, text }: { m: Messages; code: string; text: string }) {
  return (
    <>
      <PageHeader title={m.programData.refusedHeading} />
      <Callout tone="warning">{text}</Callout>
      <p>
        <a href={programDataHref(code)}>{m.programData.backToTab}</a>
      </p>
    </>
  );
}

/** Where a program's archive file is downloaded from. */
const dwcaHref = (code: string, file: string) => `${programDataHref(code)}/dwca/${file}`;

/** The licence and privacy policy of each year that has an archive, as the program has settled them so far. */
function Licences({ m, code, entries, governance }: { m: Messages; code: string; entries: ArchiveEntry[]; governance: ProgramGovernance }) {
  const d = m.programData;
  return (
    <>
      <h2>{d.licencesHeading}</h2>
      {entries.length === 0 ? (
        <EmptyState>{d.licencesNone}</EmptyState>
      ) : (
        <DataTable columns={[d.colYear, d.colLicense, d.colPolicy]}>
          {[...entries]
            .sort((a, b) => b.year - a.year)
            .map((entry) => {
              const { license, policy } = governanceFor(governance, code, entry.year);
              return (
                <tr>
                  <td>{entry.year}</td>
                  <td>
                    {license === null ? <Absent label={d.noLicense} spelled /> : <a href={LICENSES[license.license].url}>{LICENSES[license.license].name}</a>}
                  </td>
                  <td>
                    {policy === null ? (
                      <Absent label={d.noPolicy} spelled />
                    ) : policy.url === "" ? (
                      d.policyNoPage
                    ) : (
                      <a href={policy.url}>{d.policyLink}</a>
                    )}
                  </td>
                </tr>
              );
            })}
        </DataTable>
      )}
    </>
  );
}

/** Whether Ecdysis is being checked, or how the last check ended; with the one thing to do about a refusal to start. */
function CheckState({ m, check, busy, recent }: { m: Messages; check: EcdysisCheck; busy: boolean; recent: boolean }) {
  const c = m.programData.ecdysis.check;
  if (recent && check?.state === "finished") return <Callout tone="warning">{c.recent(m.format.dateTime(check.at))}</Callout>;
  if (busy) return <Callout tone="warning">{c.busy}</Callout>;
  if (check === null) return null;
  if (check.state === "running") return <Meta block>{c.running}</Meta>;
  if (check.state === "failed") return <Callout tone="warning">{c.failed(m.format.dateTime(check.at))}</Callout>;
  return <Meta block>{c.finished(m.format.dateTime(check.at))}</Meta>;
}

/**
 * Uploading to Ecdysis (beeline-8dx9.12): the steps, with the button for the
 * first and the note after the last, then what can be made for the program's
 * collection. Where the last check of Ecdysis is too old or missing, or Beeline
 * sees only a dataset of the collection, the reason and what to do, and no
 * button. A year is a block of its own: the specimens ready, what is not
 * included and why, and the choice about hidden locations with the button for
 * the file. Files already made are listed under "Files made", each with its
 * associations file. Years that cannot be uploaded from here are listed with
 * their count as the link to those specimens.
 */
function EcdysisUploads({ m, section }: { m: Messages; section: EcdysisUploadSection }) {
  const e = m.programData.ecdysis;
  const { collection, state, downloads, check, busy, recent } = section;
  return (
    <>
      <h2>{e.heading}</h2>
      <p>{e.intro}</p>
      <h3>{e.instructionsHeading}</h3>
      <ol>
        <li>
          {e.steps.readNow}
          <form method="post" action={checkHref(collection)}>
            <Button variant="tonal">{e.readNowButton}</Button>
          </form>
          <CheckState m={m} check={check} busy={busy} recent={recent} />
        </li>
        <li>{e.steps.download}</li>
        <li>{e.steps.collection}</li>
        <li>{e.steps.uploadPage}</li>
        <li>{e.steps.report}</li>
        <li>{e.steps.associations}</li>
        <li>{e.steps.readAgain}</li>
      </ol>
      <p>
        <Meta>{e.steps.localities}</Meta>
      </p>
      <section>
        <h3>{e.collection(describeScope(collection))}</h3>
        <Meta block>{e.uploadInto(collection.catalogPrefix)}</Meta>
        {!state.ok ? (
          <Callout tone="warning">
            {state.reason === "stale"
              ? e.refused.stale(m.format.dateTime(state.readAt))
              : state.reason === "dataset"
                ? e.refused.dataset(describeScope(collection))
                : e.refused[state.reason]}
          </Callout>
        ) : (
          <>
            <Meta block>{e.readOn(m.format.dateTime(state.plan.readAt))}</Meta>
            {state.blocking !== null && (
              <Callout tone="warning">
                {beingWritten(state.blocking)
                  ? e.beingWritten
                  : e.downloaded(
                      state.blocking.by,
                      m.format.dateTime(state.blocking.startedAt),
                      state.blocking.year,
                      state.blocking.specimens ?? state.blocking.planned,
                      state.blocking.completedAt !== null,
                    )}
              </Callout>
            )}
            {state.plan.years.length === 0 && <EmptyState>{e.nothing}</EmptyState>}
            {state.plan.years
              .filter((y) => y.offered)
              .map((y) => (
                <YearOffer m={m} collection={collection} year={y} archiveOpen={state.blocking === null} />
              ))}
            {state.plan.years.some((y) => !y.offered) && (
              <>
                <h4>{e.notOfferedHeading}</h4>
                <ul>
                  {state.plan.years
                    .filter((y) => !y.offered)
                    .map((y) => (
                      <li>
                        {e.notOfferedYear.year(y.year)}
                        <a href={listingHref("/specimens", { ...EMPTY_QUERY, scope: collection.program, year: y.year, ecdysis: "not", labels: "printed" })}>
                          {e.notOfferedYear.count(y.eligible.length)}
                        </a>
                        {e.notOfferedYear.rest(y.eligible.length, m.format.list((UPLOAD_CONSTANTS[collection.program]?.years ?? []).map(String)))}
                      </li>
                    ))}
                </ul>
              </>
            )}
            {state.plan.unspelled.length > 0 && <Meta block>{e.unspelled(state.plan.unspelled.join(", "))}</Meta>}
          </>
        )}
        {downloads.length > 0 && (
          <>
            <h4>{e.downloadsHeading}</h4>
            <Meta block>{e.downloadsNote}</Meta>
            <ul>
              {downloads.map((d) => (
                <li>
                  {e.downloadItem(
                    d.by,
                    m.format.dateTime(d.startedAt),
                    d.year,
                    d.specimens ?? d.planned,
                    d.notKnown,
                    d.established,
                    d.completedAt !== null ? "prepared" : beingWritten(d) ? "preparing" : "unfinished",
                  )}{" "}
                  {e.downloadChoice(d.include.taxonObscured, d.include.observerObscured)}{" "}
                  {d.completedAt !== null && (
                    <a href={associationsHref(collection, d.id)} aria-label={e.associationsDownload(d.year)}>
                      {e.downloadAssociations}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}

/** One offered year: what its archive holds, what was left out, and the choice with the download. */
function YearOffer({
  m,
  collection,
  year,
  archiveOpen,
}: {
  m: Messages;
  collection: EcdysisCollection;
  year: UploadYear;
  /** No archive has been started since the last read. */
  archiveOpen: boolean;
}) {
  const e = m.programData.ecdysis;
  const none = idsOf(year, INCLUDE_NONE).length;
  const left = [
    year.taxonObscured > 0 && e.leftOutTaxon(year.taxonObscured),
    year.observerObscured > 0 && e.leftOutObserver(year.observerObscured),
    year.labelNotDigits > 0 && e.leftOutNotDigits(year.labelNotDigits),
    year.dispositionHeld > 0 && e.leftOutDisposition(year.dispositionHeld),
    year.unusable > 0 && e.leftOutUnusable(year.unusable),
    year.geoprivacyStale > 0 && e.leftOutStale(year.geoprivacyStale),
  ].filter((line): line is string => line !== false);
  return (
    <section>
      <h4>{e.yearHeading(year.year, none)}</h4>
      {left.length > 0 && (
        <>
          <Meta block>{e.leftOut}</Meta>
          <ul>
            {left.map((line) => (
              <li>{line}</li>
            ))}
          </ul>
        </>
      )}
      {archiveOpen && year.eligible.length > 0 && (
        <form method="post" action={archiveHref(collection, year.year)}>
          {(year.taxonObscured > 0 || year.observerObscured > 0) && (
            <fieldset>
              <legend>{e.choiceLegend}</legend>
              {year.taxonObscured > 0 && (
                <label>
                  <input type="checkbox" name="includeTaxonObscured" value="1" /> {e.includeTaxon}
                </label>
              )}
              {year.observerObscured > 0 && (
                <label>
                  <input type="checkbox" name="includeObserverObscured" value="1" /> {e.includeObserver}
                </label>
              )}
              <Meta block>{e.choiceWarning}</Meta>
              {none === 0 && <Meta block>{e.choiceNeeded}</Meta>}
            </fieldset>
          )}
          <p>
            <Button>{e.downloadArchive}</Button>
          </p>
        </form>
      )}
    </section>
  );
}

/** A file's size the way a person reads it: kilobytes until it is a megabyte. */
const fileSize = (bytes: number) =>
  bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

function ProgramSeasons({
  m,
  program,
  scope,
  entries,
  checklist,
  allYears,
  governance,
}: {
  m: Messages;
  program: ProgramDataAccess;
  scope: string | null;
  entries: ArchiveEntry[];
  /** Null before the first night that wrote checklists. */
  checklist: ChecklistEntry | null;
  /** Null before the first night that wrote archives of every year. */
  allYears: AllYearsEntry | null;
  governance: ProgramGovernance;
}) {
  const d = m.programData;
  if (scope === null || entries.length === 0) {
    return (
      <p>
        <Meta>{scope === null ? d.archiveNone(program.code) : d.noSpecimens}</Meta>
      </p>
    );
  }
  return (
    <section>
      {checklist !== null && (
        <p>
          {d.checklist(checklist.taxa)}{" "}
          <a href={dwcaHref(program.code, checklist.file)} aria-label={d.checklistDownload(program.name)}>
            {d.downloadSized(fileSize(checklist.bytes))}
          </a>
        </p>
      )}
      {allYears !== null && (
        <AllYears m={m} code={program.code} entry={allYears} name={program.name} license={sharedLicense(governance, program.code, entries.map((a) => a.year))} />
      )}
      <DataTable columns={[d.colYear, d.colSpecimens, d.colArchive]}>
        {[...entries]
          .sort((a, b) => b.year - a.year)
          .map((entry) => {
            const { license } = governanceFor(governance, entry.program, entry.year);
            return (
              <tr>
                <td>{entry.year}</td>
                <td>{m.format.number(entry.specimens)}</td>
                <td>
                  <a href={dwcaHref(program.code, entry.file)} aria-label={d.archiveDownload(program.name, entry.year)}>
                    {d.downloadSized(fileSize(entry.bytes))}
                  </a>
                  {/* The licence column reads the decisions as they stand; the file states the licence of the night it was written. */}
                  {entry.license !== (license?.license ?? null) && (
                    <Meta block>{entry.license === null ? d.archiveLicenseNone : d.archiveLicenseWas(LICENSES[entry.license].name)}</Meta>
                  )}
                </td>
              </tr>
            );
          })}
      </DataTable>
    </section>
  );
}

/**
 * A program's archive of every year (beeline-9bnm), above its years. The
 * licence is read from the decisions as they stand, as the years' column is,
 * and the file's own is said where the two differ.
 */
function AllYears({ m, code, entry, name, license }: { m: Messages; code: string; entry: AllYearsEntry; name: string; license: LicenseId | null }) {
  const d = m.programData;
  return (
    <p>
      {d.allYears(entry.specimens, entry.firstYear, entry.lastYear)} {license === null ? d.allYearsNoLicense : d.allYearsLicense(LICENSES[license].name)}{" "}
      <a href={dwcaHref(code, entry.file)} aria-label={d.allYearsDownload(name)}>
        {d.downloadSized(fileSize(entry.bytes))}
      </a>
      {entry.license !== license && (
        <Meta block>
          {entry.license === null
            ? d.archiveLicenseNone
            : license === null
              ? d.allYearsLicenseDropped(LICENSES[entry.license].name)
              : d.archiveLicenseWas(LICENSES[entry.license].name)}
        </Meta>
      )}
    </p>
  );
}
