import type { Child } from "hono/jsx";
import { ColumnMenu, type ColumnMenuSpec } from "./listing.js";

/**
 * A column with more to it than a heading: a menu to sort or filter by, or
 * a heading that is read aloud and never shown (a column of links out).
 */
export interface TableColumn {
  label: string;
  /** Sort orders and a filter, opened from the heading. */
  menu?: ColumnMenuSpec;
  /** The heading is this accessible name only; nothing is drawn. */
  hidden?: boolean;
}

const isSpec = (column: Child | TableColumn): column is TableColumn =>
  typeof column === "object" && column !== null && "label" in column && !("tag" in column);

/**
 * A table that survives a phone.
 *
 * Wide tables scroll inside their own wrapper rather than making the page
 * scroll sideways, and a min-width keeps columns readable instead of
 * crushed. Every table in the app goes through here, so that behavior is
 * not something a screen can forget.
 *
 * The heading row is the table's too. A column is a plain heading, or a
 * TableColumn: the table draws the menu, the one mark that says a menu is
 * there, and the `aria-sort` that says which column orders the rows — so a
 * listing describes its columns and cannot draw them differently from the
 * next one.
 */
export function DataTable({
  columns,
  children,
}: {
  /** Heading cells. A column with no heading (an actions column) passes "". */
  columns: ReadonlyArray<Child | TableColumn>;
  /** The `<tr>` rows. */
  children: Child;
}) {
  return (
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((column) => {
              if (!isSpec(column)) return <th>{column}</th>;
              if (column.hidden) return <th aria-label={column.label} />;
              if (column.menu === undefined) return <th>{column.label}</th>;
              const current = column.menu.sort?.current ?? null;
              return current === null ? (
                <th>
                  <ColumnMenu label={column.label} spec={column.menu} />
                </th>
              ) : (
                <th aria-sort={current === "asc" ? "ascending" : "descending"}>
                  <ColumnMenu label={column.label} spec={column.menu} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
