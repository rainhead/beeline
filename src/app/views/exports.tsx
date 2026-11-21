import type { Messages } from "../messages/index.js";
import type { ProgramArchive } from "../dwc-archive.js";
import { describeScope, type EcdysisCollection } from "../../fetch-ecdysis.js";
import { archiveHref, associationsHref, beingWritten, idsOf, INCLUDE_NONE, UPLOAD_CONSTANTS, type DownloadView, type UploadState, type UploadYear } from "../ecdysis-upload.js";
import { EMPTY_QUERY, listingHref } from "../listings.js";
import { sharedLicense, type AllYearsEntry, type ArchiveEntry, type ArchiveManifest, type ChecklistEntry } from "../program-archives.js";
import { governanceFor, LICENSES, type LicenseId, type ProgramGovernance } from "../../program-governance.js";
import { Absent, Button, Callout, DataTable, EmptyState, LinkButton, Meta, PageHeader } from "./components/index.js";

/** One Ecdysis collection's upload files, or why there are none. */
export interface EcdysisUploadSection {
  collection: EcdysisCollection;
  /** The collection's program, by name. */
  programName: string;
  state: UploadState;
  /** The finished downloads to list, whatever the state of the read (`downloadViewsOf`). */
  downloads: DownloadView[];
}

/** The current export file, as the page describes it; null when none has been written. */
export interface ExportFile {
  writtenAt: Date;
  bytes: number;
}

/**
 * Files for work outside Beeline. The legacy system's occurrences format
 * (beeline-6q8), which reporting built on that file reads unchanged, and a
 * Darwin Core archive per program and calendar year (beeline-rvun), with one
 * of every year together beside each program's years (beeline-9bnm), every one
 * written nightly so staff can review it (Peter, 2026-10-23). Admin-gated like
 * /jobs, since both carry names and true coordinates.
 *
 * The licence and policy columns are what publishing a year would need, and
 * read the decisions as they stand now rather than as the night's run found
 * them, so a decision merged today shows at once. The file beside them states
 * the licence of the night it was written, so where the two differ the row
 * says which licence the file carries until it is rewritten.
 */
export function Exports({
  m,
  occurrences,
  programs,
  archives,
  governance,
  ecdysis,
}: {
  m: Messages;
  occurrences: ExportFile | null;
  programs: ProgramArchive[];
  archives: ArchiveManifest | null;
  governance: ProgramGovernance;
  ecdysis: EcdysisUploadSection[];
}) {
  const e = m.exports;
  return (
    <>
      <PageHeader title={e.heading} lede={e.intro} />
      <p>
        <a href="/exports/changes">{m.legacyChanges.linkFromExports}</a>
        <br />
        <a href="/exports/held-back">{m.heldBack.linkFromExports}</a>
        <br />
        <a href="/uploads">{m.uploads.linkFromExports}</a>
      </p>
      <h2>{e.occurrences}</h2>
      {occurrences === null ? (
        <EmptyState>{e.missing}</EmptyState>
      ) : (
        <p>
          <Meta>
            {e.written(m.format.dateTime(occurrences.writtenAt))} · {e.size((occurrences.bytes / 1e6).toFixed(0))}
          </Meta>{" "}
          <LinkButton href="/exports/occurrences.csv">{e.download}</LinkButton>
        </p>
      )}
      <h2>{e.archives}</h2>
      <p>{e.archivesIntro}</p>
      <Callout tone="warning">{e.archivesCaution}</Callout>
      {archives === null ? (
        <EmptyState>{e.archivesMissing}</EmptyState>
      ) : (
        <>
          <Meta block>{e.written(m.format.dateTime(new Date(archives.writtenAt)))}</Meta>
          {programs.map((p) => (
            <ProgramSeasons
              m={m}
              program={p}
              entries={archives.entries.filter((a) => a.program === p.code)}
              checklist={archives.checklists?.find((c) => c.program === p.code) ?? null}
              allYears={archives.allYears?.find((a) => a.program === p.code) ?? null}
              governance={governance}
            />
          ))}
        </>
      )}
      <EcdysisUploads m={m} sections={ecdysis} />
    </>
  );
}

/**
 * The files a person uploads to Ecdysis (beeline-8dx9.12): the instructions,
 * then for each collection what Beeline will write. Where the last read of
 * Ecdysis is too old or missing, or Beeline reads only a dataset of the
 * collection, the reason and what to do, and no link. Where an archive has
 * been downloaded since the last read, who took it, and no second archive. A
 * year is a block of its own: the specimens in its file, what was left out and
 * why, and the choice about obscured specimens with the two downloads. Years
 * that are not offered are listed with a link to their specimens.
 */
function EcdysisUploads({ m, sections }: { m: Messages; sections: EcdysisUploadSection[] }) {
  const e = m.exports.ecdysis;
  return (
    <>
      <h2>{e.heading}</h2>
      <p>{e.intro}</p>
      <h3>{e.instructionsHeading}</h3>
      <ol>
        <li>
          {e.steps.readNow}
          <form method="post" action="/jobs/run/ecdysis-fetch">
            <Button variant="tonal">{e.readNowButton}</Button>
          </form>
        </li>
        <li>{e.steps.download}</li>
        <li>{e.steps.collection}</li>
        <li>{e.steps.uploadPage}</li>
        <li>{e.steps.report}</li>
        <li>{e.steps.associations}</li>
        <li>{e.steps.readAgain}</li>
        <li>{e.steps.localities}</li>
      </ol>
      <p>
        <Meta>{e.narrowing}</Meta>
      </p>
      {sections.map(({ collection, programName, state, downloads }) => (
        <section>
          <h3>{e.collection(programName, describeScope(collection))}</h3>
          {collection.collectionId !== undefined && <Meta block>{e.uploadInto(collection.collectionId, collection.catalogPrefix)}</Meta>}
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
                  <YearOffer m={m} collection={collection} programName={programName} year={y} archiveOpen={state.blocking === null} />
                ))}
              {state.plan.years.some((y) => !y.offered) && (
                <>
                  <h4>{e.notOfferedHeading}</h4>
                  <ul>
                    {state.plan.years
                      .filter((y) => !y.offered)
                      .map((y) => (
                        <li>
                          {e.notOfferedYear(y.year, y.eligible.length, UPLOAD_CONSTANTS[collection.program]?.years.join(", ") || "no year")}{" "}
                          <a href={listingHref("/specimens", { ...EMPTY_QUERY, scope: collection.program, year: y.year, ecdysis: "not", labels: "printed" })}>{e.seeThem}</a>
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
                    {e.downloadItem(d.by, m.format.dateTime(d.startedAt), d.year, d.specimens ?? d.planned, d.notYetInEcdysis, d.completedAt !== null)}{" "}
                    {e.downloadChoice(d.include.taxonObscured, d.include.observerObscured)}{" "}
                    {d.completedAt !== null && (
                      <a href={associationsHref(d.id)} aria-label={e.associationsDownload(programName, d.year)}>
                        {e.downloadAssociations}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
    </>
  );
}

/** One offered year: what its archive holds, what was left out, and the choice with the download. */
function YearOffer({
  m,
  collection,
  programName,
  year,
  archiveOpen,
}: {
  m: Messages;
  collection: EcdysisCollection;
  programName: string;
  year: UploadYear;
  /** No archive has been started since the last read. */
  archiveOpen: boolean;
}) {
  const e = m.exports.ecdysis;
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
  entries,
  checklist,
  allYears,
  governance,
}: {
  m: Messages;
  program: ProgramArchive;
  entries: ArchiveEntry[];
  /** Null before the first night that wrote checklists. */
  checklist: ChecklistEntry | null;
  /** Null before the first night that wrote archives of every year. */
  allYears: AllYearsEntry | null;
  governance: ProgramGovernance;
}) {
  const e = m.exports;
  if (program.scope === null || entries.length === 0) {
    return (
      <section>
        <h3>{program.name}</h3>
        <p>
          <Meta>{program.scope === null ? e.archiveNone(program.code) : e.noSpecimens}</Meta>
        </p>
      </section>
    );
  }
  return (
    <section>
      <h3>{program.name}</h3>
      {checklist !== null && (
        <p>
          {e.checklist(checklist.taxa)}{" "}
          <a href={`/exports/dwca/${checklist.file}`} aria-label={e.checklistDownload(program.name)}>
            {e.downloadSized(fileSize(checklist.bytes))}
          </a>
        </p>
      )}
      {allYears !== null && <AllYears m={m} entry={allYears} name={program.name} license={sharedLicense(governance, program.code, entries.map((a) => a.year))} />}
      <DataTable columns={[e.colYear, e.colSpecimens, e.colLicense, e.colPolicy, e.colArchive]}>
        {[...entries]
          .sort((a, b) => b.year - a.year)
          .map((entry) => {
            const { license, policy } = governanceFor(governance, entry.program, entry.year);
            return (
              <tr>
                <td>{entry.year}</td>
                <td>{m.format.number(entry.specimens)}</td>
                <td>
                  {license === null ? (
                    <Absent label={e.noLicense} spelled />
                  ) : (
                    <a href={LICENSES[license.license].url}>{LICENSES[license.license].name}</a>
                  )}
                </td>
                <td>
                  {policy === null ? (
                    <Absent label={e.noPolicy} spelled />
                  ) : policy.url === "" ? (
                    e.policyNoPage
                  ) : (
                    <a href={policy.url}>{e.policyLink}</a>
                  )}
                </td>
                <td>
                  <a href={`/exports/dwca/${entry.file}`} aria-label={e.archiveDownload(program.name, entry.year)}>
                    {e.downloadSized(fileSize(entry.bytes))}
                  </a>
                  {/* The column reads the decisions as they stand; the file states the licence of the night it was written. */}
                  {entry.license !== (license?.license ?? null) && (
                    <Meta block>
                      {entry.license === null ? e.archiveLicenseNone : e.archiveLicenseWas(LICENSES[entry.license].name)}
                    </Meta>
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
function AllYears({ m, entry, name, license }: { m: Messages; entry: AllYearsEntry; name: string; license: LicenseId | null }) {
  const e = m.exports;
  return (
    <p>
      {e.allYears(entry.specimens, entry.firstYear, entry.lastYear)}{" "}
      {license === null ? e.allYearsNoLicense : e.allYearsLicense(LICENSES[license].name)}{" "}
      <a href={`/exports/dwca/${entry.file}`} aria-label={e.allYearsDownload(name)}>
        {e.downloadSized(fileSize(entry.bytes))}
      </a>
      {entry.license !== license && (
        <Meta block>
          {entry.license === null
            ? e.archiveLicenseNone
            : license === null
              ? e.allYearsLicenseDropped(LICENSES[entry.license].name)
              : e.archiveLicenseWas(LICENSES[entry.license].name)}
        </Meta>
      )}
    </p>
  );
}
