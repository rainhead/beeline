import { DesignPage, DoDont, Reference, Specimen } from "./shell.js";

const TYPE_SCALE = [
  ["display", "2.25rem / 400", "Page titles. One per screen."],
  ["headline", "1.5rem / 400", "Section headings inside a page."],
  ["title", "1.125rem / 500", "Card headings, glossary terms, the brand in the header."],
  ["body", "1rem / 400", "Everything a volunteer reads. The default."],
  ["label", "0.875rem / 500", "Buttons, chips, table headers, and all secondary text."],
] as const;

const SPECIMEN_TEXT = "Andrena prunorum on Phacelia hastata";

export function DesignType() {
  return (
    <DesignPage
      current="/design/type"
      title="Typography"
      lede="System fonts, five steps, and one monospace register that means exactly one thing."
    >
      <h2>The family question, answered</h2>
      <p>
        <code>system-ui</code>, with the platform stack behind it. No webfont ships with this application, and that is
        a decision rather than an omission: a self-hosted family would cost a render-blocking download, a licence, a
        subsetting step, and a flash of unstyled text — to give an internal data tool a typographic accent that nobody
        using it is here to appreciate. Hierarchy comes from the scale and from weight.
      </p>
      <p>
        This is the section most likely to change if Master Melittology brings its own typeface to the brand. Until
        then, system fonts are the answer, not a placeholder.
      </p>

      <h2>The scale</h2>
      <Specimen>
        {TYPE_SCALE.map(([step]) => (
          <p style={`font: var(--md-sys-typescale-${step})`}>
            {step} — {SPECIMEN_TEXT}
          </p>
        ))}
      </Specimen>
      <Reference rows={TYPE_SCALE.map(([step, spec, use]) => [`${step} · ${spec}`, use] as const)} />

      <h2>Weight</h2>
      <p>
        Three weights and no more: 400 for anything you read at length, 500 for anything you act on or scan — buttons,
        chips, table headers, secondary annotations — and 700 reserved for the rare case that needs to shout, which so
        far is nothing in the product. Long copy is never set in a heavy weight, and emphasis inside a sentence is
        italic, not bold.
      </p>

      <h2>Monospace means "machine value"</h2>
      <p>
        Monospace is a semantic register in this system, not a decoration. It marks a value a machine produced or
        consumes: a job name, an observation id, a coordinate, a timestamp, a raw field name, a QC rule's detail
        string. If a human wrote it or a human is expected to read it as prose, it is not monospace.
      </p>
      <Specimen>
        <p>
          The nightly run <code>nightly-pipeline</code> finished at <code>2026-08-23T02:14:07Z</code> and touched
          observation <code>123456789</code>.
        </p>
        <p>
          A scientific name is <em>never</em> monospace, however technical it looks — it is a name, and it has its own
          rules. See <a href="/design/names">Scientific names</a>.
        </p>
      </Specimen>

      <h2>Case</h2>
      <p>
        Sentence case everywhere: headings, buttons, table headers, chips. Title case is reserved for the brand
        wordmark. Uppercase appears only in this design system's own labels — the small tracked headings on this page —
        and never in the product. Buttons carry no full stop; body copy in complete sentences does.
      </p>

      <DoDont
        dos={[
          "Let the scale carry hierarchy — pick the step that fits the role, not the size you want.",
          "Set secondary text as label weight in on-surface-variant. There is a component for it.",
          "Use italic for emphasis inside prose, and for scientific names.",
          "Write buttons as sentence-case verbs: “Fix on iNaturalist”, “Save changes”.",
        ]}
        donts={[
          "Don't introduce a second family, including for headings.",
          "Don't set long copy in 500 or 700 — weight is for scanning, not for reading.",
          "Don't use monospace as a texture. It means a machine value, and overusing it destroys the signal.",
          "Don't put a scientific name in <code>, even when it is data.",
          "Don't title-case a heading or a button.",
        ]}
      />
    </DesignPage>
  );
}
