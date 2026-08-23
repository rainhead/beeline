import type { Child } from "hono/jsx";

/**
 * Status in one word.
 *
 * Tone names the *domain* meaning, not the color: `blocking` is "this stops
 * a label being printed", not "this is red". The mapping from tone to MD3
 * role lives in components.css, so re-seeding the palette cannot change what
 * a chip means. See /design/color.
 */
export type Tone = "neutral" | "blocking" | "warning" | "success";

export function Chip({ tone = "neutral", children }: { tone?: Tone; children: Child }) {
  return <span class={tone === "neutral" ? "chip" : `chip ${tone}`}>{children}</span>;
}

export const TONES: Tone[] = ["neutral", "blocking", "warning", "success"];
