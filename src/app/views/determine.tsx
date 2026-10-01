import type { Messages } from "../messages/index.js";
import type { EntryRow, EntrySeason } from "../determine.js";
import { Callout, EmptyState } from "./components/feedback.js";
import { PageHeader } from "./components/text.js";
import { Term } from "./components/term.js";

/**
 * Identify your specimens (beeline-bcq). The page is a shell around one
 * island, `determine-grid`: the grid is the whole interaction — ticking,
 * filling a column, saving as you go — and is no use without script. The
 * shell owns what a URL should hold: which season, and whether you are
 * working by sample or through your batch.
 */

export type DetermineView = "sample" | "batch";

export interface DeterminePageData {
  view: DetermineView;
  season: number | null;
  rows: EntryRow[];
  /** Every name the rows already use, so they render before the picker's list arrives. */
  taxa: Record<number, { name: string; rank: string; castes: boolean }>;
  readOnly: boolean;
  batchCount: number;
}

export const determineHref = (view: DetermineView, season: number | null): string =>
  view === "batch" ? "/determinations?view=batch" : season === null ? "/determinations" : `/determinations?season=${season}`;

export function DeterminePage({ m, seasons, data }: { m: Messages; seasons: EntrySeason[]; data: DeterminePageData }) {
  const d = m.determine;
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return (
    <>
      <PageHeader
        title={d.title}
        lede={
          <>
            {d.lede}{" "}
            <Term m={m} slug="determination">
              {d.aboutDetermination}
            </Term>
          </>
        }
      />
      {data.readOnly ? (
        <Callout tone="warning">{d.readOnly}</Callout>
      ) : (
        <p class="meta">
          {d.tonight} {d.experts}
        </p>
      )}
      {seasons.length === 0 ? (
        <EmptyState>{d.empty}</EmptyState>
      ) : (
        <>
          <div class="determine-views">
            <nav class="segmented" aria-label={d.mode.label}>
              <a href={determineHref("sample", data.season)} aria-current={data.view === "sample" ? "page" : undefined}>
                {d.mode.bySample}
              </a>
              <a href={determineHref("batch", data.season)} aria-current={data.view === "batch" ? "page" : undefined}>
                {d.mode.batch(data.batchCount)}
              </a>
            </nav>
            {data.view === "sample" && (
              <nav class="segmented" aria-label={d.season}>
                {seasons.map((s) => (
                  <a href={determineHref("sample", s.season)} aria-current={s.season === data.season ? "page" : undefined}>
                    {d.seasonOption(s.season, s.unnamed)}
                  </a>
                ))}
              </nav>
            )}
          </div>
          {data.view === "batch" && <p>{d.batch.lede}</p>}
          <script type="application/json" id="determine-data" dangerouslySetInnerHTML={{ __html: json }} />
          <determine-grid />
        </>
      )}
    </>
  );
}
