import type { Messages } from "../messages/index.js";
import { EmptyState, LinkButton, Meta, PageHeader } from "./components/index.js";

/** The current export file, as the page describes it; null when none has been written. */
export interface ExportFile {
  writtenAt: Date;
  bytes: number;
}

/**
 * Files for work outside Beeline (beeline-6q8). One so far: every specimen
 * in the legacy system's occurrences format, which reporting built on that
 * file reads unchanged. Admin-gated like /jobs, since it carries names and
 * true coordinates.
 */
export function Exports({ m, occurrences }: { m: Messages; occurrences: ExportFile | null }) {
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
    </>
  );
}
