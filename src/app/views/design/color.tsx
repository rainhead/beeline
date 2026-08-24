import { Callout, Chip, TONES } from "../components/index.js";
import { SEED_COLOR } from "../../theme/tokens.js";
import { DesignPage, DoDont, Reference, Specimen } from "./shell.js";

/** MD3 role pairs, background then the foreground that is legal on it. */
const COLOR_ROLES = [
  ["primary", "on-primary"],
  ["primary-container", "on-primary-container"],
  ["secondary", "on-secondary"],
  ["secondary-container", "on-secondary-container"],
  ["tertiary", "on-tertiary"],
  ["tertiary-container", "on-tertiary-container"],
  ["surface", "on-surface"],
  ["surface-variant", "on-surface-variant"],
  ["background", "on-background"],
] as const;

const SEMANTIC_ROLES = [
  ["error", "on-error"],
  ["error-container", "on-error-container"],
  ["warning", "on-warning"],
  ["warning-container", "on-warning-container"],
  ["success", "on-success"],
  ["success-container", "on-success-container"],
] as const;

function Swatches({ roles }: { roles: ReadonlyArray<readonly [string, string]> }) {
  return (
    <div class="swatches">
      {roles.map(([bg, fg]) => (
        <div
          class="swatch"
          style={`background: var(--md-sys-color-${bg}); color: var(--md-sys-color-${fg})`}
        >
          {bg}
          <small>{fg}</small>
        </div>
      ))}
    </div>
  );
}

export function DesignColor() {
  return (
    <DesignPage
      current="/design/color"
      title="Color"
      lede="One seed generates everything. No stylesheet in this app names a hex value; they name roles, and roles are generated."
    >
      <h2>Where the palette comes from</h2>
      <p>
        <code>src/app/theme/tokens.ts</code> holds a single seed — <code>{SEED_COLOR}</code>, honey gold — and Material
        3 derives the full light and dark schemes from it at startup, served as <code>/tokens.css</code>. Change the
        seed and the entire product follows, including this page. That is the whole colour system: there is no second
        source of truth, and no hand-picked accent anywhere.
      </p>
      <p>
        Flip your operating system between light and dark now. Everything below should stay legible without you
        thinking about it — that is what the paired <code>on-</code> roles are for, and pairing them any other way is
        the one colour mistake this system cannot catch for you.
      </p>

      <h2>Roles</h2>
      <Swatches roles={COLOR_ROLES} />

      <h2>Semantic states</h2>
      <p>
        MD3 generates <code>error</code> and stops. Beeline needs three more distinctions, so <code>warning</code> and{" "}
        <code>success</code> are declared as custom colours and <em>harmonized</em> toward the seed — derived like
        everything else, not pasted in.
      </p>
      <Swatches roles={SEMANTIC_ROLES} />

      <h2>What the states mean here</h2>
      <p>Tone names a domain meaning, never a colour. A screen asks for "blocking", not "red".</p>
      <Reference
        rows={[
          ["blocking", "This stops a label being printed. The volunteer cannot proceed until it is fixed."],
          ["warning", "A heads-up: worth fixing, holds nothing up. QC calls these warnings; volunteers see “heads-up”."],
          ["success", "A thing that finished, or a state that is clean — a job that succeeded, a sample with no flags."],
          ["neutral", "Information with no valence: a count, a status that is neither good nor bad."],
        ]}
      />
      <Specimen>
        <p class="row">
          {TONES.map((tone) => (
            <Chip tone={tone}>{tone}</Chip>
          ))}
        </p>
      </Specimen>

      <Callout tone="warning">
        <h3>Why chips carry a left rule</h3>
        <p>
          Because the seed is honey, every warm container role lands within a few percent of every other:{" "}
          <code>warning-container</code> and <code>surface-variant</code> are very nearly the same swatch, and{" "}
          <code>primary-container</code>, <code>secondary-container</code> and <code>warning-container</code> are
          almost indistinguishable side by side. A fill alone therefore cannot carry status in this palette. Every
          toned chip and callout gets a 3px left rule in its stronger role, which separates them at a glance — and
          keeps the distinction for anyone who cannot see the fill difference at all.
        </p>
      </Callout>

      <h2>Depth</h2>
      <p>
        Flat. Cards are outlined, never elevated; there are no gradients, no tinted glass, and no shadow anywhere
        except the header dropdowns, which need to read as floating above the page they cover. Depth in this product
        comes from the surface-variant header bar against the lighter content region, and from nothing else.
      </p>

      <DoDont
        dos={[
          <>
            Pair a background role with its own <code>on-</code> role, always.
          </>,
          "Ask for a tone by what it means — blocking, warning, success — so re-seeding cannot change the meaning.",
          "Proof both schemes. Dark mode is not a variant here; it is half the generated palette.",
          <>
            Put new colour decisions in <code>tokens.ts</code>, where hexes are allowed.
          </>,
        ]}
        donts={[
          "Don't name a hex value in a stylesheet or a view. Not once, not for a one-off.",
          "Don't distinguish two states by fill alone — in this palette the warm fills are too close.",
          "Don't add elevation to make something stand out. Use an outline, a rule, or the page order.",
          <>
            Don't use <code>tertiary</code> as a status colour; it is already spoken for by visited links.
          </>,
        ]}
      />
    </DesignPage>
  );
}
