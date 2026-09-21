import { ATLAS_IDENTITY } from "../../theme/atlas.js";
import { AtlasMark } from "../components/index.js";
import { DesignPage, DoDont, OpenQuestion, Specimen } from "./shell.js";

/**
 * The six member atlases (schema/010_people_atlases.sql) by the names this
 * page proofs them under. Their homes, colorways and marks are
 * ATLAS_IDENTITY's, which is what the product reads too.
 */
const ATLASES = [
  { code: "OBA", name: "Oregon Bee Atlas" },
  { code: "WaBA", name: "Washington Bee Atlas" },
  { code: "BC", name: "British Columbia Bee Atlas" },
  { code: "ID", name: "Idaho Bee Atlas" },
  { code: "NM", name: "New Mexico Bee Atlas" },
  { code: "OK", name: "Oklahoma Bee Atlas" },
] as const;

/**
 * The one place a view may write a hex: /design/color forbids naming colours
 * in markup, but here the hex is the *datum being displayed*, not a styling
 * decision. A swatch of a stored value is data, the same as the string beside
 * it.
 */
function Colour({ hex }: { hex: string }) {
  return (
    <span class="row">
      <span class="swatch-dot" style={`background: ${hex}`}></span>
      <code>{hex}</code>
    </span>
  );
}

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
      <p>
        Not every volunteer has an atlas. Master Melittology membership without a member atlas is a real state, not a
        gap — a Nevada volunteer works under OBA staff&apos;s auspices without being an Oregon Bee Atlas volunteer,
        and roughly a dozen people in the store are in exactly that position. The model already answers it: with no
        atlas to act on behalf of, the program acts as itself. Program identity carries the chrome as always, the
        dashboard and profile carry no atlas colorway, and nothing has to be invented for the case.
      </p>

      <h2>Atlas colorways</h2>
      <p>
        An atlas colorway is a <em>pair</em>, not a single colour. Each atlas mark is a roundel: a dark ring carrying
        the atlas name, a bright disc behind a white bee. Oregon is sage grey-green on orange-red; Washington is deep
        navy on gold. Neither colour derives from the other — navy and gold are not two tones of one hue.
      </p>
      <p>
        The two do different jobs, which is what makes them themeable. The <strong>disc colour</strong> is the atlas
        accent, so it is the seed the Material palette generates from. The <strong>ring colour</strong> is always
        dark and always carries the name, so it dresses the header bar rather than the palette. Seeding from a ring
        instead would render Washington navy throughout and Idaho black, which is not what either identity means.
      </p>
      <p>
        Four of the six discs are warm — Oregon brick, Washington, Idaho and New Mexico gold — close enough to
        Beeline&apos;s honey that the product barely shifts. British Columbia is sky blue, and is the useful case:
        it proves the disc is the seed because it <em>is</em> the accent, not because atlas colours happen to be
        warm. A BC-seeded Beeline should come out blue. Oklahoma turns the usual contrast around, with a dark red
        disc inside a charcoal ring; the disc is still the accent and still the seed.
      </p>
      <Specimen>
        <table>
          <thead>
            <tr>
              <th>Mark</th>
              <th>Atlas</th>
              <th>Disc — the seed</th>
              <th>Ring — dark chrome</th>
              <th>Proof</th>
            </tr>
          </thead>
          <tbody>
            {ATLASES.map((a) => {
              const identity = ATLAS_IDENTITY[a.code]!;
              return (
                <tr>
                  <td>
                    <AtlasMark code={a.code} name={a.name} />
                  </td>
                  <td>
                    <a href={identity.url}>{a.name}</a> <span class="meta">{a.code}</span>
                  </td>
                  <td>
                    <Colour hex={identity.disc} />
                  </td>
                  <td>
                    <Colour hex={identity.ring} />
                  </td>
                  <td>
                    <a href={`/tokens.css?seed=${encodeURIComponent(identity.disc)}`}>tokens.css</a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Specimen>
      <p class="meta">
        To try a colour before committing to it, request the stylesheet with any seed:{" "}
        <code>/tokens.css?seed=%23264653</code>. Anything that is not a six-digit hex falls back to the default.
      </p>

      <OpenQuestion bead="beeline-2c3.12">
        <p>
          All six colours are sampled from the marks the program distributes on Canvas, recorded on beeline-2c3.12.
          None has been stated by a brand source, and none seeds the product palette yet: every atlas still renders
          in Beeline&apos;s own honey.
        </p>
      </OpenQuestion>

      <h2>Where the mark appears</h2>
      <p>
        At the end of the page header on the two screens about one person: the volunteer&apos;s own front page, and
        that person&apos;s page on <code>/people</code>. The atlas is the one they belong to, as{" "}
        <code>person_membership</code> records it, never the one their samples happened to land in, so a Washington volunteer
        collecting in Oregon still sees Washington. Program-only membership, or nobody having asked, carries no mark:
        the program acts as itself.
      </p>

      <h2>Wordmark</h2>
      <p>
        The program itself is still typographic: "Beeline" set in the title step, in <code>on-surface</code>,
        top-left, linking home. No program mark ships in this repository, only the six atlas adaptations of it.
      </p>
      <p>
        The atlas marks carry their own circular type, so the mark and the atlas name are a single object. There is no
        lockup to break apart, and at small sizes the wrapped name is unreadable, which means a favicon or an avatar
        needs the bee-and-pin glyph on its own. That cropped version does not exist as an asset yet.
      </p>
      <Specimen>
        <span style="font: var(--md-sys-typescale-title); color: var(--md-sys-color-on-surface)">Beeline</span>
      </Specimen>

      <OpenQuestion bead="beeline-2c3.13">
        <p>
          The marks here are 216-pixel JPEGs from Canvas, with a white field and no transparency. They are cropped to
          their circle and drawn at one small size, 4.5rem, and nowhere larger. The vector artwork would lift both
          limits, and would bring with it what a logo section normally states: clear space, minimum size, approved
          colorways, what may never be done to it, and which mark is used at favicon sizes.
        </p>
      </OpenQuestion>

      <h2>Graphic elements</h2>
      <p>
        There are none, and that is currently the right answer. This is a tool for finding and fixing problems in your
        own records; decorative shapes would compete with a screen whose entire job is to make a small number of
        important things obvious.
      </p>
      <p>
        If a vocabulary is ever wanted, the marks already contain it: the bee&apos;s abdomen is drawn as a map pin.
        Bee plus place is exactly what a sample is, which makes the pin the one motif in this domain that carries
        meaning rather than atmosphere. It would belong in empty states and on the sign-in page, and never behind
        data.
      </p>

      <DoDont
        dos={[
          "Let the program carry the chrome and the atlas carry the volunteer's own screens.",
          "Treat a colorway as the pair it is: the disc seeds the palette, the ring dresses the chrome.",
          "Say plainly when identity is missing rather than inventing a placeholder mark.",
          "Crop an atlas mark to its circle, and keep it small until the vector files arrive.",
        ]}
        donts={[
          "Don't give an atlas its own separate logo; the program mark adapts.",
          "Don't hard-code an atlas colour or mark anywhere but ATLAS_IDENTITY.",
          "Don't seed the palette from a ring colour — Washington would come out navy throughout.",
          "Don't put decoration behind data.",
        ]}
      />
    </DesignPage>
  );
}
