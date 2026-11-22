import type { Messages } from "../messages/index.js";
import type { ProgramArchive } from "../dwc-archive.js";
import { programDataHref } from "../programs.js";
import { EmptyState, LinkButton, Meta, PageHeader } from "./components/index.js";

/** The current export file, as the page describes it; null when none has been written. */
export interface ExportFile {
  writtenAt: Date;
  bytes: number;
}

/**
 * Files for work outside Beeline that span programs: the legacy system's
 * occurrences format (beeline-6q8), which reporting built on that file reads
 * unchanged, and the links to the other cross-program pages. Admin-gated like
 * /jobs, since the file carries names and true coordinates.
 *
 * What belongs to one program, its licence and privacy policy, its nightly
 * Darwin Core archives and its files for Ecdysis, is on that program's Data
 * tab (beeline-q8di), open to its leads as well as to admins; this page lists
 * each program with the link to its tab.
 */
export function Exports({ m, occurrences, programs }: { m: Messages; occurrences: ExportFile | null; programs: ProgramArchive[] }) {
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
      <h2>{e.programsHeading}</h2>
      <p>{e.programsIntro}</p>
      <ul>
        {programs.map((p) => (
          <li>
            <a href={programDataHref(p.code)}>{e.programData(p.name)}</a>
          </li>
        ))}
      </ul>
    </>
  );
}
