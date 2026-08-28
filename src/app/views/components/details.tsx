import type { Child } from "hono/jsx";

/**
 * The facts about one thing, as a labelled list.
 *
 * A listing puts a column heading above many values; a record page puts a
 * label beside one, and that is a different treatment rather than a
 * one-column table. Real `<dl>` markup, so a screen reader announces the
 * label with its value.
 *
 * A null entry is dropped, so a caller decides row by row whether an absence
 * is worth saying. Both readings are right somewhere: "Elevation —" on a
 * sample that should have one is the gap made visible, while a floral-host
 * row on a sample taken off no flower would invent a gap that is not there.
 */
export interface Detail {
  term: Child;
  value: Child;
}

export function DetailList({ items }: { items: ReadonlyArray<Detail | null> }) {
  return (
    <dl class="details">
      {items.map((item) =>
        item === null ? null : (
          <>
            <dt>{item.term}</dt>
            <dd>{item.value}</dd>
          </>
        ),
      )}
    </dl>
  );
}
