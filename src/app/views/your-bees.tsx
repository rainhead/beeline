import type { Messages } from "../messages/index.js";
import type { Batch, BatchKind, Batches, YearOfBees } from "../your-bees.js";
import { DataTable, EmptyState, Meta, PageHeader, TaxonName } from "./components/index.js";

/**
 * "Your bees" (beeline-fiay, beeline-xegx): a volunteer's own bees, by the
 * year they were collected and by when experts identified them. The start of
 * the student report's replacement: about the volunteer's own bees, and always
 * current, where the old report was a 29-page PDF a season, mostly about the
 * whole atlas (docs/research/melittoflora.md).
 */
export function YourBeesPage({ m, years, batches }: { m: Messages; years: YearOfBees[]; batches: Batches }) {
  const t = m.yourBees;
  return (
    <>
      <PageHeader title={t.heading} lede={t.lede} />
      <h2>{t.byYear.heading}</h2>
      <Meta block>{t.byYear.intro}</Meta>
      {years.length === 0 ? <EmptyState>{t.byYear.empty}</EmptyState> : <YearChart m={m} years={years} />}
      <h2>{t.batches.heading}</h2>
      <Meta block>
        {t.batches.intro}
        {batches.undated > 0 && <> {t.batches.undated(batches.undated)}</>}
      </Meta>
      {batches.batches.length === 0 ? <EmptyState>{t.batches.empty}</EmptyState> : <BatchList m={m} batches={batches.batches} />}
    </>
  );
}

/** The four parts of a year's bar, finest first, as the legend and the table list them. */
const PARTS = ["species", "genus", "coarser", "none"] as const;

/**
 * One stacked bar per collection year: how many bees, and how far each is
 * identified. Drawn on the server as SVG, so it needs no script and prints;
 * the same numbers are in the table below it, and each bar carries them as
 * its title for a pointer that rests on it. One blue ordinal ramp, finest
 * darkest, with grey for none (components.css), validated light and dark.
 */
export function YearChart({ m, years }: { m: Messages; years: YearOfBees[] }) {
  const t = m.yourBees.byYear;
  const W = 640;
  const H = 240;
  const left = 48;
  const bottom = 24;
  const top = 8;
  const max = Math.max(1, ...years.map((y) => y.collected));
  const step = niceStep(max);
  const ceiling = Math.ceil(max / step) * step;
  const slot = (W - left) / years.length;
  const barW = Math.min(40, slot * 0.6);
  const y = (v: number) => top + (H - top - bottom) * (1 - v / ceiling);
  const ticks: number[] = [];
  for (let v = 0; v <= ceiling; v += step) ticks.push(v);
  return (
    <figure class="bee-chart">
      <ul class="bee-chart-legend">
        {PARTS.map((p) => (
          <li class={`part-${p}`}>{t.legend[p]}</li>
        ))}
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t.chartLabel}>
        <g class="grid">
          {ticks.map((v) => (
            <line x1={left} x2={W} y1={y(v)} y2={y(v)} />
          ))}
        </g>
        <g class="axis">
          {ticks.map((v) => (
            <text x={left - 8} y={y(v) + 4} text-anchor="end">
              {m.format.number(v)}
            </text>
          ))}
          {years.map((yr, i) => (
            <text x={left + slot * i + slot / 2} y={H - 6} text-anchor="middle">
              {String(yr.season)}
            </text>
          ))}
        </g>
        {years.map((yr, i) => {
          const x = left + slot * i + slot / 2 - barW / 2;
          const shown = PARTS.filter((p) => yr[p] > 0);
          let below = 0;
          return (
            <g>
              <title>{t.title(yr.season, yr.collected, yr.species, yr.genus, yr.coarser, yr.none)}</title>
              {shown.map((p, j) => {
                const y1 = y(below + yr[p]);
                const y2 = y(below);
                below += yr[p];
                const last = j === shown.length - 1;
                // A 2px gap of surface between parts, and a rounded end only
                // on the top of the bar, away from the baseline.
                const h = Math.max(0.5, y2 - y1 - (last ? 0 : 2));
                return last ? <path class={`part-${p}`} d={roundTop(x, y1, barW, h, 4)} /> : <rect class={`part-${p}`} x={x} y={y1 + 2} width={barW} height={h} />;
              })}
            </g>
          );
        })}
      </svg>
      <details>
        <summary>{t.asTable}</summary>
        <DataTable columns={[t.col.season, t.col.collected, t.legend.species, t.legend.genus, t.legend.coarser, t.legend.none]}>
          {years.map((yr) => (
            <tr>
              <td>{String(yr.season)}</td>
              <td>{m.format.number(yr.collected)}</td>
              {PARTS.map((p) => (
                <td>{m.format.number(yr[p])}</td>
              ))}
            </tr>
          ))}
        </DataTable>
      </details>
    </figure>
  );
}

/** A round number of steps that fits about four gridlines under the tallest bar. */
export function niceStep(max: number): number {
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  return [1, 2, 2.5, 5, 10].map((k) => k * magnitude).find((s) => s >= raw) ?? magnitude * 10;
}

function roundTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

/**
 * The experts' identifications, a day at a time, newest first: how many of
 * each year's bees, then what kind of identification each was, who made
 * them, and the names, which open. Shared by the front page, which shows
 * the newest few, and /bees, which shows them all.
 */
export function BatchList({ m, batches }: { m: Messages; batches: Batch[] }) {
  const t = m.yourBees.batches;
  return (
    <ul class="batches">
      {batches.map((b) => (
        <li>
          <div class="batch-when">{b.on_or_before ? t.onOrBefore(m.format.day(b.identified_at)) : m.format.day(b.identified_at)}</div>
          <div>{t.identified(b.seasons.map((s) => t.ofSeason(s.count, s.season)))}</div>
          <Meta block>{t.kinds(b.kinds.map((k) => kindText(m, k)))}</Meta>
          {b.determiners.length > 0 && <Meta block>{t.by(b.determiners)}</Meta>}
          <details>
            <summary>{t.names(b.names.length)}</summary>
            <ul class="batch-names">
              {b.names.map((n) => (
                <li>
                  {n.previous !== null && (
                    <>
                      <TaxonName rank={n.previous.rank} scientificName={n.previous.scientific_name} qualifier={n.previous.qualifier ?? undefined} />
                      {" → "}
                    </>
                  )}
                  <TaxonName rank={n.rank} scientificName={n.scientific_name} qualifier={n.qualifier ?? undefined} />
                  {n.count > 1 && <> {t.times(n.count)}</>}
                </li>
              ))}
            </ul>
          </details>
        </li>
      ))}
    </ul>
  );
}

function kindText(m: Messages, k: BatchKind): string {
  const t = m.yourBees.batches.kind;
  const text =
    k.kind === "finer"
      ? t.finer(k.count, k.from ?? "", k.to ?? "")
      : k.kind === "coarser"
        ? t.coarser(k.count, k.from ?? "", k.to ?? "")
        : t[k.kind](k.count);
  return k.own > 0 ? `${text} ${t.own(k.own, k.count)}` : text;
}
