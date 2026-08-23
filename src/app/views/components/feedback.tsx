import type { Child } from "hono/jsx";
import type { Tone } from "./chip.js";

/**
 * Asides and absences.
 */

/**
 * A callout is an aside: why this screen behaves the way it does, when the
 * data was last refreshed, what will happen next. It is not an alert — it
 * never interrupts, and it carries no icon.
 */
export function Callout({ tone = "neutral", children }: { tone?: Tone; children: Child }) {
  return <div class={tone === "neutral" ? "callout" : `callout ${tone}`}>{children}</div>;
}

/**
 * An empty state says what would be here and why it isn't — never an
 * apology, never a bare dash. "Nothing needs your attention" is a result,
 * so it gets a heading and a reason, the same as a page with content
 * (/design/voice).
 */
export function EmptyState({ heading, children }: { heading?: Child; children: Child }) {
  return (
    <div class="empty">
      {heading !== undefined && <h3>{heading}</h3>}
      <p>{children}</p>
    </div>
  );
}
