import type { Messages } from "../../messages/index.js";
import { DesignPage, DoDont, Reference, Specimen } from "./shell.js";

export function DesignVoice({ m }: { m: Messages }) {
  return (
    <DesignPage
      current="/design/voice"
      title="Voice"
      lede="Plain, direct, and never blaming. Volunteers gave us their summer; the least this site can do is tell them exactly what to fix."
    >
      <h2>Who is being spoken to</h2>
      <p>
        A volunteer who has collected bees for a season, is not a software person, and did not ask to interact with a
        database. They are being told their records have problems — which is inherently a bit deflating — so the copy's
        job is to make each problem small, specific, and obviously fixable. Staff surfaces (jobs, this design system)
        speak differently: terse and technical, because their audience is three people who built the thing.
      </p>
      <p>
        There is a third audience this system does <em>not</em> speak for: someone who has never heard of the program,
        arriving at the public tier expected on <code>melittologist.org</code>. Persuading a stranger to volunteer is a
        different job from helping a volunteer fix a record, and the voice below would be wrong for it — it assumes you
        already collect bees, already have samples, and already know what a determination is. When that surface is
        designed it needs its own voice section, not an extension of this one.
      </p>

      <h2>The rules, and where they already hold</h2>
      <p>
        These are not aspirations. Every one of them is already true of{" "}
        <code>src/app/messages/en.ts</code>, and the examples are lifted from it.
      </p>
      <Reference
        rows={[
          [
            "Second person",
            <>“{m.qc.allClear}”</>,
          ],
          [
            "Say what to do, and where",
            <>“{m.qc.clearsNote}”</>,
          ],
          [
            "Say why the rule exists",
            <>“{m.qcInstructions.place_unabbreviated}” — the constraint is physical, so the copy says so.</>,
          ],
          [
            "Show, don't describe",
            <>“{m.qcInstructions.locality_format}” — a worked example beats a specification.</>,
          ],
          [
            "Name the consequence, not the fault",
            <>
              A finding is “{m.qc.blocksPrinting}” or “{m.qc.headsUp}”, never “invalid” or “bad”. The record has a
              problem; the person does not.
            </>,
          ],
          [
            "Absences are results",
            <>“{m.qc.allClearHeading}” gets a heading and a thank-you, not an empty page.</>,
          ],
          [
            "No dead ends",
            <>“{m.sampleEdit.noStagingRows}” — when the volunteer cannot fix it, say who can.</>,
          ],
        ]}
      />

      <h2>Glossing</h2>
      <p>
        Gloss a technical word on first use <em>by linking</em> to the <a href="/glossary">glossary</a>, not by
        re-explaining it. Copy that stops to define "obscured coordinates" every time it says it gets long, and still
        leaves out the person who met the phrase on a different screen. The glossary is the one place the definition
        lives; everything else points at it.
      </p>
      <Specimen>
        <p class="meta">
          The glossary currently holds {Object.keys(m.glossary.entries).length} terms — domain vocabulary and the
          naming conventions volunteers meet.
        </p>
      </Specimen>

      <h2>Where copy lives</h2>
      <p>
        Every volunteer-facing string comes from the message catalog, never from a view — so a translator can reach all
        of it, and so it can be proofed in one place. A message with variables is a function, so word order stays the
        translator's decision rather than being fixed by string concatenation. Pluralisation happens in the catalog,
        not in the view.
      </p>
      <p>
        Staff surfaces are exempt. This page carries literal prose, and so do the jobs screen and the proofing pages,
        because they are English-only by policy and putting a design document through a translation catalog would be
        ceremony without a beneficiary.
      </p>
      <p>
        Proof the whole catalog at <a href="/design/messages">Message catalog</a>, where every message is rendered and
        every interpolation slot is visible.
      </p>

      <h2>People</h2>
      <p>
        Never infer how to refer to someone from their name. Write neutrally — <em>they</em>, not a guess and not an
        awkward rewrite that avoids referring to the person at all. The store holds no pronouns to consult: it held a
        column briefly and it was removed as sensitive and unnecessary, so neutral is not a fallback here, it is the
        whole rule.
      </p>

      <DoDont
        dos={[
          "Address the volunteer directly, with imperative verbs.",
          "Say where the fix happens — here, or on the iNaturalist observation.",
          "Explain why a constraint exists when the reason is not obvious.",
          "Give an example when a rule has a shape (“Corvallis, not 5th St, Corvallis OR”).",
          "Link a technical term to the glossary on first use.",
        ]}
        donts={[
          "Don't blame. The record has a problem, not the person.",
          "Don't apologise for an empty state — say what it means.",
          "Don't say “error” or “invalid” to a volunteer; say what it blocks.",
          "Don't put volunteer-facing prose in a view.",
          "Don't use emoji, and don't over-punctuate — one exclamation mark in the whole product is plenty.",
          "Don't guess how to refer to someone, and don't infer it from a name.",
        ]}
      />
    </DesignPage>
  );
}
