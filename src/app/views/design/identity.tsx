import { SEED_COLOR } from "../../theme/tokens.js";
import { DesignPage, DoDont, OpenQuestion, Specimen } from "./shell.js";

/**
 * The six member atlases (schema/010_people_atlases.sql). Seeds are unknown:
 * every atlas currently renders in Beeline's own honey, and the column is
 * here so that supplying a real colorway is a one-line change.
 */
const ATLASES = [
  { code: "OBA", name: "Oregon Bee Atlas", seed: null },
  { code: "WaBA", name: "Washington Bee Atlas", seed: null },
  { code: "BC", name: "British Columbia Bee Atlas", seed: null },
  { code: "ID", name: "Idaho Bee Atlas", seed: null },
  { code: "NM", name: "New Mexico Bee Atlas", seed: null },
  { code: "OK", name: "Oklahoma Bee Atlas", seed: null },
] as const;

export function DesignIdentity() {
  return (
    <DesignPage
      current="/design/identity"
      title="Identity"
      lede="Master Melittology is the brand, acting on behalf of your atlas. Both have to be legible at once."
    >
      <h2>Whose site is this?</h2>
      <p>
        The Master Melittology program at Oregon State University Extension, on behalf of the volunteer's own atlas.
        Volunteers understand that the program coordinates the atlases and provides the shared resources; what they
        <em> identify</em> with is their atlas — Washington, Oregon, British Columbia. So the identity is not one brand
        or the other, it is the program presenting an atlas.
      </p>
      <p>
        Concretely: program identity carries the chrome, and atlas identity appears where the volunteer's own
        membership is the subject — their dashboard, their profile, and anywhere a sample's atlas assignment matters.
        Each atlas has its own colour scheme, and the program logo is adapted to that scheme rather than each atlas
        having a separate mark.
      </p>

      <h2>Atlas colorways</h2>
      <p>
        Because the whole palette is generated from one seed, an atlas colorway is a seed and nothing else. Supply a
        colour and the entire product re-themes: chrome, chips, buttons, semantic states, light and dark.
      </p>
      <Specimen>
        <table>
          <thead>
            <tr>
              <th>Atlas</th>
              <th>Seed</th>
              <th>Proof</th>
            </tr>
          </thead>
          <tbody>
            {ATLASES.map((a) => (
              <tr>
                <td>
                  {a.name} <span class="meta">{a.code}</span>
                </td>
                <td>
                  {a.seed === null ? (
                    <span class="meta">not supplied — currently {SEED_COLOR}</span>
                  ) : (
                    <code>{a.seed}</code>
                  )}
                </td>
                <td>
                  <a href={`/tokens.css?seed=${encodeURIComponent(a.seed ?? SEED_COLOR)}`}>tokens.css</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Specimen>
      <p class="meta">
        To try a colour before committing to it, request the stylesheet with any seed:{" "}
        <code>/tokens.css?seed=%23264653</code>. Anything that is not a six-digit hex falls back to the default.
      </p>

      <OpenQuestion bead="beeline-2c3.12">
        <p>None of the six real colorways are known yet, and neither is how the program logo adapts to each.</p>
      </OpenQuestion>

      <OpenQuestion bead="beeline-2c3.11">
        <p>
          Nothing links a person to an atlas. The <code>atlas</code> table exists and samples are assigned to atlases
          by geography, but a volunteer has no home atlas — so no screen can currently show atlas branding at all. This
          section describes a contract, not something you can see working.
        </p>
      </OpenQuestion>

      <h2>Wordmark</h2>
      <p>
        Today the identity is typographic: "Beeline" set in the title step, in <code>on-surface</code>, top-left,
        linking home. It is honest about what exists — there is no mark in this repository — and it will be replaced
        rather than extended.
      </p>
      <Specimen>
        <span style="font: var(--md-sys-typescale-title); color: var(--md-sys-color-on-surface)">Beeline</span>
      </Specimen>

      <OpenQuestion bead="beeline-2c3.13">
        <p>
          No logo asset exists. When one arrives this section needs the things a logo section normally states: clear
          space, minimum size, approved colorways, what may never be done to it, and which mark is used at favicon
          sizes.
        </p>
      </OpenQuestion>

      <h2>Graphic elements</h2>
      <p>
        There are none, and that is currently the right answer. This is a tool for finding and fixing problems in your
        own records; decorative shapes would compete with a screen whose entire job is to make a small number of
        important things obvious. If a decorative vocabulary is ever added it should derive from the program's mark, be
        confined to empty states and the sign-in page, and never appear behind data.
      </p>

      <DoDont
        dos={[
          "Let the program carry the chrome and the atlas carry the volunteer's own screens.",
          "Treat an atlas colorway as a seed — one colour, everything else derived.",
          "Say plainly when identity is missing rather than inventing a placeholder mark.",
        ]}
        donts={[
          "Don't give an atlas its own separate logo; the program mark adapts.",
          "Don't hard-code an atlas colour anywhere but the seed table.",
          "Don't put decoration behind data.",
        ]}
      />
    </DesignPage>
  );
}
