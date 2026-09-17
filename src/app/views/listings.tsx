import type { Child } from "hono/jsx";
import { PROGRAM_MEMBERSHIP } from "../../model.js";
import {
  ALL,
  CSV_ROW_LIMIT,
  DEFAULT_SORT,
  MEMBER_ANY,
  MEMBER_UNRECORDED,
  MINE,
  OUTSIDE,
  PAGE_SIZE,
  defaultDirection,
  isFiltered,
  listingHref,
  listingParams,
  type AtlasOption,
  type ListingQuery,
  type Page,
  type SampleRow,
  type SortDirection,
  type SortKey,
  type SpecimenRow,
} from "../listings.js";
import { sampleHref, specimenHref } from "../record.js";
import type { Messages } from "../messages/index.js";
import {
  Absent,
  Chip,
  DataTable,
  EmptyState,
  Field,
  FilterPills,
  Meta,
  OrAbsent,
  PageHeader,
  Pager,
  Pill,
  SearchForm,
  SelectField,
  TaxonName,
  TextField,
  type FilterPill,
  type TableColumn,
} from "./components/index.js";

/**
 * Browsing the collection: the sample and specimen listings.
 *
 * Both screens are the same shape — header, a toolbar (whose records, and a
 * search box), the filters in force as pills, the table with a menu in each
 * column heading, a pager — because they answer the same question at two
 * grains. What differs is the columns, so that is all these two components
 * hold; everything else is shared here.
 *
 * Reshaped with Peter and Nora on the sandbox (2026-09-16): the filter bar
 * was ten boxes above the table and a person filtering a table looks at the
 * column, so each column's heading now opens a menu with its own sort and
 * its own filter, and what is in force is read off the pills rather than
 * off ten controls' states.
 */

/** How a listing describes itself, given who is looking and at what. */
function lede(
  copy: { ledeMine: string; ledeAtlas: (atlas: string) => string; ledeAll: string; ledeOutside: string },
  query: ListingQuery,
  atlases: readonly AtlasOption[],
): string {
  if (query.scope === MINE) return copy.ledeMine;
  if (query.scope === ALL) return copy.ledeAll;
  if (query.scope === OUTSIDE) return copy.ledeOutside;
  return copy.ledeAtlas(atlases.find((a) => a.code === query.scope)?.name ?? query.scope);
}

/**
 * Whose records: mine, my atlas's, everybody's. Staff only — a volunteer's
 * listing is their own and offers no way out of it — and two-way for a
 * staff member who belongs to no atlas. Other atlases, and the ground
 * outside all of them, are reached through the Atlas column's menu; a scope
 * chosen that way shows as a pill instead of a position here.
 */
function ScopeToggle({
  m,
  path,
  query,
  homeAtlas,
}: {
  m: Messages;
  path: string;
  query: ListingQuery;
  homeAtlas: AtlasOption | null;
}) {
  const options: Array<[string, string]> = [[MINE, m.listings.scope.mine]];
  if (homeAtlas !== null) options.push([homeAtlas.code, m.listings.scope.atlasRecords(homeAtlas.name)]);
  options.push([ALL, m.listings.scope.all]);
  return (
    <nav class="segmented" aria-label={m.listings.scope.label}>
      {options.map(([scope, label]) =>
        query.scope === scope ? (
          <a href={listingHref(path, query, { scope, page: 1 })} aria-current="page">
            {label}
          </a>
        ) : (
          <a href={listingHref(path, query, { scope, page: 1 })}>{label}</a>
        ),
      )}
    </nav>
  );
}

/** The staff note: this page is showing more than your own collecting. */
function ScopeNote({ m, query, atlases }: { m: Messages; query: ListingQuery; atlases: readonly AtlasOption[] }) {
  if (query.scope === MINE) return null;
  const what =
    query.scope === ALL
      ? m.listings.scope.staffNoteAll
      : query.scope === OUTSIDE
        ? m.listings.scope.staffNoteOutside
        : m.listings.scope.staffNoteAtlas(atlases.find((a) => a.code === query.scope)?.name ?? query.scope);
  return <Meta block>{m.listings.scope.staffNote(what)}</Meta>;
}

/**
 * Every filter cleared, scope and sort left alone: clearing is not signing
 * out of an atlas, and not un-sorting.
 *
 * Typed as the whole query minus the parts Clear deliberately keeps, so a
 * filter added to ListingQuery and forgotten here fails to compile. It was
 * spread into a Partial before, which let `member` be missing silently — and
 * a Clear link that clears everything but one box is worse than none.
 */
const emptyFilters: Omit<ListingQuery, "scope" | "page" | "sort" | "dir"> = {
  q: "",
  from: null,
  to: null,
  place: "",
  collector: "",
  member: MEMBER_ANY,
  taxon: "",
  host: "",
  det: "any",
  qc: "any",
};

function activeFilters(
  m: Messages,
  path: string,
  query: ListingQuery,
  atlases: readonly AtlasOption[],
  homeAtlas: AtlasOption | null,
): FilterPill[] {
  const f = m.listings.filters;
  const out: FilterPill[] = [];
  const clear = (override: Partial<ListingQuery>) => listingHref(path, query, { ...override, page: 1 });
  const atlasName = (code: string) => atlases.find((a) => a.code === code)?.name ?? code;
  // A scope the toggle has no position for reads as a pill, and clearing it
  // goes back to everything rather than to mine: it was reached from there.
  const toggled = new Set([MINE, ALL, homeAtlas?.code]);
  if (!toggled.has(query.scope)) {
    out.push({
      label: m.listings.samples.colAtlas,
      value: query.scope === OUTSIDE ? m.listings.scope.outside : atlasName(query.scope),
      clearHref: clear({ scope: ALL }),
    });
  }
  if (query.q !== "") out.push({ label: f.search, value: query.q, clearHref: clear({ q: "" }) });
  if (query.from !== null) out.push({ label: f.from, value: m.format.date(query.from), clearHref: clear({ from: null }) });
  if (query.to !== null) out.push({ label: f.to, value: m.format.date(query.to), clearHref: clear({ to: null }) });
  if (query.place !== "") out.push({ label: f.place, value: query.place, clearHref: clear({ place: "" }) });
  if (query.collector !== "") {
    out.push({ label: f.collector, value: query.collector, clearHref: clear({ collector: "" }) });
  }
  if (query.member !== MEMBER_ANY) {
    const value =
      query.member === PROGRAM_MEMBERSHIP
        ? f.memberProgram
        : query.member === MEMBER_UNRECORDED
          ? f.memberUnrecorded
          : atlasName(query.member);
    out.push({ label: f.member, value, clearHref: clear({ member: MEMBER_ANY }) });
  }
  if (query.taxon !== "") out.push({ label: f.taxon, value: query.taxon, clearHref: clear({ taxon: "" }) });
  if (query.host !== "") out.push({ label: f.host, value: query.host, clearHref: clear({ host: "" }) });
  if (query.det !== "any") {
    out.push({
      label: f.det,
      value: query.det === "determined" ? f.detDetermined : f.detUndetermined,
      clearHref: clear({ det: "any" }),
    });
  }
  if (query.qc !== "any") {
    const value = { flagged: f.qcFlagged, blocking: f.qcBlocking, warning: f.qcWarning, clean: f.qcClean }[query.qc];
    out.push({ label: f.qc, value, clearHref: clear({ qc: "any" }) });
  }
  return out;
}

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

/** What a column's values are, which decides how its two sort orders are named. */
export type SortKind = "text" | "date" | "number";

/**
 * The words a column's menu needs, from the catalog: its two orders named for
 * what the values are, and an accessible name that says what the menu holds
 * and no more. Shared with the People page, whose columns are the same shape.
 */
export function columnCopy(m: Messages, label: string, kind: SortKind, hasSort: boolean, hasFilter: boolean) {
  const s = m.listings.sort;
  const names: Record<SortKind, [string, string]> = {
    text: [s.textAsc, s.textDesc],
    date: [s.dateAsc, s.dateDesc],
    number: [s.numberAsc, s.numberDesc],
  };
  const c = m.listings.columnMenu;
  return {
    ascLabel: names[kind][0],
    descLabel: names[kind][1],
    menuLabel: (!hasSort ? c.filter : !hasFilter ? c.sort : c.both)(label),
  };
}

/** What a listing says about one of its columns; the table draws it. */
interface ColumnOptions {
  m: Messages;
  path: string;
  query: ListingQuery;
  label: string;
  /** The key this column orders by; null for a column with no order. */
  sort: SortKey | null;
  kind?: SortKind;
  /** The query fields this column's filter sets; the form keeps the rest. */
  fields?: ReadonlyArray<keyof ListingQuery>;
  /** The filter's controls. */
  controls?: Child;
}

function column({ m, path, query, label, sort, kind = "text", fields = [], controls }: ColumnOptions): TableColumn {
  if (sort === null && fields.length === 0) return { label };
  const copy = columnCopy(m, label, kind, sort !== null, fields.length > 0);
  const sortHref = (dir: SortDirection) => listingHref(path, query, { sort: sort ?? DEFAULT_SORT, dir, page: 1 });
  return {
    label,
    menu: {
      menuLabel: copy.menuLabel,
      sort:
        sort === null
          ? undefined
          : {
              current: query.sort === sort ? query.dir : null,
              ascHref: sortHref("asc"),
              descHref: sortHref("desc"),
              ascLabel: copy.ascLabel,
              descLabel: copy.descLabel,
            },
      filter:
        fields.length === 0
          ? undefined
          : {
              action: path,
              params: listingParams(query),
              fields,
              applyLabel: m.listings.filters.apply,
              controls,
            },
    },
  };
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
    <div class="results-header">
      <p class="row baseline">
        <span class="results-count">{count(total)}</span>
        {total > 0 && <a href={listingHref(`${path}.csv`, query, { page: 1 })}>{m.listings.csv.download}</a>}
      </p>
      <Meta block>
        {m.listings.csv.note}
        {/* An export that silently stops short is worse than a small one. */}
        {total > CSV_ROW_LIMIT && <> {m.listings.csv.truncated(CSV_ROW_LIMIT)}</>}
      </Meta>
    </div>
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
  /** The atlas the viewer belongs to, for the scope toggle; null when none is recorded. */
  homeAtlas?: AtlasOption | null;
}

/** The part above the table that both listings share. */
function Toolbar<Row>({
  copy,
  path,
  props,
}: {
  copy: { count: (total: number) => string };
  path: string;
  props: ListingProps<Row>;
}) {
  const { m, query, atlases, admin } = props;
  const homeAtlas = props.homeAtlas ?? null;
  const filters = activeFilters(m, path, query, atlases, admin ? homeAtlas : null);
  return (
    <>
      <ScopeNote m={m} query={query} atlases={atlases} />
      <div class="listing-toolbar">
        {admin && <ScopeToggle m={m} path={path} query={query} homeAtlas={homeAtlas} />}
        <SearchForm
          action={path}
          params={listingParams(query)}
          value={query.q}
          label={m.listings.filters.search}
          placeholder={m.listings.filters.searchHint}
        />
      </div>
      <FilterPills
        filters={filters}
        clearAllHref={isFiltered(query) ? listingHref(path, query, { ...emptyFilters, page: 1 }) : null}
        clearAllLabel={m.listings.filters.clear}
        groupLabel={m.listings.filters.inForce}
        removeLabel={m.listings.filters.remove}
      />
      {props.page.rows.length > 0 && (
        <ResultsHeader m={m} path={path} query={query} total={props.page.total} count={copy.count} />
      )}
    </>
  );
}

/** The column menus both listings share: date, collectors, place, atlas. */
type Shared = { m: Messages; path: string; query: ListingQuery; label: string };

function dateColumn({ m, path, query, label }: Shared): TableColumn {
  const f = m.listings.filters;
  return column({
    m,
    path,
    query,
    label,
    sort: "date",
    kind: "date",
    fields: ["from", "to"],
    controls: (
      <>
        <DateField id="from" name="from" label={f.from} value={query.from} />
        <DateField id="to" name="to" label={f.to} value={query.to} />
      </>
    ),
  });
}

type Staffed = Shared & { atlases: readonly AtlasOption[]; admin: boolean };

function collectorsColumn({ m, path, query, label, atlases, admin }: Staffed): TableColumn {
  const f = m.listings.filters;
  // Staff only: a volunteer's listing is already one collector's, so their
  // column sorts and does not filter.
  return column({
    m,
    path,
    query,
    label,
    sort: "collector",
    fields: admin ? ["collector", "member"] : [],
    controls: admin && (
      <>
        <TextField id="collector" name="collector" label={f.collector} value={query.collector} hint={f.collectorHint} />
        {/* The axis scope cannot answer: whose records, not whose ground. */}
        <SelectField
          id="member"
          name="member"
          label={f.member}
          hint={f.memberHint}
          value={query.member}
          options={[
            [MEMBER_ANY, f.memberAny] as const,
            ...atlases.map((a) => [a.code, a.name] as const),
            [PROGRAM_MEMBERSHIP, f.memberProgram] as const,
            [MEMBER_UNRECORDED, f.memberUnrecorded] as const,
          ]}
        />
      </>
    ),
  });
}

function placeColumn({ m, path, query, label }: Shared): TableColumn {
  const f = m.listings.filters;
  return column({
    m,
    path,
    query,
    label,
    sort: "place",
    fields: ["place"],
    controls: <TextField id="place" name="place" label={f.place} value={query.place} hint={f.placeHint} />,
  });
}

function hostColumn({ m, path, query, label }: Shared): TableColumn {
  const f = m.listings.filters;
  return column({
    m,
    path,
    query,
    label,
    sort: "host",
    fields: ["host"],
    controls: <TextField id="host" name="host" label={f.host} value={query.host} hint={f.hostHint} />,
  });
}

/**
 * The atlas column narrows by setting scope — an atlas, or the ground
 * outside every one — which is why it is staff-only as a filter: scope is
 * the gate, and a volunteer's is fixed.
 */
function atlasColumn({ m, path, query, label, atlases, admin }: Staffed): TableColumn {
  return column({
    m,
    path,
    query,
    label,
    sort: "atlas",
    fields: admin ? ["scope"] : [],
    controls: admin && (
      <SelectField
        id="scope"
        name="scope"
        label={m.listings.scope.label}
        value={query.scope}
        options={[
          [ALL, m.listings.scope.all],
          ...atlases.map((a) => [a.code, a.name] as const),
          [OUTSIDE, m.listings.scope.outside],
          [MINE, m.listings.scope.mine],
        ]}
      />
    ),
  });
}

function DetSelect({ m, query }: { m: Messages; query: ListingQuery }) {
  const f = m.listings.filters;
  return (
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
  );
}

export function SampleListing(props: ListingProps<SampleRow>) {
  const { m, query, page, atlases, admin } = props;
  const copy = m.listings.samples;
  const f = m.listings.filters;
  const path = "/samples";
  const col = { m, path, query };
  return (
    <>
      <PageHeader title={copy.heading} lede={lede(copy, query, atlases)} />
      <Toolbar copy={copy} path={path} props={props} />
      {page.rows.length === 0 ? (
        <EmptyState heading={copy.emptyHeading}>{isFiltered(query) ? copy.emptyFiltered : copy.emptyMine}</EmptyState>
      ) : (
        <>
          <DataTable
            columns={[
              column({ ...col, label: copy.colSample, sort: "number", kind: "number" }),
              dateColumn({ ...col, label: copy.colDate }),
              collectorsColumn({ ...col, label: copy.colCollectors, atlases, admin }),
              placeColumn({ ...col, label: copy.colPlace }),
              hostColumn({ ...col, label: copy.colHost }),
              // A taxon name only ever matches something already determined,
              // so the gap needs its own control rather than a magic word in
              // the box. On samples both are about the sample's specimens.
              column({
                ...col,
                label: copy.colSpecimens,
                sort: "specimens",
                kind: "number",
                fields: ["taxon", "det"],
                controls: (
                  <>
                    <TextField id="taxon" name="taxon" label={f.taxon} value={query.taxon} hint={f.taxonHint} />
                    <DetSelect m={m} query={query} />
                  </>
                ),
              }),
              column({
                ...col,
                label: copy.colStatus,
                sort: "flags",
                kind: "number",
                fields: ["qc"],
                controls: (
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
                ),
              }),
              atlasColumn({ ...col, label: copy.colAtlas, atlases, admin }),
              // Read aloud, never drawn: the column of links out.
              { label: copy.colLinks, hidden: true },
            ]}
          >
            {page.rows.map((row) => (
              <tr>
                <td>
                  <Pill href={sampleHref(row.sample_id)}>{row.sample_number}</Pill>
                </td>
                <td class="nowrap">{m.format.dateRange(row.date_start, row.date_end)}</td>
                {/* The label form: on a listing, the question about a
                    collector is whose name will be printed (/design/names). */}
                <td>{m.format.list((page.collectors.get(row.sample_id) ?? []).map((c) => c.label))}</td>
                <td>
                  <OrAbsent value={m.format.place([row.locality, row.county, row.state_province])} label={m.absence.notRecorded} />
                </td>
                <td>
                  {row.host_name === null ? (
                    <Absent label={m.absence.none} />
                  ) : (
                    <TaxonName rank={row.host_rank ?? ""} scientificName={row.host_name} />
                  )}
                </td>
                <td>{m.format.number(row.specimen_count)}</td>
                <td>
                  <StatusChip m={m} blocking={row.blocking} warning={row.warning} />
                </td>
                <td>
                  <OrAbsent value={row.atlas_code} label={copy.atlasOutside} spelled />
                </td>
                {/* Links out, not a value: empty when there is nothing to offer. */}
                <td class="actions">
                  {row.inat_observation_id !== null ? (
                    <a
                      class="inat-link"
                      href={`https://www.inaturalist.org/observations/${row.inat_observation_id}`}
                      title={copy.viewOnInat}
                    >
                      <img src="/static/inat-logo.png" alt={copy.viewOnInat} width="66" height="12" />
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

export function SpecimenListing(props: ListingProps<SpecimenRow>) {
  const { m, query, page, atlases, admin } = props;
  const copy = m.listings.specimens;
  const f = m.listings.filters;
  const path = "/specimens";
  const col = { m, path, query };
  return (
    <>
      <PageHeader title={copy.heading} lede={lede(copy, query, atlases)} />
      <Toolbar copy={copy} path={path} props={props} />
      {page.rows.length === 0 ? (
        <EmptyState heading={copy.emptyHeading}>{isFiltered(query) ? copy.emptyFiltered : copy.emptyMine}</EmptyState>
      ) : (
        <>
          <DataTable
            columns={[
              column({ ...col, label: copy.colFieldNumber, sort: "field", kind: "number" }),
              column({ ...col, label: copy.colSample, sort: "number", kind: "number" }),
              dateColumn({ ...col, label: copy.colDate }),
              collectorsColumn({ ...col, label: copy.colCollectors, atlases, admin }),
              placeColumn({ ...col, label: copy.colPlace }),
              // On a specimen listing the taxon filter is about *this*
              // specimen's determination, not its sample's.
              column({
                ...col,
                label: copy.colDetermination,
                sort: "determination",
                fields: ["taxon", "det"],
                controls: (
                  <>
                    <TextField id="taxon" name="taxon" label={f.taxon} value={query.taxon} hint={f.taxonHint} />
                    <DetSelect m={m} query={query} />
                  </>
                ),
              }),
              column({ ...col, label: copy.colDeterminer, sort: "determiner" }),
              atlasColumn({ ...col, label: copy.colAtlas, atlases, admin }),
            ]}
          >
            {page.rows.map((row) => (
              <tr>
                <td>
                  <Pill href={specimenHref(row.specimen_id)} mono={row.field_number !== null}>
                    {row.field_number === null ? copy.noFieldNumber : row.field_number}
                  </Pill>
                </td>
                <td>
                  <Pill href={sampleHref(row.sample_id)}>{row.sample_number}</Pill>
                </td>
                <td class="nowrap">{m.format.date(row.date_start)}</td>
                <td>{m.format.list((page.collectors.get(row.sample_id) ?? []).map((c) => c.label))}</td>
                <td>
                  <OrAbsent value={m.format.place([row.locality, row.county, row.state_province])} label={m.absence.notRecorded} />
                </td>
                <td>
                  {row.scientific_name !== null && row.taxon_rank !== null ? (
                    <TaxonName
                      rank={row.taxon_rank}
                      scientificName={row.scientific_name}
                      qualifier={row.qualifier ?? undefined}
                    />
                  ) : (
                    <Absent label={copy.undetermined} spelled />
                  )}
                </td>
                <td>
                  <OrAbsent value={row.determiner} label={m.absence.none} />
                  {row.is_expert === true && (
                    <>
                      {" "}
                      <Chip>{copy.expert}</Chip>
                    </>
                  )}
                </td>
                <td>
                  <OrAbsent value={row.atlas_code} label={m.listings.samples.atlasOutside} spelled />
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
