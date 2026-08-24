import type { Child } from "hono/jsx";

/**
 * The furniture a long list needs: the filter bar above it and the pager
 * below it. Both are plain GET forms and plain links — a listing works with
 * scripting off, and its state is always in the URL.
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
 * Where you are in a long list, and how to move. Numbered pages are
 * deliberately absent: with tens of thousands of rows the number of a page
 * means nothing, while "of 1,340" tells you to go back and filter.
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
  /** Null at the ends of the list: a dead control is not rendered. */
  previousHref: string | null;
  nextHref: string | null;
  previousLabel: Child;
  nextLabel: Child;
}) {
  if (previousHref === null && nextHref === null) return null;
  return (
    <nav class="pager">
      {previousHref !== null ? <a href={previousHref}>{previousLabel}</a> : <span />}
      <span class="meta">{summary}</span>
      {nextHref !== null ? <a href={nextHref}>{nextLabel}</a> : <span />}
    </nav>
  );
}
