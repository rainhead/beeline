import type { Messages } from "../messages/index.js";
import type { HeldBack, HeldBackRecord } from "../held-back.js";
import { Absent, DataTable, EmptyState, LinkButton, Meta, PageHeader } from "./components/index.js";

/**
 * The old Beeline's records new Beeline held back, and why (beeline-cel0,
 * src/app/held-back.ts). Admin-gated like /exports, which links here: the
 * records carry collectors' names and observations.
 *
 * Counts first, split into the active and settled seasons by the year each
 * record wrote, then a row per record. Records holding nothing but a field
 * number are one line: a row each would say nothing.
 */
export function HeldBackPage({ m, heldBack }: { m: Messages; heldBack: HeldBack | null }) {
  const h = m.heldBack;
  return (
    <>
      <PageHeader title={h.heading} lede={h.intro} />
      {heldBack === null ? (
        <EmptyState>{h.noStaging}</EmptyState>
      ) : heldBack.records.length === 0 && heldBack.bare === null ? (
        <EmptyState>{h.none}</EmptyState>
      ) : (
        <>
          <p>
            <LinkButton href="/exports/held-back.csv">{h.download}</LinkButton> <Meta>{h.downloadNote}</Meta>
          </p>
          <h2>{h.reasonsHeading}</h2>
          <DataTable columns={[h.colReason, h.colActive(heldBack.activeSince), h.colSettled, h.colNoYear]}>
            {heldBack.reasons.map((r) => (
              <tr>
                <td>{h.reason[r.rule]}</td>
                <td>{m.format.number(r.active)}</td>
                <td>{m.format.number(r.settled)}</td>
                <td>{m.format.number(r.noYear)}</td>
              </tr>
            ))}
          </DataTable>
          <Meta block>{h.reasonsNote}</Meta>
          {heldBack.bare !== null && (
            <p>{h.bare(heldBack.bare.fieldNumbers, heldBack.bare.first, heldBack.bare.last, heldBack.bare.records)}</p>
          )}
          {heldBack.records.length > 0 && (
            <>
              <h2>{h.recordsHeading}</h2>
              <Meta block>{h.dateNote}</Meta>
              <DataTable
                columns={[h.colFieldNumber, h.colCollector, h.colSample, h.colSpecimen, h.colDate, h.colIdentification, h.colWhy, h.colObservation]}
              >
                {heldBack.records.map((r) => (
                  <Row m={m} record={r} />
                ))}
              </DataTable>
            </>
          )}
        </>
      )}
    </>
  );
}

function Row({ m, record: r }: { m: Messages; record: HeldBackRecord }) {
  const h = m.heldBack;
  const blank = <Absent label={h.notWritten} />;
  return (
    <tr>
      <td>{r.fieldNumber === "" ? blank : r.fieldNumber}</td>
      <td>{r.collector ?? blank}</td>
      <td>{r.sampleNumber ?? blank}</td>
      <td>{r.specimenNumber ?? blank}</td>
      <td class="date-written">{r.date ?? blank}</td>
      <td>
        {r.expert !== null ? (
          r.expert
        ) : r.volunteer !== null ? (
          <>
            {r.volunteer} <Meta>{h.volunteer}</Meta>
          </>
        ) : (
          blank
        )}
      </td>
      <td>
        {r.rules.map((rule) => h.reason[rule]).join("; ")}
        {r.related !== null && (
          <Meta block>
            {h.related} <a href={`/specimens/${r.related.specimenId}`}>{r.related.fieldNumber}</a>: {r.related.remark}
          </Meta>
        )}
      </td>
      <td>
        {r.observationId === null ? (
          blank
        ) : (
          <a href={`https://www.inaturalist.org/observations/${r.observationId}`}>{r.observationId}</a>
        )}
      </td>
    </tr>
  );
}
