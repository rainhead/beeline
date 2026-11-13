import type { Messages } from "../messages/index.js";
import type { ProgramArchive } from "../dwc-archive.js";
import { sharedLicense, type AllYearsEntry, type ArchiveEntry, type ArchiveManifest, type ChecklistEntry } from "../program-archives.js";
import { governanceFor, LICENSES, type LicenseId, type ProgramGovernance } from "../../program-governance.js";
import { Absent, Callout, DataTable, EmptyState, LinkButton, Meta, PageHeader } from "./components/index.js";

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
}: {
  m: Messages;
  occurrences: ExportFile | null;
  programs: ProgramArchive[];
  archives: ArchiveManifest | null;
  governance: ProgramGovernance;
}) {
  const e = m.exports;
  return (
    <>
      <PageHeader title={e.heading} lede={e.intro} />
      <p>
        <a href="/exports/held-back">{m.heldBack.linkFromExports}</a>
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
    </>
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
