import { SEED_COLOR } from "../../theme/tokens.js";
import { DESIGN_SECTIONS, DesignPage } from "./shell.js";

/**
 * The masthead: what this system is, and the four facts you need before
 * reading any section of it.
 */
export function DesignIndex() {
  return (
    <DesignPage current="/design" title="Beeline design system">
      <div class="masthead">
        <p>
          The design system behind the data spine of the Master Melittology program: the site volunteers use to see
          what needs fixing in their own collecting records, and the one staff use to run ingestion and print labels.
          A dense tool for people who are not looking at it for pleasure — legibility first, decoration last.
        </p>
        <div class="masthead-facts">
          <div>
            <h4>Canonical source</h4>
            <p>
              This page. There is no separate brand document and no Figma file: every specimen here renders from the
              real stylesheets and the real generated palette, so the system cannot drift from what ships.
            </p>
          </div>
          <div>
            <h4>Core type</h4>
            <p>
              <code>system-ui</code> throughout — weight carries hierarchy, family never does. Monospace means a
              machine value and nothing else.
            </p>
          </div>
          <div>
            <h4>Anchors</h4>
            <p>
              One seed color, <code>{SEED_COLOR}</code> (honey gold), from which the whole Material 3 palette is
              generated in light and dark. Per-atlas colorways re-seed it.
            </p>
          </div>
          <div>
            <h4>Surfaces</h4>
            <p>
              The QC home a volunteer lands on, sample editing, the glossary, and the staff surfaces — scheduled jobs
              and this system. Label printing, determinations, and exports are ahead of us.
            </p>
          </div>
        </div>
      </div>

      <h2>Sections</h2>
      <ul>
        {DESIGN_SECTIONS.filter((s) => s.path !== "/design").map((s) => (
          <li>
            <a href={s.path}>{s.label}</a>
          </li>
        ))}
      </ul>

      <h2>What this system is for</h2>
      <p>
        Two things. First, so a new screen inherits decisions instead of re-deriving them — before this existed, the
        same "small secondary text" treatment had been retyped as an inline style in five places, each subtly
        different. Second, so design changes get proofed here, against every state, before any real screen wears them.
      </p>
      <p>
        It is deliberately not aspirational. Where we have no answer — no logo, no atlas colorways, no bespoke icons —
        the section says so and links the issue, rather than describing something that does not exist.
      </p>
    </DesignPage>
  );
}
