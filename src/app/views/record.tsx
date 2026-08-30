import type { Child } from "hono/jsx";
import type { Messages } from "../messages/index.js";
import {
  sampleHref,
  specimenHref,
  type DeterminationEvent,
  type RecordFinding,
  type SampleDetail,
  type SampleSpecimenPage,
  type SpecimenDetail,
} from "../record.js";
import {
  Card,
  Chip,
  DataTable,
  DetailList,
  EmptyState,
  LinkButton,
  Meta,
  PageHeader,
  Pager,
  TaxonName,
  Term,
  type Detail,
} from "./components/index.js";

/**
 * One record: the sample page and the specimen page (beeline-2c3.34).
 *
 * The sample blocks — what it is, where it was collected, what is flagged on
 * it — are components rather than a section of the sample page, because the
 * specimen page carries the same three. A specimen with no collector, date
 * or place is not a record of anything, so it repeats them rather than
 * linking to them; stating them once here is what keeps the two pages from
 * drifting into two different accounts of the same sample.
 */

/** A value that is simply absent, said rather than left blank. */
const Unknown = ({ m }: { m: Messages }) => <Meta>{m.record.sample.unknown}</Meta>;

/** Text, or the "not recorded" line where there is none. */
const orUnknown = (m: Messages, value: string | null): Child => (value === null || value === "" ? <Unknown m={m} /> : value);

/** The staff note, on a record the viewer did not collect. */
export function RecordScopeNote({ m, mine }: { m: Messages; mine: boolean }) {
  return mine ? null : <Meta block>{m.record.staffNote}</Meta>;
}

/**
 * What the sample is: who collected it, when, how, and where it belongs.
 * Place is here and coordinates are in `WhereCollected` — they are two
 * different claims, one about a label's text and one about a point on the
 * ground, and only the second carries provenance.
 */
export function SampleFacts({ m, sample }: { m: Messages; sample: SampleDetail }) {
  const s = m.record.sample;
  const items: Array<Detail | null> = [
    { term: <Term m={m} slug="collector">{s.collectors}</Term>, value: m.format.list(sample.collectors.map((c) => c.display)) },
    { term: s.collected, value: m.format.dateRange(sample.date_start, sample.date_end) },
    { term: s.method, value: sample.kind === "trap" ? <Term m={m} slug="trap-sample">{s.methodTrap}</Term> : s.methodNet },
    { term: <Term m={m} slug="protocol">{s.protocol}</Term>, value: orUnknown(m, sample.protocol) },
    // Trap-only, and still free text pending the staff vocabulary answers.
    sample.sampling_effort === null ? null : { term: s.effort, value: sample.sampling_effort },
    {
      term: s.place,
      value: orUnknown(m, m.format.place([sample.locality, sample.county, sample.state_province, sample.country]) || null),
    },
    {
      term: <Term m={m} slug="atlas">{s.atlas}</Term>,
      // No atlas is an answer, not a gap: collecting where none reaches is
      // ordinary Master Melittologist work (beeline-lcl).
      value: sample.atlas_name ?? <Meta>{s.atlasOutside}</Meta>,
    },
    // A bee taken off no flower has no floral host, and that is complete —
    // so the row is absent rather than reading as something missing.
    sample.host_name_as_observed === null
      ? null
      : { term: <Term m={m} slug="floral-host">{s.host}</Term>, value: sample.host_name_as_observed },
    {
      term: <Term m={m} slug="observation">{s.observation}</Term>,
      value:
        sample.inat_observation_id === null ? (
          <Meta>{s.observationNone}</Meta>
        ) : (
          <a href={`https://www.inaturalist.org/observations/${sample.inat_observation_id}`}>
            {String(sample.inat_observation_id)}
          </a>
        ),
    },
  ];
  return <DetailList items={items} />;
}

/**
 * Where it was collected, with why we believe it.
 *
 * Coordinates never travel without their provenance and the observation's
 * geoprivacy beside them — the CSV carries the same three columns for the
 * same reason (src/app/listings.ts). Absence is a statement too: obscured
 * pairs are deliberately never brought into the sample layer, so "no
 * coordinates" means none believed rather than none recorded.
 */
export function WhereCollected({ m, sample }: { m: Messages; sample: SampleDetail }) {
  const w = m.record.sample.where;
  if (sample.latitude === null || sample.longitude === null) {
    return (
      <>
        <h2>{w.heading}</h2>
        <Meta block>{w.coordinatesNone}</Meta>
      </>
    );
  }
  // Only says something where the public view DIFFERS from what is above.
  // Null on both means iNaturalist publishes the coordinates as they are,
  // which the Source row has already said — and on the 6,365 samples that
  // have coordinates and no observation at all it said it about an
  // observation that does not exist.
  const privacy =
    sample.geoprivacy === "private"
      ? w.privacyPrivate
      : sample.geoprivacy === "obscured"
        ? w.privacyObscured
        : sample.taxon_geoprivacy === "private"
          ? w.privacyTaxonPrivate
          : sample.taxon_geoprivacy === "obscured"
            ? w.privacyTaxonObscured
            : null;
  return (
    <>
      <h2>{w.heading}</h2>
      <DetailList
        items={[
          { term: w.coordinates, value: <span class="mono">{`${sample.latitude}, ${sample.longitude}`}</span> },
          {
            term: <Term m={m} slug="coordinate-uncertainty">{w.accuracy}</Term>,
            value:
              sample.coordinate_uncertainty_m === null ? (
                <Unknown m={m} />
              ) : (
                w.accuracyValue(sample.coordinate_uncertainty_m)
              ),
          },
          {
            term: w.source,
            value: <Meta>{w.sources[sample.location_source ?? ""] ?? sample.location_source}</Meta>,
          },
          privacy === null
            ? null
            : {
                term: <Term m={m} slug="obscured-coordinates">{w.privacy}</Term>,
                value: <Meta>{privacy}</Meta>,
              },
          {
            term: w.elevation,
            value:
              sample.elevation_m === null ? (
                <Meta>{w.elevationNone}</Meta>
              ) : (
                <>
                  {w.elevationValue(sample.elevation_m)}
                  <Meta block>
                    {w.elevationFrom(sample.elevation_file ?? sample.elevation_source ?? "")}
                    {/* Descriptive, not a task: an elevation is derived from
                        coordinates and is never the collector's gap to fill
                        (schema/170), so this says what will happen rather
                        than asking for anything. */}
                    {sample.elevation_stale && <> {w.elevationStale}</>}
                  </Meta>
                </>
              ),
          },
        ]}
      />
    </>
  );
}

/**
 * What is flagged on this sample, in the words the QC home uses — read
 * through the same roll-up, so a chip in a listing and this page cannot
 * disagree about a sample (schema/130).
 */
export function SampleFlags({ m, findings }: { m: Messages; findings: readonly RecordFinding[] }) {
  const f = m.record.sample.flags;
  return (
    <>
      <h2>{f.heading}</h2>
      {findings.length === 0 ? (
        <Meta block>{f.clean}</Meta>
      ) : (
        <>
          <ul class="stack plain">
            {findings.map((row) => (
              <li>
                <Chip tone={row.severity === "blocking" ? "blocking" : "warning"}>
                  {row.severity === "blocking" ? m.qc.blocksPrinting : m.qc.headsUp}
                </Chip>{" "}
                {m.qcInstructions[row.rule_name] ?? row.rule_name}
                {row.details && (
                  <>
                    {" "}
                    <code>{row.details}</code>
                  </>
                )}
                {/* A specimen-keyed finding names its specimen: "which of my
                    2,252" is the first question it raises. */}
                {row.specimen_id !== null && (
                  <>
                    {" "}
                    <a href={specimenHref(row.specimen_id)}>
                      {row.field_number === null ? f.onOneSpecimen : f.onSpecimen(row.field_number)}
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
          <Meta block>{m.qc.clearsNote}</Meta>
        </>
      )}
    </>
  );
}

/** The fix-it action: upstream where there is an observation, here where
 * there is not — and only for someone who actually collected it. */
function SampleActions({ m, sample }: { m: Messages; sample: SampleDetail }) {
  const s = m.record.sample;
  if (sample.inat_observation_id !== null) {
    return (
      <p class="row">
        <LinkButton href={`https://www.inaturalist.org/observations/${sample.inat_observation_id}`}>
          {s.viewOnInat}
        </LinkButton>
      </p>
    );
  }
  if (!sample.mine) return null;
  return (
    <p class="row">
      <LinkButton href={`/samples/${sample.sample_id}/edit`}>{s.edit}</LinkButton>
    </p>
  );
}

/** The determination of record for one specimen, as a listing cell. */
function RecordedName({
  m,
  row,
}: {
  m: Messages;
  row: { rank: string | null; scientific_name: string | null; qualifier: "cf." | "aff." | "nr." | null };
}) {
  if (row.scientific_name === null || row.rank === null) {
    return <Meta>{m.record.sample.specimens.undetermined}</Meta>;
  }
  return <TaxonName rank={row.rank} scientificName={row.scientific_name} qualifier={row.qualifier ?? undefined} />;
}

/** The sample's specimens, paged: the largest trap sample holds 2,252. */
function SampleSpecimens({ m, sample, page }: { m: Messages; sample: SampleDetail; page: SampleSpecimenPage }) {
  const c = m.record.sample.specimens;
  return (
    <>
      <h2>{c.heading}</h2>
      {page.total === 0 ? (
        <EmptyState>{c.none}</EmptyState>
      ) : (
        <>
          <Meta block>
            {c.count(page.total)}
            {/* The working count is free to move until printing freezes
                specimens (schema/030), so the two numbers can honestly
                disagree and the page says so rather than picking one. */}
            {page.total !== sample.specimen_count && <> {c.counted(sample.specimen_count, page.total)}</>}
          </Meta>
          <DataTable columns={[c.colFieldNumber, c.colNumber, c.colDetermination, c.colDeterminer]}>
            {page.rows.map((row) => (
              <tr>
                <td>
                  <a href={specimenHref(row.specimen_id)}>
                    {row.field_number === null ? (
                      <Meta>{c.noFieldNumber}</Meta>
                    ) : (
                      <span class="mono">{row.field_number}</span>
                    )}
                  </a>
                </td>
                <td>{m.format.number(row.specimen_number)}</td>
                <td>
                  <RecordedName m={m} row={row} />
                </td>
                <td>
                  {row.determiner}
                  {row.is_expert === true && (
                    <>
                      {" "}
                      <Chip>{c.expert}</Chip>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
          <Pager
            summary={m.listings.paging.page(page.page, page.pages)}
            previousHref={page.page > 1 ? sampleHref(sample.sample_id, page.page - 1) : null}
            nextHref={page.page < page.pages ? sampleHref(sample.sample_id, page.page + 1) : null}
            previousLabel={m.listings.paging.previous}
            nextLabel={m.listings.paging.next}
          />
        </>
      )}
    </>
  );
}

export function SamplePage({
  m,
  sample,
  findings,
  specimens,
}: {
  m: Messages;
  sample: SampleDetail;
  findings: readonly RecordFinding[];
  specimens: SampleSpecimenPage;
}) {
  return (
    <>
      <p>
        <a href="/samples">{m.record.sample.back}</a>
      </p>
      <PageHeader
        title={m.record.sample.title(sample.sample_number)}
        meta={`${m.format.dateRange(sample.date_start, sample.date_end)} · ${m.format.place([
          sample.locality,
          sample.county,
          sample.state_province,
        ])}`}
      />
      <RecordScopeNote m={m} mine={sample.mine} />
      <Card>
        <SampleFacts m={m} sample={sample} />
        <SampleActions m={m} sample={sample} />
      </Card>
      <Card>
        <WhereCollected m={m} sample={sample} />
      </Card>
      <Card>
        <SampleFlags m={m} findings={findings} />
      </Card>
      <Card>
        <SampleSpecimens m={m} sample={sample} page={specimens} />
      </Card>
    </>
  );
}

/**
 * The determination history: every assertion anyone has made about this
 * specimen, newest event first, with the one `determination_of_record`
 * selects marked.
 *
 * Marked rather than sorted to the top. The record is frequently not the
 * newest — the rule is latest expert, else latest volunteer (schema/110) —
 * and hoisting it would rebuild the flattened read this page exists to
 * replace. Where the two differ the page says why, because a volunteer whose
 * later identification is not the one in use is owed the reason.
 */
export function Determinations({ m, events }: { m: Messages; events: readonly DeterminationEvent[] }) {
  const d = m.record.determinations;
  if (events.length === 0) {
    return (
      <>
        <h2>{d.heading}</h2>
        <EmptyState>{d.empty}</EmptyState>
      </>
    );
  }
  const recordIsNewest = events[0]!.of_record;
  return (
    <>
      <h2>{d.heading}</h2>
      <Meta block>{d.intro}</Meta>
      <DataTable columns={[d.colDetermination, d.colDeterminer, d.colDetermined, d.colRecorded, d.colStatus]}>
        {events.map((e) => (
          <tr>
            <td>
              <TaxonName
                rank={e.rank}
                scientificName={e.scientific_name}
                authorship={e.authorship}
                qualifier={e.qualifier ?? undefined}
              />
              {/* The name as the source wrote it, beside the node it
                  resolved to — the only record of what was actually said
                  once staging is frozen (schema/040). Shown only when it
                  differs, so it reads as information rather than as noise. */}
              {e.verbatim_identification !== null && e.verbatim_identification !== e.scientific_name && (
                <Meta block>{d.verbatim(e.verbatim_identification)}</Meta>
              )}
              {(e.sex !== null || e.caste !== null) && (
                <Meta block>
                  {m.format.list([
                    ...(e.sex === null ? [] : [d.sex(e.sex)]),
                    ...(e.caste === null ? [] : [d.caste(e.caste)]),
                  ])}
                </Meta>
              )}
              {e.notes !== null && <Meta block>{e.notes}</Meta>}
            </td>
            <td>
              {e.determiner ?? <Meta>{d.determinerUnknown}</Meta>}
              {e.is_expert && (
                <>
                  {" "}
                  <Chip>{d.expert}</Chip>
                </>
              )}
            </td>
            <td>{e.determined_on === null ? <Meta>{d.determinedUnknown}</Meta> : m.format.date(e.determined_on)}</td>
            <td>
              {m.format.date(e.recorded_at)}
              <Meta block>{d.channels[e.channel] ?? e.channel}</Meta>
            </td>
            <td>{e.of_record && <Chip tone="success">{d.ofRecord}</Chip>}</td>
          </tr>
        ))}
      </DataTable>
      <Meta block>
        {d.recordRule}
        {!recordIsNewest && <> {d.recordNotNewest}</>}
      </Meta>
    </>
  );
}

export function SpecimenPage({
  m,
  specimen,
  events,
  findings,
}: {
  m: Messages;
  specimen: SpecimenDetail;
  events: readonly DeterminationEvent[];
  findings: readonly RecordFinding[];
}) {
  const sample = specimen.sample;
  const c = m.record.specimen;
  return (
    <>
      <p>
        <a href={sampleHref(sample.sample_id)}>{c.back(sample.sample_number)}</a>
      </p>
      <PageHeader
        title={
          specimen.field_number === null
            ? c.titleUnnumbered(specimen.specimen_number, sample.sample_number)
            : c.title(specimen.field_number)
        }
        meta={`${m.format.dateRange(sample.date_start, sample.date_end)} · ${m.format.place([
          sample.locality,
          sample.county,
          sample.state_province,
        ])}`}
      />
      <RecordScopeNote m={m} mine={sample.mine} />
      {specimen.field_number === null && <Meta block>{c.fieldNumberNone}</Meta>}

      {/* The history first: it is why this page exists. */}
      <Card>
        <Determinations m={m} events={events} />
      </Card>

      {/* And then the whole sample, not a stub of it: a determination read
          without where and when the insect was collected is not a record. */}
      <Card>
        <h2>
          <a href={sampleHref(sample.sample_id)}>{m.record.sample.title(sample.sample_number)}</a>
        </h2>
        <SampleFacts m={m} sample={sample} />
      </Card>
      <Card>
        <WhereCollected m={m} sample={sample} />
      </Card>
      <Card>
        <SampleFlags m={m} findings={findings} />
      </Card>
    </>
  );
}
