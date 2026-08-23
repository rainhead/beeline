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
export function PageHeader({ title, lede, meta }: { title: Child; lede?: Child; meta?: Child }) {
  return (
    <div class="page-header">
      <h1>{title}</h1>
      {lede !== undefined && <p>{lede}</p>}
      {meta !== undefined && <Meta block>{meta}</Meta>}
    </div>
  );
}
