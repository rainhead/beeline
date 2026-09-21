import type { Child } from "hono/jsx";

/**
 * Text-shaped components: the page's opening block, and the secondary line
 * that annotates something else.
 */

/**
 * Secondary text that qualifies a neighbour — the place and specimen count
 * under a sample title, a job's description under its name, the last sync
 * time under a summary. Before it had a name this treatment was retyped as
 * an inline style in five places.
 */
export function Meta({ children, block }: { children: Child; block?: boolean }) {
  return block ? <p class="meta">{children}</p> : <span class="meta">{children}</span>;
}

/**
 * Every page opens the same way: a title, an optional sentence saying what
 * this screen is for, and optional meta beneath it.
 */
export function PageHeader({
  title,
  lede,
  meta,
  mark,
}: {
  title: Child;
  lede?: Child;
  meta?: Child;
  /** An atlas mark set beside the text, where the page is about someone in that atlas. */
  mark?: Child;
}) {
  const text = (
    <>
      <h1>{title}</h1>
      {lede !== undefined && <p>{lede}</p>}
      {meta !== undefined && <Meta block>{meta}</Meta>}
    </>
  );
  if (mark === undefined || mark === null) return <div class="page-header">{text}</div>;
  return (
    <div class="page-header page-header-marked">
      <div>{text}</div>
      {mark}
    </div>
  );
}

/**
 * A value that is not there.
 *
 * The app drew absence three ways — words in one place, a bare em dash in
 * another, an empty cell in a third — and an empty cell is the worst of
 * them, because nobody can tell "there is none" from "it failed to load"
 * (Nora, 2026-09-17). So absence is a component, with one rule:
 *
 * - **Never blank.** Every absence is drawn.
 * - **Every absence means something, and says so.** `label` is that meaning,
 *   in the catalog's words — "not determined", "never", "outside the
 *   atlases" — and it is always there for a screen reader.
 * - **Spelled out where it is the exception, or tells the reader something**
 *   (`spelled`): "not determined" on a specimen, "obscured" for coordinates,
 *   "No account" on a person. **An em dash where the same absence repeats
 *   down a dense column** and the words would be noise: a job that breached
 *   nothing, a person with no membership recorded.
 * - **Secondary text either way**, so an absence never reads as a value.
 *
 * What is *not* an absence stays a value: a count of 0 is a number, and a
 * floral host row left off a record page because the bee was taken off no
 * flower is DetailList's call, not this component's.
 */
export function Absent({ label, spelled = false }: { label: string; spelled?: boolean }) {
  return spelled ? (
    <span class="meta absent">{label}</span>
  ) : (
    <span class="meta absent">
      <span aria-hidden="true">—</span>
      <span class="visually-hidden">{label}</span>
    </span>
  );
}

/** A value, or its absence: the common case of a nullable string in a cell. */
export function OrAbsent({
  value,
  label,
  spelled = false,
}: {
  value: Child | null | undefined;
  label: string;
  spelled?: boolean;
}) {
  return value === null || value === undefined || value === "" ? <Absent label={label} spelled={spelled} /> : <>{value}</>;
}
