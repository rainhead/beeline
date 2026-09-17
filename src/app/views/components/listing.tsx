import type { Child } from "hono/jsx";
import { SearchIcon } from "../icons.js";

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
    <div class="active-filters" aria-label={groupLabel}>
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

/**
 * A column heading that opens a menu: how to sort by this column, and the
 * filter that narrows on it (Peter, 2026-09-16: the filter area was a wall
 * of boxes, and a person filtering a table looks at the column). The same
 * <details class="menu"> the header uses, so the menus island gives it
 * dismissal and one-at-a-time for free; the panel is fixed-positioned so
 * the table's own horizontal scroll cannot clip it.
 *
 * `sorted` is the direction this column is currently ordering the table by,
 * shown in the heading so the order is visible without opening anything.
 */
export function ColumnMenu({
  label,
  menuLabel,
  sorted,
  children,
}: {
  label: Child;
  /** The accessible name for the toggle: "Date options". */
  menuLabel: string;
  sorted?: "asc" | "desc" | null;
  children: Child;
}) {
  return (
    <details class="menu col-menu">
      <summary aria-label={menuLabel}>
        {label}
        <span class="col-sort" aria-hidden="true">
          {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "▾"}
        </span>
      </summary>
      <div class="menu-panel">{children}</div>
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
