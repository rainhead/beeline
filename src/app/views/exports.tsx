import type { Messages } from "../messages/index.js";
import type { ProgramArchive } from "../dwc-archive.js";
import { stillAllowed, type ArchiveEntry, type ArchiveManifest } from "../program-archives.js";
import { governanceFor, LICENSES, type ProgramGovernance } from "../../program-governance.js";
import { Absent, Callout, DataTable, EmptyState, LinkButton, Meta, PageHeader } from "./components/index.js";

/** The current export file, as the page describes it; null when none has been written. */
export interface ExportFile {
  writtenAt: Date;
  bytes: number;
}

/**
 * Files for work outside Beeline. The legacy system's occurrences format
 * (beeline-6q8), which reporting built on that file reads unchanged, and a
 * Darwin Core archive per program and season (beeline-rvun), written nightly
 * for each one whose program has a licence and a privacy policy in force.
 * Admin-gated like /jobs, since both carry names and true coordinates.
 *
 * The licence and policy columns read the decisions as they stand now, not as
 * the night's run found them, so a decision merged today shows at once; the
 * download follows them too, and a season whose decisions arrived today says
 * it is written tonight.
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
  governance,
}: {
  m: Messages;
  program: ProgramArchive;
  entries: ArchiveEntry[];
  governance: ProgramGovernance;
}) {
  const e = m.exports;
  if (program.scope === null || entries.length === 0) {
    return (
      <section>
        <h3>{program.name}</h3>
        <p>
          <Meta>{program.scope === null ? e.archiveNone : e.noSpecimens}</Meta>
        </p>
      </section>
    );
  }
  return (
    <section>
      <h3>{program.name}</h3>
      <DataTable columns={[e.colSeason, e.colSpecimens, e.colLicense, e.colPolicy, e.colArchive]}>
        {[...entries]
          .sort((a, b) => b.season - a.season)
          .map((entry) => {
            const { license, policy } = governanceFor(governance, entry.program, entry.season);
            return (
              <tr>
                <td>{e.season(entry.season)}</td>
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
                  {stillAllowed(governance, entry) ? (
                    <a href={`/exports/dwca/${entry.file}`} aria-label={e.archiveDownload(program.name, entry.season)}>
                      {e.downloadSized(fileSize(entry.bytes ?? 0))}
                    </a>
                  ) : license !== null && policy !== null ? (
                    <Meta>{e.archiveTonight}</Meta>
                  ) : (
                    <Absent label={e.archiveWithheld} spelled />
                  )}
                </td>
              </tr>
            );
          })}
      </DataTable>
    </section>
  );
}
