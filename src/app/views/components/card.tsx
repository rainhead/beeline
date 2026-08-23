import type { Child } from "hono/jsx";

/**
 * Cards frame anything that isn't a table row — a sample and its findings,
 * a proofing exhibit. Outlined, never elevated: this design has no shadows
 * outside the header dropdowns (/design/space).
 *
 * Consecutive cards space themselves (`.card + .card`), so callers never set
 * a margin.
 */
export function Card({ children, as = "div" }: { children: Child; as?: "div" | "article" | "section" }) {
  const Tag = as;
  return <Tag class="card">{children}</Tag>;
}
