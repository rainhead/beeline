import type { Messages } from "../messages/index.js";
import type { HeldBack, HeldBackRecord } from "../held-back.js";
import { Absent, DataTable, EmptyState, LinkButton, Meta, PageHeader } from "./components/index.js";

/**
 * The old Beeline's records new Beeline held back, and why (beeline-cel0,
 * src/app/held-back.ts). Admin-gated like /exports, which links here: the
 * records carry collectors' names and observations.
 *
 * Counts first, a column for each program that has records, then each
 * program's records under a heading of its own, in field-number order.
 * Records holding nothing but a field number are one line: a row each would
 * say nothing.
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
          <DataTable columns={[h.colReason, ...heldBack.programs]}>
            {heldBack.reasons.map((r) => (
              <tr>
                <td>{h.reason[r.rule]}</td>
                {heldBack.programs.map((p) => (
                  <td>{m.format.number(r.records[p] ?? 0)}</td>
                ))}
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
              {heldBack.programs.map((program) => (
                <section>
                  <h3>{program}</h3>
                  <DataTable
                    columns={[h.colFieldNumber, h.colCollector, h.colSample, h.colSpecimen, h.colDate, h.colIdentification, h.colWhy, h.colObservation]}
                  >
                    {heldBack.records
                      .filter((r) => r.program === program)
                      .map((r) => (
                        <Row m={m} record={r} />
                      ))}
                  </DataTable>
                </section>
              ))}
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
        {r.rules.length === 0 ? h.noReason : r.rules.map((rule) => h.reason[rule]).join("; ")}
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
        {r.sample !== null && (
          <Meta block>
            <a href={`/samples/${r.sample.sampleId}`}>{h.sampleLink}</a> {h.sampleCounts(r.sample.counts, r.sample.holds)}
          </Meta>
        )}
      </td>
    </tr>
  );
}
