import type { Child } from "hono/jsx";
import type { Messages } from "../../messages/index.js";

/** The anchor slugs on /glossary — a renamed key breaks every link to it. */
export type GlossarySlug = keyof Messages["glossary"]["entries"];

/**
 * Links a technical word to its definition.
 *
 * The rule this exists to enable: gloss on first use *by linking*, not by
 * re-explaining. Copy that stops to define "geoprivacy" every time it says
 * it gets long and still leaves out the people who needed the definition on
 * a different screen. See /design/voice.
 */
export function Term({ m, slug, children }: { m: Messages; slug: GlossarySlug; children?: Child }) {
  return (
    <a class="term" href={`/glossary#${slug}`}>
      {children ?? m.glossary.entries[slug].term.toLowerCase()}
    </a>
  );
}
