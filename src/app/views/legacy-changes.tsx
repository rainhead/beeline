import type { Messages } from "../messages/index.js";
import {
  CATEGORIES,
  LINES,
  OUTCOME_WORDS,
  type ChangeExample,
  type ChangesSummary,
  type LineSummary,
} from "../../legacy-changes.js";
import { RECORD_COLUMN } from "../../legacy-export-rulings.js";
import { Absent, DataTable, EmptyState, LinkButton, Meta, PageHeader } from "./components/index.js";

/**
 * What new Beeline changed in the old Beeline's records, line by line, for
 * Lincoln Best (beeline-eznn, src/legacy-changes.ts). Admin-gated like
 * /exports, which links here: the examples carry collectors' names.
 *
 * Read from the summary the legacy-changes job writes each night, never
 * worked out on request. A contents table first, each line's counts split
 * into the active and settled seasons, then each heading's lines with what
 * was done, the outcome, a few records, and the line's download.
 */
export function LegacyChangesPage({ m, summary }: { m: Messages; summary: ChangesSummary | null }) {
  const c = m.legacyChanges;
  if (summary === null) {
    return (
      <>
        <PageHeader title={c.heading} lede={c.intro} />
        <EmptyState>{c.missing}</EmptyState>
      </>
    );
  }
  const since = summary.activeSince.slice(0, 4);
  const byLine = new Map(summary.lines.map((l) => [l.line, l]));
  const sections = CATEGORIES.map((cat) => ({
    cat,
    lines: LINES.filter((l) => l.category === cat.id && byLine.has(l.id)).map((l) => ({ def: l, sum: byLine.get(l.id)! })),
  })).filter((s) => s.lines.length > 0);
  return (
    <>
      <PageHeader title={c.heading} lede={c.intro} />
      <Meta block>
        {c.written(m.format.dateTime(new Date(summary.writtenAt)), m.format.dateTime(new Date(summary.exportWrittenAt)))}{" "}
        {c.matched(summary.matched.active, summary.matched.settled, since)} {c.duplicated(summary.duplicated)}
      </Meta>
      <h2>{c.contents}</h2>
      <DataTable columns={[c.colLine, c.colActive(since), c.colSettled]}>
        {sections.map((s) => (
          <>
            <tr>
              <th colspan={3} scope="colgroup">
                {s.cat.title}
              </th>
            </tr>
            {s.lines.map(({ def, sum }) => (
              <tr>
                <td>
                  <a href={`#${def.id}`}>{def.title}</a>
                </td>
                <td>{m.format.number(sum.active)}</td>
                <td>{m.format.number(sum.settled)}</td>
              </tr>
            ))}
          </>
        ))}
      </DataTable>
      <Meta block>{c.countsNote}</Meta>
      {sections.map((s) => (
        <section>
          <h2>{s.cat.title}</h2>
          <p>{s.cat.intro}</p>
          {s.lines.map(({ def, sum }) => (
            <Line m={m} id={def.id} title={def.title} did={def.did} sum={sum} since={since} generation={summary.generation} download={def.download} csvLabel={def.csv?.label} />
          ))}
        </section>
      ))}
    </>
  );
}

/** One line. Its download names the night's folder, so it is the night this page shows even after a later night is written. */
function Line({
  m,
  id,
  title,
  did,
  sum,
  since,
  generation,
  download,
  csvLabel,
}: {
  m: Messages;
  id: string;
  title: string;
  did: string;
  sum: LineSummary;
  since: string;
  generation: string;
  /** A download kept elsewhere in place of the line's own, or null for none (ChangeLine.download). */
  download: { href: string; label: string } | null | undefined;
  /** What the line's own download's button says, where it is not a value against a value (ChangeLine.csv). */
  csvLabel: string | undefined;
}) {
  const c = m.legacyChanges;
  return (
    <article id={id}>
      <h3>{title}</h3>
      <p>{did}</p>
      {id === "held_back" && (
        <p>
          <a href="/exports/held-back">{c.heldBackLink}</a>
        </p>
      )}
      <p>
        <Meta>
          {c.colActive(since)}: {m.format.number(sum.active)} · {c.colSettled}: {m.format.number(sum.settled)} · {c.values(sum.values)}
        </Meta>
      </p>
      <p>
        <Meta>
          {c.outcome}:{" "}
          {sum.outcomes.length === 1
            ? (OUTCOME_WORDS[sum.outcomes[0]!.outcome] ?? sum.outcomes[0]!.outcome)
            : sum.outcomes
                .map((o) => `${OUTCOME_WORDS[o.outcome] ?? o.outcome} (${c.bySeason(o.active, o.settled)})`)
                .join("; ")}
        </Meta>
      </p>
      {sum.examples.length > 0 && (
        <>
          <p>{c.examples}</p>
          <ul>
            {sum.examples.map((e) => (
              <Example m={m} example={e} />
            ))}
          </ul>
        </>
      )}
      {download !== null && (
        <p>
          {download !== undefined ? (
            <LinkButton href={download.href}>{download.label}</LinkButton>
          ) : (
            sum.file !== null && (
              <LinkButton href={`/exports/changes/${generation}/${sum.file}`}>
                {csvLabel === undefined
                  ? c.download(((sum.bytes ?? 0) / 1e6).toFixed(1))
                  : c.downloadAs(csvLabel, ((sum.bytes ?? 0) / 1e6).toFixed(1))}
              </LinkButton>
            )
          )}
        </p>
      )}
    </article>
  );
}

/** One record: its field number, linked to its specimen, and each value the line changed on it, old Beeline's first. */
function Example({ m, example: e }: { m: Messages; example: ChangeExample }) {
  const c = m.legacyChanges;
  const value = (v: string | null) => (v === null ? null : v === "" ? <Absent label={c.blank} /> : v);
  return (
    <li>
      {e.specimenId === null ? (
        <>
          {e.fieldNumber} <Meta>({c.noSpecimen})</Meta>
        </>
      ) : (
        <a href={`/specimens/${e.specimenId}`}>{e.fieldNumber}</a>
      )}
      <ul>
        {e.values.map((v) =>
          v.column === RECORD_COLUMN ? (
            <li>
              {v.kind === "tied_second_record" && v.new !== null && v.new !== ""
                ? c.record.tiedTo(v.new)
                : v.new === ""
                  ? c.record.onlyOld
                  : c.record.onlyNew}
              {v.kind in m.heldBack.reason && `: ${m.heldBack.reason[v.kind as keyof typeof m.heldBack.reason]}`}
            </li>
          ) : v.old === null ? (
            <li>
              <code>{v.column}</code>: {c.hiddenPoint}
            </li>
          ) : (
            <li>
              <code>{v.column}</code>: {value(v.old)}, {c.now} {value(v.new)}
            </li>
          ),
        )}
      </ul>
    </li>
  );
}
