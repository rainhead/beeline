import type { Child } from "hono/jsx";
import {
  ALL,
  CSV_ROW_LIMIT,
  MINE,
  PAGE_SIZE,
  isFiltered,
  listingHref,
  type AtlasOption,
  type ListingQuery,
  type Page,
  type SampleRow,
  type SpecimenRow,
} from "../listings.js";
import type { Messages } from "../messages/index.js";
import {
  Button,
  Chip,
  DataTable,
  EmptyState,
  Field,
  FilterBar,
  Meta,
  PageHeader,
  Pager,
  SelectField,
  TaxonName,
  TextField,
} from "./components/index.js";

/**
 * Browsing the collection: the sample and specimen listings.
 *
 * Both screens are the same shape — header, filters, table, pager — because
 * they answer the same question at two grains. What differs is the columns,
 * so that is all these two components hold; everything else is shared here.
 */

/** Where a row was collected, as one line, from whichever parts we have. */
const place = (r: { locality: string | null; county: string | null; state_province: string | null }) =>
  [r.locality, r.county, r.state_province].filter(Boolean).join(", ");

/** How a listing describes itself, given who is looking and at what. */
function lede(
  copy: { ledeMine: string; ledeAtlas: (atlas: string) => string; ledeAll: string },
  query: ListingQuery,
  atlases: readonly AtlasOption[],
): string {
  if (query.scope === MINE) return copy.ledeMine;
  if (query.scope === ALL) return copy.ledeAll;
  return copy.ledeAtlas(atlases.find((a) => a.code === query.scope)?.name ?? query.scope);
}

/** The staff note: this page is showing more than your own collecting. */
function ScopeNote({ m, query, atlases }: { m: Messages; query: ListingQuery; atlases: readonly AtlasOption[] }) {
  if (query.scope === MINE) return null;
  const what =
    query.scope === ALL
      ? m.listings.scope.staffNoteAll
      : m.listings.scope.staffNoteAtlas(atlases.find((a) => a.code === query.scope)?.name ?? query.scope);
  return <Meta block>{m.listings.scope.staffNote(what)}</Meta>;
}

/**
 * The filter form. A GET form, so its fields become the query string and
 * every filtered listing is a shareable URL — which is the whole point of a
 * staff member helping someone by sending them a link.
 */
function Filters({
  m,
  path,
  query,
  atlases,
  admin,
}: {
  m: Messages;
  path: string;
  query: ListingQuery;
  atlases: readonly AtlasOption[];
  admin: boolean;
}) {
  const f = m.listings.filters;
  return (
    <FilterBar
      action={path}
      actions={
        <>
          <Button>{f.apply}</Button>
          {isFiltered(query) && <a href={listingHref(path, query, { ...emptyFilters, page: 1 })}>{f.clear}</a>}
        </>
      }
    >
      {/* Scope is a filter like any other, and only staff have more than one
          value for it — a volunteer's listing has no control to ignore. */}
      {admin && (
        <SelectField
          id="scope"
          name="scope"
          label={m.listings.scope.label}
          value={query.scope}
          options={[
            [MINE, m.listings.scope.mine],
            ...atlases.map((a) => [a.code, a.name] as const),
            [ALL, m.listings.scope.all],
          ]}
        />
      )}
      <TextField id="q" name="q" label={f.search} value={query.q} hint={f.searchHint} />
      <DateField id="from" name="from" label={f.from} value={query.from} />
      <DateField id="to" name="to" label={f.to} value={query.to} />
      <TextField id="place" name="place" label={f.place} value={query.place} hint={f.placeHint} />
      {/* Staff only: a volunteer's listing is already one collector's. */}
      {admin && (
        <TextField id="collector" name="collector" label={f.collector} value={query.collector} hint={f.collectorHint} />
      )}
      <TextField id="taxon" name="taxon" label={f.taxon} value={query.taxon} hint={f.taxonHint} />
      {/* A taxon name only ever matches something already determined, so the
          gap needs its own control rather than a magic word in the box. */}
      <SelectField
        id="det"
        name="det"
        label={f.det}
        value={query.det}
        options={[
          ["any", f.detAny],
          ["determined", f.detDetermined],
          ["undetermined", f.detUndetermined],
        ]}
      />
      <SelectField
        id="season"
        name="season"
        label={f.season}
        value={query.season}
        options={[
          ["any", f.seasonAny],
          ["open", f.seasonOpen],
          ["settled", f.seasonSettled],
        ]}
      />
      <SelectField
        id="qc"
        name="qc"
        label={f.qc}
        value={query.qc}
        options={[
          ["any", f.qcAny],
          ["flagged", f.qcFlagged],
          ["blocking", f.qcBlocking],
          ["warning", f.qcWarning],
          ["clean", f.qcClean],
        ]}
      />
    </FilterBar>
  );
}

/** Every filter cleared, scope left alone: clearing is not signing out of an atlas. */
const emptyFilters = {
  q: "",
  from: null,
  to: null,
  place: "",
  collector: "",
  taxon: "",
  det: "any",
  season: "any",
  qc: "any",
} as const;

/**
 * A date input. Not a TextField with type=date bolted on: the value format
 * here is the wire format (ISO), which is exactly what the browser's date
 * control speaks, so no parsing lives on either side.
 */
function DateField({ id, name, label, value }: { id: string; name: string; label: Child; value: string | null }) {
  return (
    <Field id={id} label={label}>
      <input id={id} name={name} type="date" value={value ?? ""} />
    </Field>
  );
}

/** The QC chip a row carries — the same three buckets the filter offers. */
function StatusChip({ m, blocking, warning }: { m: Messages; blocking: number; warning: number }) {
  if (blocking > 0) return <Chip tone="blocking">{m.listings.status.blocking(blocking)}</Chip>;
  if (warning > 0) return <Chip tone="warning">{m.listings.status.warning(warning)}</Chip>;
  return <Chip tone="success">{m.listings.status.clean}</Chip>;
}

function ResultsHeader({
  m,
  path,
  query,
  total,
  count,
}: {
  m: Messages;
  path: string;
  query: ListingQuery;
  total: number;
  count: (total: number) => string;
}) {
  return (
    <p class="row baseline results-header">
      <Meta>{count(total)}</Meta>
      {total > 0 && <a href={listingHref(`${path}.csv`, query, { page: 1 })}>{m.listings.csv.download}</a>}
      <Meta>
        {m.listings.csv.note}
        {/* An export that silently stops short is worse than a small one. */}
        {total > CSV_ROW_LIMIT && <> {m.listings.csv.truncated(CSV_ROW_LIMIT)}</>}
      </Meta>
    </p>
  );
}

function ListingPager({ m, path, query, total }: { m: Messages; path: string; query: ListingQuery; total: number }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <Pager
      summary={m.listings.paging.page(Math.min(query.page, pages), pages)}
      previousHref={query.page > 1 ? listingHref(path, query, { page: query.page - 1 }) : null}
      nextHref={query.page < pages ? listingHref(path, query, { page: query.page + 1 }) : null}
      previousLabel={m.listings.paging.previous}
      nextLabel={m.listings.paging.next}
    />
  );
}

export interface ListingProps<Row> {
  m: Messages;
  query: ListingQuery;
  page: Page<Row>;
  atlases: readonly AtlasOption[];
  /** Whether this session may change scope (config.adminLogins, beeline-6va). */
  admin: boolean;
}

export function SampleListing({ m, query, page, atlases, admin }: ListingProps<SampleRow>) {
  const copy = m.listings.samples;
  const path = "/samples";
  return (
    <>
      <PageHeader title={copy.heading} lede={lede(copy, query, atlases)} />
      <ScopeNote m={m} query={query} atlases={atlases} />
      <Filters m={m} path={path} query={query} atlases={atlases} admin={admin} />
      {page.rows.length === 0 ? (
        <EmptyState heading={copy.emptyHeading}>{isFiltered(query) ? copy.emptyFiltered : copy.emptyMine}</EmptyState>
      ) : (
        <>
          <ResultsHeader m={m} path={path} query={query} total={page.total} count={copy.count} />
          <DataTable
            columns={[
              copy.colSample,
              copy.colDate,
              copy.colCollectors,
              copy.colPlace,
              copy.colSpecimens,
              copy.colStatus,
              copy.colAtlas,
              copy.colLinks,
            ]}
          >
            {page.rows.map((row) => (
              <tr>
                <td>{row.sample_number}</td>
                <td>{copy.dateRange(row.date_start, row.date_end)}</td>
                {/* The label form: on a listing, the question about a
                    collector is whose name will be printed (/design/names). */}
                <td>{m.format.list((page.collectors.get(row.sample_id) ?? []).map((c) => c.label))}</td>
                <td>{place(row)}</td>
                <td>{m.format.number(row.specimen_count)}</td>
                <td>
                  <StatusChip m={m} blocking={row.blocking} warning={row.warning} />
                </td>
                <td>{row.atlas_code}</td>
                <td>
                  {row.inat_observation_id !== null ? (
                    <a href={`https://www.inaturalist.org/observations/${row.inat_observation_id}`}>
                      {copy.viewOnInat}
                    </a>
                  ) : (
                    // No observation to fix upstream: editing happens here,
                    // and only a collector of this sample may do it
                    // (ADR 0004, beeline-2c3.8).
                    row.mine && <a href={`/samples/${row.sample_id}/edit`}>{copy.edit}</a>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
          <ListingPager m={m} path={path} query={query} total={page.total} />
        </>
      )}
    </>
  );
}

export function SpecimenListing({ m, query, page, atlases, admin }: ListingProps<SpecimenRow>) {
  const copy = m.listings.specimens;
  const path = "/specimens";
  return (
    <>
      <PageHeader title={copy.heading} lede={lede(copy, query, atlases)} />
      <ScopeNote m={m} query={query} atlases={atlases} />
      <Filters m={m} path={path} query={query} atlases={atlases} admin={admin} />
      {page.rows.length === 0 ? (
        <EmptyState heading={copy.emptyHeading}>{isFiltered(query) ? copy.emptyFiltered : copy.emptyMine}</EmptyState>
      ) : (
        <>
          <ResultsHeader m={m} path={path} query={query} total={page.total} count={copy.count} />
          <DataTable
            columns={[
              copy.colFieldNumber,
              copy.colSample,
              copy.colDate,
              copy.colCollectors,
              copy.colPlace,
              copy.colDetermination,
              copy.colDeterminer,
              copy.colAtlas,
            ]}
          >
            {page.rows.map((row) => (
              <tr>
                <td>
                  {row.field_number !== null ? (
                    <span class="mono">{row.field_number}</span>
                  ) : (
                    <Meta>{copy.noFieldNumber}</Meta>
                  )}
                </td>
                <td>{row.sample_number}</td>
                <td>{m.format.date(row.date_start)}</td>
                <td>{m.format.list((page.collectors.get(row.sample_id) ?? []).map((c) => c.label))}</td>
                <td>{place(row)}</td>
                <td>
                  {row.scientific_name !== null && row.taxon_rank !== null ? (
                    <TaxonName rank={row.taxon_rank} scientificName={row.scientific_name} />
                  ) : (
                    <Meta>{copy.undetermined}</Meta>
                  )}
                </td>
                <td>
                  {row.determiner}
                  {row.is_expert === true && (
                    <>
                      {" "}
                      <Chip>{copy.expert}</Chip>
                    </>
                  )}
                </td>
                <td>{row.atlas_code}</td>
              </tr>
            ))}
          </DataTable>
          <ListingPager m={m} path={path} query={query} total={page.total} />
        </>
      )}
    </>
  );
}
