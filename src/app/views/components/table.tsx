import type { Child } from "hono/jsx";

/**
 * A table that survives a phone.
 *
 * Wide tables scroll inside their own wrapper rather than making the page
 * scroll sideways, and a min-width keeps columns readable instead of
 * crushed. Every table in the app goes through here, so that behavior is
 * not something a screen can forget.
 */
export function DataTable({
  columns,
  children,
  rawHeader = false,
}: {
  /** Header cells. A column with no heading (an actions column) passes "". */
  columns: ReadonlyArray<Child>;
  /** The `<tr>` rows. */
  children: Child;
  /** The columns are already `<th>` elements — a listing whose headings carry menus. */
  rawHeader?: boolean;
}) {
  return (
    <div class="table-scroll">
      <table>
        <thead>
          <tr>{rawHeader ? columns : columns.map((c) => <th>{c}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
