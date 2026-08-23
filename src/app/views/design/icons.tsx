import { ICON_SET } from "../icons.js";
import { DesignPage, DoDont, OpenQuestion, Specimen } from "./shell.js";

export function DesignIcons() {
  return (
    <DesignPage
      current="/design/icons"
      title="Iconography"
      lede="Two vocabularies, and they never mix: outline icons for chrome, a bespoke set for domain meaning."
    >
      <h2>Chrome</h2>
      <p>
        Heroicons outline at 24px, 1.5 stroke, drawn in <code>currentColor</code> so they inherit whatever surface they
        sit on. These are the generic gestures — open the menu, this is your account — and they carry no domain
        meaning. They live in <code>src/app/views/icons.tsx</code> behind a shared wrapper, so the box size, stroke
        weight, and <code>aria-hidden</code> are not things a caller can get wrong.
      </p>
      <Specimen>
        <table>
          <thead>
            <tr>
              <th>Icon</th>
              <th>Name</th>
              <th>Used for</th>
            </tr>
          </thead>
          <tbody>
            {ICON_SET.map((icon) => {
              const Glyph = icon.render;
              return (
                <tr>
                  <td>
                    <Glyph />
                  </td>
                  <td>
                    <code>{icon.name}</code>
                  </td>
                  <td>{icon.use}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Specimen>

      <h2>Accessibility</h2>
      <p>
        Every icon is <code>aria-hidden</code> and none of them is the accessible name of anything. The control around
        an icon supplies that — the menu button has an <code>aria-label</code>, the account button names who is signed
        in. An icon that is the only content of a control and has no label is a bug, not a style choice.
      </p>

      <h2>Domain icons</h2>
      <p>
        The second vocabulary would carry meaning this product actually has: sample, trap sample, specimen, label,
        determination, floral host. It would be semantic rather than decorative — an icon that means "trap sample"
        always means that and is never recoloured to fit a layout — and it would be drawn by one hand so the set stays
        coherent.
      </p>

      <OpenQuestion bead="beeline-2c3.14">
        <p>
          The bespoke set does not exist. Until it does, domain meaning is carried by words: a chip that says "blocks
          printing" beats any icon that means it, and the words survive translation.
        </p>
      </OpenQuestion>

      <DoDont
        dos={[
          "Add a chrome icon to icons.tsx, so the whole set is one file and one wrapper.",
          "Give every icon-only control a real accessible name.",
          "Put icons beside copy — in a button, in a header.",
          "Prefer a word to an icon when the meaning is domain-specific.",
        ]}
        donts={[
          "Don't mix icon sets. One outline family for chrome, full stop.",
          "Don't use emoji anywhere — not in copy, not as a status marker, not in a chip.",
          "Don't put an icon inside a sentence.",
          "Don't recolour an icon to mean something; colour lives in chips and rules, not glyphs.",
        ]}
      />
    </DesignPage>
  );
}
