import type { Messages } from "../messages/index.js";
import { OUTSIDE, type AtlasOption } from "../listings.js";
import { Callout, EmptyState, LinkButton, Meta, PageHeader } from "./components/index.js";

/** The current export file, as the page describes it; null when none has been written. */
export interface ExportFile {
  writtenAt: Date;
  bytes: number;
}

/**
 * Files for work outside Beeline. The legacy system's occurrences format
 * (beeline-6q8), which reporting built on that file reads unchanged, and a
 * Darwin Core archive per program (beeline-rvun), for operations and for
 * validating against GBIF's and Symbiota's readers until each program decides
 * what it publishes. Admin-gated like /jobs, since both carry names and true
 * coordinates.
 */
export function Exports({
  m,
  occurrences,
  atlases,
}: {
  m: Messages;
  occurrences: ExportFile | null;
  atlases: AtlasOption[];
}) {
  const programs = [
    ...atlases.map((a) => ({ scope: a.code, name: a.name })),
    { scope: OUTSIDE, name: m.exports.archiveOutside },
  ];
  return (
    <>
      <PageHeader title={m.exports.heading} lede={m.exports.intro} />
      <h2>{m.exports.occurrences}</h2>
      {occurrences === null ? (
        <EmptyState>{m.exports.missing}</EmptyState>
      ) : (
        <p>
          <Meta>
            {m.exports.written(m.format.dateTime(occurrences.writtenAt))} · {m.exports.size((occurrences.bytes / 1e6).toFixed(0))}
          </Meta>{" "}
          <LinkButton href="/exports/occurrences.csv">{m.exports.download}</LinkButton>
        </p>
      )}
      <h2>{m.exports.archives}</h2>
      <p>{m.exports.archivesIntro}</p>
      <Callout tone="warning">{m.exports.archivesCaution}</Callout>
      <ul>
        {programs.map((p) => (
          <li>
            <a href={`/exports/dwca/${p.scope}.zip`} aria-label={m.exports.archiveDownload(p.name)}>
              {p.name}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
