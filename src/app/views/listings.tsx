import type { Child } from "hono/jsx";
import { PROGRAM_MEMBERSHIP } from "../../model.js";
import { areaDisplayName } from "../../area-name.js";
import {
  ALL,
  DEFAULT_SORT,
  MEMBER_ANY,
  MEMBER_UNRECORDED,
  MINE,
  CATCH_ALL,
  OUTSIDE,
  PAGE_SIZE,
  QC_RULE_NAMES,
  defaultDirection,
  isFiltered,
  listingHref,
  listingParams,
  type AtlasOption,
  type ListedArea,
  type ListedFlag,
  type ListingQuery,
  type Page,
  type SampleRow,
  type SortDirection,
  type SortKey,
  type SpecimenRow,
} from "../listings.js";
import { sampleHref, specimenHref, type LocalitySuggestion } from "../record.js";
import { ChevronDownIcon } from "./icons.js";
import { methodNamesTrap } from "../../trap-method.js";
import type { Messages } from "../messages/index.js";
import {
  Absent,
  Button,
  Callout,
  Chip,
  DataTable,
  LinkButton,
  EmptyState,
  Field,
  FilterPills,
  HiddenParams,
  FindingDetail,
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
  PlaceEdit,
  FlagChips,
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

/**
 * A row's place, and where its locality is somebody else's to see, a word
 * saying so — so a county standing alone reads as hidden, not as all that
 * was recorded.
 */
function PlaceCell({ m, row }: { m: Messages; row: SampleRow | SpecimenRow }) {
  const place = m.format.place([row.locality, row.county, row.state_province]);
  if (!row.location_withheld) return <OrAbsent value={place} label={m.absence.notRecorded} />;
  if (place === "") return <Absent label={m.listings.locationHidden} spelled />;
  return (
    <>
      {place} · <Meta>{m.listings.locationHidden}</Meta>
    </>
  );
}

/** The listing's 'name<TAB>basis' lines (`locality_choices`), best first. */
function parseLocalityChoices(lines: string | null): LocalitySuggestion[] {
  if (lines === null) return [];
  return lines.split("\n").map((line) => {
    const [locality, basis] = line.split("\t") as [string, LocalitySuggestion["basis"]];
    return { locality, basis };
  });
}

/**
 * Whether the Place cell offers the pencil that changes a sample's locality
 * (beeline-7ywr, Peter 2026-11-04; the editor is `PlaceEdit`), by the sample
 * page's rule (`samplePlaceEdit`). To staff, on a printed sample too, to
 * correct the record before a reprint, except one entered in Beeline, whose
 * own form refuses that. To whoever may edit a sample entered in Beeline,
 * until it prints. To its collector, until it prints, where they have
 * something to choose from and nobody else's locality stands on it.
 */
export function placeEditable(row: SampleRow, admin: boolean): boolean {
  if (row.location_withheld) return false;
  // An entered sample's own form lets its collectors and its enterer write any locality.
  if (row.entered) return !row.printed && (admin || row.mine || row.entered_by_me);
  if (admin) return true;
  if (row.printed) return false;
  return row.mine && !row.locality_set_by_other && (row.locality_choices !== null || row.inat_observation_id !== null);
}

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
 * Whose records: mine, my atlas's, everybody's — for everyone, and two-way
 * for somebody who belongs to no atlas. Other atlases, and the ground
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

/**
 * Above other people's records, for anyone but staff: why some of them say
 * where less precisely than their own do. The lede already says whose.
 */
function ScopeNote({ m, query, admin }: { m: Messages; query: ListingQuery; admin: boolean }) {
  if (query.scope === MINE || admin) return null;
  return <Meta block>{m.listings.scope.withheldNote}</Meta>;
}

/**
 * Every filter cleared, scope, sort and any bulk action left alone: clearing
 * is not signing out of an atlas, not un-sorting, and not abandoning the
 * specimens being ticked for an action.
 *
 * Typed as the whole query minus the parts Clear deliberately keeps, so a
 * filter added to ListingQuery and forgotten here fails to compile. It was
 * spread into a Partial before, which let `member` be missing silently — and
 * a Clear link that clears everything but one box is worse than none.
 */
const emptyFilters: Omit<ListingQuery, "scope" | "page" | "sort" | "dir" | "act"> = {
  q: "",
  from: null,
  to: null,
  place: "",
  area: "",
  collector: "",
  member: MEMBER_ANY,
  taxon: "",
  host: "",
  det: "any",
  year: null,
  labels: "any",
  kind: "any",
  qc: "any",
  flag: "",
};

function activeFilters(
  m: Messages,
  path: string,
  query: ListingQuery,
  atlases: readonly AtlasOption[],
  homeAtlas: AtlasOption | null,
  area: ListedArea | null | undefined,
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
      label: m.listings.scope.program,
      value: query.scope === OUTSIDE || query.scope === CATCH_ALL ? m.listings.scope.outside : atlasName(query.scope),
      clearHref: clear({ scope: ALL }),
    });
  }
  if (query.q !== "") out.push({ label: f.search, value: query.q, clearHref: clear({ q: "" }) });
  if (query.from !== null) out.push({ label: f.from, value: m.format.date(query.from), clearHref: clear({ from: null }) });
  if (query.to !== null) out.push({ label: f.to, value: m.format.date(query.to), clearHref: clear({ to: null }) });
  if (query.place !== "") out.push({ label: f.place, value: query.place, clearHref: clear({ place: "" }) });
  // The one area the Areas page linked here by (beeline-9jd4), by its name;
  // the filter has no box of its own.
  if (query.area !== "") {
    out.push({
      label: m.areas.filter,
      value: area == null ? m.areas.filterUnknown : areaDisplayName(area.name),
      clearHref: clear({ area: "" }),
    });
  }
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
      value: detLabel(f, query.det),
      clearHref: clear({ det: "any" }),
    });
  }
  if (query.year !== null) out.push({ label: f.year, value: String(query.year), clearHref: clear({ year: null }) });
  if (query.labels !== "any") {
    // A sample's labels, or a specimen's own: the same filter in each
    // listing's own words.
    const specimens = path === "/specimens";
    const value =
      query.labels === "waiting"
        ? specimens
          ? f.labelWaiting
          : f.labelsWaiting
        : specimens
          ? f.labelPrinted
          : f.labelsPrinted;
    out.push({ label: f.labels, value, clearHref: clear({ labels: "any" }) });
  }
  if (query.kind !== "any") {
    out.push({
      label: f.method,
      value: query.kind === "net" ? f.methodNet : f.methodTrap,
      clearHref: clear({ kind: "any" }),
    });
  }
  if (query.qc !== "any") {
    const value = {
      flagged: f.qcFlagged,
      blocking: f.qcBlocking,
      warning: f.qcWarning,
      clean: f.qcClean,
      locality: f.qcLocality,
    }[query.qc];
    out.push({ label: f.qc, value, clearHref: clear({ qc: "any" }) });
  }
  if (query.flag !== "") {
    out.push({ label: f.flagKind, value: m.listings.status.flag[query.flag], clearHref: clear({ flag: "" }) });
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


/**
 * The Flags cell (beeline-ik0d, Peter 2026-11-04): the sample's flags as
 * chips (`FlagChips`), blocking first, or a chip saying nothing is flagged.
 */
function FlagsCell({
  m,
  flags,
  sampleId,
  selected,
}: {
  m: Messages;
  flags: readonly ListedFlag[];
  sampleId: number;
  /** The kind the listing is filtered to, shown first so it is never among the hidden (CodeRabbit). */
  selected: string;
}) {
  if (flags.length === 0) return <Chip tone="success">{m.listings.status.clean}</Chip>;
  const ordered = [...flags.filter((f) => f.rule === selected), ...flags.filter((f) => f.rule !== selected)];
  return <FlagChips m={m} flags={ordered} sampleId={sampleId} />;
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
      </p>
    </div>
  );
}

/**
 * What can be done with the listing's rows, immediately above the table
 * they act on (Peter, 2026-10-31): Download for everyone, and on the
 * specimens listing the bulk actions staff choose first (beeline-1kb.23).
 */
function ListingActions({
  m,
  path,
  query,
  total,
  staff,
  children,
}: {
  m: Messages;
  path: string;
  query: ListingQuery;
  total: number;
  /** Staff's file carries the identification of record; anyone else's their own (beeline-kgyd.7). */
  staff: boolean;
  children?: Child;
}) {
  return (
    <div class="row listing-actions">
      {total > 0 && <DownloadMenu m={m} path={path} query={query} staff={staff} />}
      {children}
    </div>
  );
}

/**
 * Download. The samples listing offers a CSV in a menu, with what it holds
 * said inside it rather than as a paragraph above every table (the header's
 * <details class="menu">, so the menus island closes it on a click elsewhere
 * or Escape, and it works without scripting). The specimens listing has one
 * download, the Excel file for editing specimens (beeline-kgyd.5), so it is a
 * button with its note beside it, the way a single file is offered elsewhere.
 */
function DownloadMenu({ m, path, query, staff }: { m: Messages; path: string; query: ListingQuery; staff: boolean }) {
  const d = m.listings.csv;
  if (path === "/specimens") {
    return (
      <>
        <LinkButton href={listingHref(`${path}.xlsx`, query, { page: 1 })} variant="tonal">
          {d.edit}
        </LinkButton>
        <Meta>{staff ? d.editNote : d.editNoteVolunteer}</Meta>
      </>
    );
  }
  const menu = (
    <details class="menu download-menu">
      <summary class="button tonal">
        {d.menu} <ChevronDownIcon />
      </summary>
      <div class="menu-panel">
        <a href={listingHref(`${path}.csv`, query, { page: 1 })}>{d.download}</a>
        <p class="meta download-note">{d.note}</p>
      </div>
    </details>
  );
  // Staff's Excel file for editing samples (beeline-kgyd.4.9), beside the CSV.
  if (path === "/samples" && staff) {
    return (
      <>
        {menu}
        <LinkButton href={listingHref(`${path}.xlsx`, query, { page: 1 })} variant="tonal">
          {d.editSamples}
        </LinkButton>
        <Meta>{d.editSamplesNote}</Meta>
      </>
    );
  }
  return menu;
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
  /** Every program the Atlas column's menu can scope to; the atlases when a caller gives no more. */
  programs?: readonly AtlasOption[];
  /** Whether a staff member is looking: staff see every location, so the note about hidden ones is not theirs. */
  admin: boolean;
  /** The atlas the viewer belongs to, for the scope toggle; null when none is recorded. */
  homeAtlas?: AtlasOption | null;
  /** The collection years there are samples from, newest first, for the year menu. */
  years: readonly number[];
  /** The current collection year as Oregon reads today, for "this collection year". */
  currentYear: number;
}

/**
 * One collection year, where it can be seen (beeline-kgyd.8): the date range
 * under the Date heading's menu was not found. A plain GET form like the
 * search box, so it works without script and the URL says what it chose.
 */
function YearForm({ m, path, query, years }: { m: Messages; path: string; query: ListingQuery; years: readonly number[] }) {
  const f = m.listings.filters;
  // A year in the URL the store has no samples from still shows as chosen.
  const offered = query.year !== null && !years.includes(query.year) ? [query.year, ...years].sort((a, b) => b - a) : years;
  return (
    <form class="year-form" method="get" action={path}>
      <HiddenParams params={listingParams(query)} except={["year"]} />
      <label for="year">{f.year}</label>
      <select id="year" name="year">
        <option value="">{f.yearAny}</option>
        {offered.map((y) => (
          <option value={String(y)} selected={y === query.year}>
            {y}
          </option>
        ))}
      </select>
      <button type="submit" class="outlined compact-button">
        {f.yearGo}
      </button>
    </form>
  );
}

/**
 * Links that set the filters people reach for most (beeline-hkd4). Each
 * layers on what is already chosen, and one in force is a link that takes it
 * away again.
 */
function QuickFilters({ m, path, query, currentYear }: { m: Messages; path: string; query: ListingQuery; currentYear: number }) {
  const q = m.listings.filters.quick;
  const links: Array<[string, Partial<ListingQuery>, Partial<ListingQuery>, boolean]> = [
    [q.thisYear(currentYear), { year: currentYear }, { year: null }, query.year === currentYear],
    [q.notNamed, { det: "undetermined" }, { det: "any" }, query.det === "undetermined"],
    [q.coarse, { det: "coarse" }, { det: "any" }, query.det === "coarse"],
  ];
  return (
    <nav class="quick-filters" aria-label={q.label}>
      {links.map(([label, on, off, inForce]) =>
        inForce ? (
          <a href={listingHref(path, query, { ...off, page: 1 })} aria-current="true">
            {label}
          </a>
        ) : (
          <a href={listingHref(path, query, { ...on, page: 1 })}>{label}</a>
        ),
      )}
    </nav>
  );
}

/** The part above the table that both listings share. */
function Toolbar<Row>({
  copy,
  path,
  props,
  quick = false,
}: {
  copy: { count: (total: number) => string };
  path: string;
  props: ListingProps<Row>;
  /** Whether the one-click filters are offered (the specimens listing's). */
  quick?: boolean;
}) {
  const { m, query, admin } = props;
  const atlases = props.programs ?? props.atlases;
  const homeAtlas = props.homeAtlas ?? null;
  const filters = activeFilters(m, path, query, atlases, homeAtlas, props.page.area);
  return (
    <>
      <ScopeNote m={m} query={query} admin={admin} />
      <div class="listing-toolbar">
        <ScopeToggle m={m} path={path} query={query} homeAtlas={homeAtlas} />
        <SearchForm
          action={path}
          params={listingParams(query)}
          value={query.q}
          label={m.listings.filters.search}
          placeholder={m.listings.filters.searchHint}
        />
        <YearForm m={m} path={path} query={query} years={props.years} />
      </div>
      {quick && <QuickFilters m={m} path={path} query={query} currentYear={props.currentYear} />}
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

type WithAtlases = Shared & { atlases: readonly AtlasOption[] };
type WithPrograms = Shared & { programs: readonly AtlasOption[] };

function collectorsColumn({ m, path, query, label, atlases }: WithAtlases): TableColumn {
  const f = m.listings.filters;
  return column({
    m,
    path,
    query,
    label,
    sort: "collector",
    fields: ["collector", "member"],
    controls: (
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
 * The atlas column narrows by setting scope: any program, or "at large", the
 * ground outside every atlas (beeline-t0rh). "My records" is not here: it is
 * the scope toggle's first position, which is where it is reached.
 */
function atlasColumn({ m, path, query, label, programs }: WithPrograms): TableColumn {
  return column({
    m,
    path,
    query,
    label,
    sort: "atlas",
    fields: ["scope"],
    controls: (
      <SelectField
        id="scope"
        name="scope"
        label={m.listings.scope.program}
        // MM is shown as At large, which finds the same samples; and while
        // the listing is "my records" the menu says so rather than showing
        // All programs, which applying it would widen the listing to.
        value={query.scope === CATCH_ALL ? OUTSIDE : query.scope}
        options={[
          ...(query.scope === MINE ? [[MINE, m.listings.scope.chooseProgram] as const] : []),
          [ALL, m.listings.scope.allPrograms],
          ...programs.map((a) => [a.code, a.name] as const),
          [OUTSIDE, m.listings.scope.outside],
        ]}
      />
    ),
  });
}

const detLabel = (f: Messages["listings"]["filters"], det: ListingQuery["det"]): string =>
  ({
    any: f.detAny,
    determined: f.detDetermined,
    undetermined: f.detUndetermined,
    coarse: f.detCoarse,
    genus: f.detGenus,
    species: f.detSpecies,
    from_genus: f.detFromGenus,
  })[det];

function DetSelect({ m, query }: { m: Messages; query: ListingQuery }) {
  const f = m.listings.filters;
  return (
    <SelectField
      id="det"
      name="det"
      label={f.det}
      value={query.det}
      hint={f.detHint}
      options={[
        ["any", f.detAny],
        ["undetermined", f.detUndetermined],
        ["determined", f.detDetermined],
        ["coarse", f.detCoarse],
        ["genus", f.detGenus],
        ["species", f.detSpecies],
        ["from_genus", f.detFromGenus],
      ]}
    />
  );
}

export function SampleListing(props: ListingProps<SampleRow> & { mayEnterTrapSamples?: boolean }) {
  const { m, query, page, atlases, admin } = props;
  const copy = m.listings.samples;
  const f = m.listings.filters;
  const path = "/samples";
  const col = { m, path, query };
  return (
    <>
      <PageHeader title={copy.heading} lede={lede(copy, query, props.programs ?? atlases)} />
      {props.mayEnterTrapSamples && (
        <p class="row">
          <LinkButton href="/trap-samples/new" variant="tonal">{m.trapSample.enterLink}</LinkButton>
        </p>
      )}
      <Toolbar copy={copy} path={path} props={props} />
      <ListingActions m={m} path={path} query={query} total={page.total} staff={admin}>
        {admin && <a href="/uploads">{m.uploads.linkFromSpecimens}</a>}
      </ListingActions>
      {page.rows.length === 0 ? (
        <EmptyState heading={copy.emptyHeading}>{isFiltered(query) ? copy.emptyFiltered : copy.emptyMine}</EmptyState>
      ) : (
        <>
          <DataTable
            columns={[
              column({ ...col, label: copy.colSample, sort: "number", kind: "number" }),
              dateColumn({ ...col, label: copy.colDate }),
              collectorsColumn({ ...col, label: copy.colCollectors, atlases }),
              placeColumn({ ...col, label: copy.colPlace }),
              hostColumn({ ...col, label: copy.colHost }),
              // Two values, so a filter and no order: sorting would only
              // put one kind first, which the filter does better.
              column({
                ...col,
                label: copy.colMethod,
                sort: null,
                fields: ["kind"],
                controls: (
                  <SelectField
                    id="kind"
                    name="kind"
                    label={f.method}
                    value={query.kind}
                    options={[
                      ["any", f.methodAny],
                      ["net", f.methodNet],
                      ["trap", f.methodTrap],
                    ]}
                  />
                ),
              }),
              // A taxon name only ever matches something already determined,
              // so the gap needs its own control rather than a magic word in
              // the box. On samples both are about the sample's specimens.
              column({
                ...col,
                label: copy.colSpecimens,
                sort: "specimens",
                kind: "number",
                fields: ["taxon", "det", "labels"],
                controls: (
                  <>
                    <TextField id="taxon" name="taxon" label={f.taxon} value={query.taxon} hint={f.taxonHint} />
                    <DetSelect m={m} query={query} />
                    <SelectField
                      id="labels"
                      name="labels"
                      label={f.labels}
                      value={query.labels}
                      hint={f.labelsWaitingHint}
                      options={[
                        ["any", f.labelsAny],
                        ["waiting", f.labelsWaiting],
                        ["printed", f.labelsPrinted],
                      ]}
                    />
                  </>
                ),
              }),
              column({
                ...col,
                label: copy.colStatus,
                sort: "flags",
                kind: "number",
                fields: ["qc", "flag"],
                controls: (
                  <>
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
                        ["locality", f.qcLocality],
                      ]}
                    />
                    {/* One kind of flag, named as its chip is (beeline-ik0d). */}
                    <SelectField
                      id="flag"
                      name="flag"
                      label={f.flagKind}
                      value={query.flag}
                      options={[
                        ["", f.flagKindAny],
                        ...QC_RULE_NAMES.map((rule) => [rule, m.listings.status.flag[rule]] as const).sort(([, a], [, b]) =>
                          a.localeCompare(b),
                        ),
                      ]}
                    />
                  </>
                ),
              }),
              atlasColumn({ ...col, label: copy.colAtlas, programs: props.programs ?? atlases }),
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
                  <span class="inline-edit-text">
                    <PlaceCell m={m} row={row} />
                  </span>
                  {placeEditable(row, admin) && (
                    <PlaceEdit
                      m={m}
                      sampleId={row.sample_id}
                      sampleNumber={row.sample_number}
                      locality={row.locality}
                      county={row.county}
                      stateProvince={row.state_province}
                      observed={row.inat_observation_id === null ? null : row.observed_locality}
                      suggestions={parseLocalityChoices(row.locality_choices)}
                      free={admin || row.entered}
                      printed={row.printed}
                      back={listingHref(path, query)}
                    />
                  )}
                </td>
                <td>
                  {row.host_name === null ? (
                    <Absent label={m.absence.none} />
                  ) : (
                    <>
                      <TaxonName rank={row.host_rank ?? ""} scientificName={row.host_name} vernacular={row.host_common_name} />
                      {methodNamesTrap(row.protocol) && <Meta block>{f.nearTrap}</Meta>}
                    </>
                  )}
                </td>
                <td>{row.kind === "trap" ? f.methodTrap : f.methodNet}</td>
                <td>
                  {m.format.number(row.specimen_count)}
                  {row.labels_waiting > 0 && (
                    <>
                      {" "}
                      · <Meta>{f.labelsWaitingCount(row.labels_waiting)}</Meta>
                    </>
                  )}
                </td>
                <td>
                  <FlagsCell
                    m={m}
                    flags={page.findings?.get(row.sample_id) ?? []}
                    sampleId={row.sample_id}
                    selected={query.flag}
                  />
                </td>
                <td>
                  <OrAbsent value={row.atlas_abbreviation} label={copy.atlasOutside} spelled />
                </td>
                {/* Links out, not a value: empty when there is nothing to offer. */}
                <td class="actions">
                  {row.observation_gone ? null : row.inat_observation_id !== null ? (
                    // Not where iNaturalist no longer has it: the link would
                    // open a page that is not there (beeline-wcc6).
                    <a
                      class="inat-link"
                      href={`https://www.inaturalist.org/observations/${row.inat_observation_id}`}
                      title={copy.viewOnInat}
                    >
                      <img src="/static/inat-logo.png" alt={copy.viewOnInat} width="66" height="12" />
                    </a>
                  ) : (
                    // No observation to fix upstream: an old Beeline record is
                    // corrected here by its collectors (ADR 0004, beeline-2c3.8).
                    !row.entered && row.mine && <a href={`/samples/${row.sample_id}/edit`}>{copy.edit}</a>
                  )}
                  {/* A sample entered in Beeline has its own form, for staff, its
                      collectors and its enterer (beeline-3vs.5), whatever an
                      observation linked to it later says. */}
                  {row.entered && !row.printed && (admin || row.mine || row.entered_by_me) && (
                    <a href={`/samples/${row.sample_id}/trap`}>{copy.edit}</a>
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

/** The form the specimens listing's tick boxes belong to (beeline-1kb.23). */
const BULK_FORM = "reprint-bulk";

/**
 * What a reader can do to many rows at once, offered before any row is
 * ticked (beeline-1kb.23, Peter 2026-10-31: bulk actions are chosen first).
 * Each is a button naming the action; pressing it puts the listing in that
 * action's mode, in the URL. Only staff have one so far: marking labels for
 * reprint. A volunteer's counterpart is a ticket (beeline-l7ui) and will
 * join this row when tickets exist.
 */
function BulkActions({ m, path, query }: { m: Messages; path: string; query: ListingQuery }) {
  const b = m.listings.specimens.bulk;
  return (
    <LinkButton href={listingHref(path, query, { act: "reprint" })} variant="tonal">
      {b.start}
    </LinkButton>
  );
}

/**
 * The reprint action's mode, above the table: what it is for, and the way
 * out. Leaving keeps the ticks for this tab, so coming back resumes; the bar
 * below has Untick all.
 */
function BulkModeNote({ m, path, query }: { m: Messages; path: string; query: ListingQuery }) {
  const b = m.listings.specimens.bulk;
  return (
    <Callout>
      <strong>{b.modeHeading}</strong> {b.modeIntro}{" "}
      <a href={listingHref(path, query, { act: "" })}>{b.leave}</a>
    </Callout>
  );
}

/**
 * Marking the ticked specimens for reprint: the bar under the table, held at
 * the foot of the window, which the tick boxes in the rows belong to by their
 * `form` attribute. Shown for as long as the mode is on, so what ticking is
 * for is said before anything is ticked. Without scripting it marks what is
 * ticked on this page; the bulk-select island keeps ticks across pages and
 * filters, counts them, and holds the button until something is ticked.
 */
function BulkReprint({ m, back, owner }: { m: Messages; back: string; owner: string }) {
  const b = m.listings.specimens.bulk;
  const reasons = m.printRuns.reprintReason;
  return (
    <form
      id={BULK_FORM}
      method="post"
      action="/specimens/reprint"
      class="card bulk-bar"
      data-bulk="reprint"
      data-bulk-owner={owner}
      data-count-none={b.countNone}
      data-count-one={b.countOne}
      data-count-other={b.countOther}
    >
      <input type="hidden" name="back" value={back} />
      {/* One row, so the bar covers as few of the rows being ticked as it can. */}
      <div class="bulk-fields">
        <strong data-bulk-count=""></strong>
        <SelectField
          id="bulk-reason"
          name="reason"
          label={m.record.specimen.reprint.reason}
          value=""
          options={[["", m.record.specimen.reprint.noReason], ...Object.entries(reasons).map(([k, v]) => [k, v] as const)]}
        />
        <TextField id="bulk-note" name="note" label={m.record.specimen.reprint.note} />
        <Button>{b.button}</Button>
        <button type="button" class="outlined" data-bulk-clear="" hidden>
          {b.clear}
        </button>
      </div>
      <Meta block>{b.hint}</Meta>
    </form>
  );
}

export function SpecimenListing(
  props: ListingProps<SpecimenRow> & {
    /** What the last bulk marking did, read back off its redirect. */
    reprinted?: { requested: number; of: number } | null;
    /** Who is signed in, which keys the island's stored ticks: a tab outlives a sign-out. */
    bulkOwner?: string;
  },
) {
  const { m, query, page, atlases, admin, reprinted = null, bulkOwner = "" } = props;
  const copy = m.listings.specimens;
  const f = m.listings.filters;
  const path = "/specimens";
  const col = { m, path, query };
  // The reprint action's mode (query.act, cleared by the route for anyone
  // but staff): a tick column, whose heading box ticks every row on the page
  // that can be marked and is drawn hidden for the island to reveal.
  const marking = query.act === "reprint";
  const tickColumn = (
    <input type="checkbox" data-bulk-page="" aria-label={copy.bulk.tickPage} hidden />
  );
  return (
    <>
      <PageHeader
        title={copy.heading}
        lede={
          query.scope === MINE ? (
            <>
              {copy.ledeMine} <a href="/determinations">{copy.identify}</a>
            </>
          ) : (
            lede(copy, query, props.programs ?? atlases)
          )
        }
      />
      {reprinted !== null && <Callout tone="success">{copy.bulk.done(reprinted.requested, reprinted.of)}</Callout>}
      <Toolbar copy={copy} path={path} props={props} quick />
      {/* Immediately above the table, since they act on its rows (Peter,
          2026-10-31). While an action is chosen its note takes the row's place. */}
      {marking ? (
        <BulkModeNote m={m} path={path} query={query} />
      ) : (
        <ListingActions m={m} path={path} query={query} total={page.total} staff={admin}>
          {admin && <BulkActions m={m} path={path} query={query} />}
          {path === "/specimens" && <a href="/uploads">{m.uploads.linkFromSpecimens}</a>}
        </ListingActions>
      )}
      {page.rows.length === 0 ? (
        <EmptyState heading={copy.emptyHeading}>{isFiltered(query) ? copy.emptyFiltered : copy.emptyMine}</EmptyState>
      ) : (
        <>
          <DataTable
            columns={[
              ...(marking ? [tickColumn] : []),
              // The number is what the label carries, so whether it is on
              // paper yet is asked here (beeline-3v33).
              column({
                ...col,
                label: copy.colFieldNumber,
                sort: "field",
                kind: "number",
                fields: ["labels"],
                controls: (
                  <SelectField
                    id="labels"
                    name="labels"
                    label={f.labels}
                    value={query.labels}
                    options={[
                      ["any", f.labelsAny],
                      ["waiting", f.labelWaiting],
                      ["printed", f.labelPrinted],
                    ]}
                  />
                ),
              }),
              column({ ...col, label: copy.colSample, sort: "number", kind: "number" }),
              dateColumn({ ...col, label: copy.colDate }),
              collectorsColumn({ ...col, label: copy.colCollectors, atlases }),
              placeColumn({ ...col, label: copy.colPlace }),
              hostColumn({ ...col, label: copy.colHost }),
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
              // When it was determined: an order and no filter, since the
              // question it answers — what came back from the taxonomist
              // this winter — is asked by sorting, not by a window.
              column({ ...col, label: copy.colDetermined, sort: "determined", kind: "date" }),
              atlasColumn({ ...col, label: copy.colAtlas, programs: props.programs ?? atlases }),
            ]}
          >
            {page.rows.map((row) => (
              <tr>
                {marking && (
                  <td>
                    {/* A row the action cannot take says why, instead of a
                        box that would only be refused after pressing. */}
                    {row.reprint_blocker === null ? (
                      <input
                        type="checkbox"
                        name="specimen"
                        value={String(row.specimen_id)}
                        form={BULK_FORM}
                        data-bulk-row=""
                        aria-label={copy.bulk.tickOne(row.field_number ?? String(row.specimen_number))}
                      />
                    ) : (
                      <Meta>{copy.bulk.blocker[row.reprint_blocker]}</Meta>
                    )}
                  </td>
                )}
                <td>
                  <Pill href={specimenHref(row.specimen_id)} mono={row.field_number !== null}>
                    {row.field_number !== null
                      ? row.field_number
                      : row.awaiting_number
                        ? copy.awaitingNumber
                        : copy.noFieldNumber}
                  </Pill>
                  {/* While marking, the tick column already says so. */}
                  {row.reprint_requested && !marking && <Meta block>{copy.reprintRequested}</Meta>}
                </td>
                <td>
                  <Pill href={sampleHref(row.sample_id)}>{row.sample_number}</Pill>
                </td>
                <td class="nowrap">{m.format.date(row.date_start)}</td>
                <td>{m.format.list((page.collectors.get(row.sample_id) ?? []).map((c) => c.label))}</td>
                <td>
                  <PlaceCell m={m} row={row} />
                </td>
                <td>
                  {/* As on the samples listing: a bee off no flower has no
                      host, and that is complete rather than missing. */}
                  {row.host_name === null ? (
                    <Absent label={m.absence.none} />
                  ) : (
                    <>
                      <TaxonName rank={row.host_rank ?? ""} scientificName={row.host_name} vernacular={row.host_common_name} />
                      {methodNamesTrap(row.protocol) && <Meta block>{f.nearTrap}</Meta>}
                    </>
                  )}
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
                <td class="nowrap">
                  {/* The dash: most legacy determinations carry no date, so
                      the words would be noise down the column; the specimen
                      page spells it. */}
                  {row.determined_on === null ? (
                    <Absent label={m.absence.none} />
                  ) : (
                    m.format.datePrecise(row.determined_on, row.determined_on_precision)
                  )}
                </td>
                <td>
                  <OrAbsent value={row.atlas_abbreviation} label={m.listings.samples.atlasOutside} spelled />
                </td>
              </tr>
            ))}
          </DataTable>
          <ListingPager m={m} path={path} query={query} total={page.total} />
        </>
      )}
      {/* Drawn on an empty listing too: ticks kept from other pages can
          still be marked or cleared from a filter that matches nothing. */}
      {marking && <BulkReprint m={m} back={listingHref(path, query)} owner={bulkOwner} />}
    </>
  );
}
