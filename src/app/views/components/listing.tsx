import type { Child } from "hono/jsx";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, SearchIcon } from "../icons.js";
import { Button } from "./button.js";

/**
 * The furniture a long list needs: the filter bar above it, the column
 * menus in its header, and the pager below it. All plain GET forms and plain
 * links — a listing works with scripting off, and its state is always in
 * the URL.
 */

/**
 * The filter bar. A GET form, so submitting writes the filters into the
 * query string and the resulting page is a link a person can send someone.
 * Fields flow into as many columns as fit; the actions row always ends up
 * last.
 */
export function FilterBar({ action, children, actions }: { action: string; children: Child; actions: Child }) {
  return (
    <form class="filters" method="get" action={action}>
      {children}
      <div class="filter-actions">{actions}</div>
    </form>
  );
}

/**
 * A query as hidden inputs, minus the parameters a form is about to set, so
 * submitting the form keeps every other filter. Page is always dropped: a
 * changed filter starts from the first page.
 */
export function HiddenParams({ params, except }: { params: URLSearchParams; except: ReadonlyArray<string> }) {
  const skip = new Set<string>([...except, "page"]);
  return (
    <>
      {[...params.entries()]
        .filter(([name]) => !skip.has(name))
        .map(([name, value]) => (
          <input type="hidden" name={name} value={value} />
        ))}
    </>
  );
}

/** The search box: the one filter that is not about a column. */
export function SearchForm({
  action,
  params,
  value,
  label,
  placeholder,
}: {
  action: string;
  /** The rest of the query, carried through. */
  params: URLSearchParams;
  value: string;
  label: string;
  placeholder: string;
}) {
  return (
    <form class="search" role="search" method="get" action={action}>
      <HiddenParams params={params} except={["q"]} />
      <input type="search" name="q" value={value} placeholder={placeholder} aria-label={label} />
      <button type="submit" aria-label={label}>
        <SearchIcon />
      </button>
    </form>
  );
}

/** One filter in force: what to call it, what it says, and the listing without it. */
export interface FilterPill {
  label: string;
  value: string;
  clearHref: string;
}

/** The filters in force, each dismissable, and one link that clears them all. */
export function FilterPills({
  filters,
  clearAllHref,
  clearAllLabel,
  groupLabel,
  removeLabel,
}: {
  filters: readonly FilterPill[];
  /** Null when there is nothing to clear beyond the pills themselves. */
  clearAllHref: string | null;
  clearAllLabel: string;
  groupLabel: string;
  removeLabel: (filter: string) => string;
}) {
  if (filters.length === 0) return null;
  return (
    <div class="active-filters" role="group" aria-label={groupLabel}>
      {filters.map((filter) => (
        <span class="chip">
          {filter.label}: {filter.value}{" "}
          <a href={filter.clearHref} aria-label={removeLabel(filter.label)} class="chip-remove">
            ×
          </a>
        </span>
      ))}
      {clearAllHref !== null && <a href={clearAllHref}>{clearAllLabel}</a>}
    </div>
  );
}

/** A record's number as a pill: a click target a finger can hit (Peter, 2026-09-16). */
export function Pill({ href, mono, children }: { href: string; mono?: boolean; children: Child }) {
  return (
    <a href={href} class={mono ? "pill mono" : "pill"}>
      {children}
    </a>
  );
}

/** The order a column offers, and which of the two is in force. */
export interface ColumnSort {
  /** The direction this column is ordering the table by now; null when it is not. */
  current: "asc" | "desc" | null;
  ascHref: string;
  descHref: string;
  /** Named for what the values are: "A to Z", "Oldest first", "Lowest first". */
  ascLabel: string;
  descLabel: string;
}

/** The filter a column offers: a GET form that keeps the rest of the query. */
export interface ColumnFilter {
  action: string;
  /** The whole current query; the form carries it as hidden inputs. */
  params: URLSearchParams;
  /** The parameters this form sets itself, left out of the hidden ones. */
  fields: ReadonlyArray<string>;
  applyLabel: string;
  /** The form's controls. */
  controls: Child;
}

export interface ColumnMenuSpec {
  /** The accessible name of the toggle: "Date: sort and filter". */
  menuLabel: string;
  sort?: ColumnSort;
  filter?: ColumnFilter;
}

/**
 * A column heading that opens a menu: how to sort by this column, and the
 * filter that narrows on it (Peter, 2026-09-16: the filter area was a wall
 * of boxes, and a person filtering a table looks at the column). The same
 * <details class="menu"> the header uses, so the menus island gives it
 * dismissal and one-at-a-time for free; the panel is fixed-positioned so
 * the table's own horizontal scroll cannot clip it.
 *
 * One component, fed data, because it was written out twice — once for the
 * record listings and once for People — and the two had already drifted
 * (Peter, 2026-09-17). Every menu wears the same mark, a chevron at a size
 * that reads; the order in force is a separate arrow beside the label, so
 * "there is a menu here" and "the table is sorted by this" are never the
 * same glyph doing two jobs. DataTable renders this from a column's spec
 * and puts `aria-sort` on the heading cell.
 */
export function ColumnMenu({ label, spec }: { label: Child; spec: ColumnMenuSpec }) {
  const { sort, filter } = spec;
  return (
    <details class="menu col-menu">
      <summary aria-label={spec.menuLabel}>
        <span>{label}</span>
        {sort?.current === "asc" && <ArrowUpIcon />}
        {sort?.current === "desc" && <ArrowDownIcon />}
        <ChevronDownIcon />
      </summary>
      <div class="menu-panel">
        {sort !== undefined && (
          <div class="menu-section">
            {sort.current === "asc" ? (
              <a href={sort.ascHref} aria-current="true">
                {sort.ascLabel}
              </a>
            ) : (
              <a href={sort.ascHref}>{sort.ascLabel}</a>
            )}
            {sort.current === "desc" ? (
              <a href={sort.descHref} aria-current="true">
                {sort.descLabel}
              </a>
            ) : (
              <a href={sort.descHref}>{sort.descLabel}</a>
            )}
          </div>
        )}
        {filter !== undefined && (
          <form method="get" action={filter.action} class="col-filter">
            <HiddenParams params={filter.params} except={filter.fields} />
            {filter.controls}
            <Button>{filter.applyLabel}</Button>
          </form>
        )}
      </div>
    </details>
  );
}

/**
 * Where you are in a long list, and how to move. Numbered pages are
 * deliberately absent: with tens of thousands of rows the number of a page
 * means nothing, while "of 1,340" tells you to go back and filter. The three
 * sit together in the middle of the page, the summary set like the links
 * (Peter, 2026-09-16); a dead direction keeps its place, greyed, so the
 * summary does not jump when you reach an end.
 */
export function Pager({
  summary,
  previousHref,
  nextHref,
  previousLabel,
  nextLabel,
}: {
  /** "Page 3 of 1,340" — built by the caller, from the catalog. */
  summary: Child;
  /** Null at the ends of the list. */
  previousHref: string | null;
  nextHref: string | null;
  previousLabel: Child;
  nextLabel: Child;
}) {
  if (previousHref === null && nextHref === null) return null;
  return (
    <nav class="pager">
      {previousHref !== null ? (
        <a href={previousHref}>{previousLabel}</a>
      ) : (
        <span class="pager-end" aria-hidden="true">
          {previousLabel}
        </span>
      )}
      <span>{summary}</span>
      {nextHref !== null ? (
        <a href={nextHref}>{nextLabel}</a>
      ) : (
        <span class="pager-end" aria-hidden="true">
          {nextLabel}
        </span>
      )}
    </nav>
  );
}
