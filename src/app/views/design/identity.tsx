import { SEED_COLOR } from "../../theme/tokens.js";
import { DesignPage, DoDont, OpenQuestion, Specimen } from "./shell.js";

/**
 * The six member atlases (schema/010_people_atlases.sql), their public homes,
 * and their colorways as far as they are known.
 *
 * `disc` and `ring` are EYEDROPPED from published marks — approximate,
 * unconfirmed against any brand source, and not yet used by the product,
 * which still renders every atlas in Beeline's own honey. A null pair means
 * the mark exists but has not been located yet, NOT that the atlas lacks one.
 * They sit here so replacing a guess with a real value is a one-line change
 * (beeline-2c3.12).
 */
const ATLASES = [
  {
    code: "OBA",
    name: "Oregon Bee Atlas",
    url: "https://extension.oregonstate.edu/bee-atlas",
    disc: "#d23c00",
    ring: "#8c8c82",
  },
  {
    code: "WaBA",
    name: "Washington Bee Atlas",
    url: "https://agr.wa.gov/beeatlas",
    disc: "#fab446",
    ring: "#1e1e5a",
  },
  {
    code: "BC",
    name: "British Columbia Bee Atlas",
    url: "https://www.bcnativebees.org/bc-bee-atlas",
    disc: "#6eb4d2",
    ring: "#6e001e",
  },
  {
    code: "ID",
    name: "Idaho Bee Atlas",
    url: "https://sites.google.com/view/idahobeeatlas/home",
    disc: "#f0aa00",
    ring: "#141414",
  },
  {
    code: "NM",
    name: "New Mexico Bee Atlas",
    url: "https://www.inaturalist.org/projects/new-mexico-bee-atlas",
    disc: null,
    ring: null,
  },
  {
    code: "OK",
    name: "Oklahoma Bee Atlas",
    url: "https://www.inaturalist.org/projects/oklahoma-bee-atlas",
    disc: null,
    ring: null,
  },
] as const;

/**
 * The one place a view may write a hex: /design/color forbids naming colours
 * in markup, but here the hex is the *datum being displayed*, not a styling
 * decision. A swatch of a stored value is data, the same as the string beside
 * it.
 */
function Colour({ hex }: { hex: string | null }) {
  if (hex === null) return <span class="meta">unknown</span>;
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
        Three of the four known discs are warm — Oregon brick, Washington and Idaho gold — close enough to
        Beeline&apos;s honey that the product barely shifts. British Columbia is sky blue, and is the useful case:
        it proves the disc is the seed because it <em>is</em> the accent, not because atlas colours happen to be
        warm. A BC-seeded Beeline should come out blue.
      </p>
      <Specimen>
        <table>
          <thead>
            <tr>
              <th>Atlas</th>
              <th>Disc — the seed</th>
              <th>Ring — dark chrome</th>
              <th>Proof</th>
            </tr>
          </thead>
          <tbody>
            {ATLASES.map((a) => (
              <tr>
                <td>
                  <a href={a.url}>{a.name}</a> <span class="meta">{a.code}</span>
                </td>
                <td>
                  <Colour hex={a.disc} />
                </td>
                <td>
                  <Colour hex={a.ring} />
                </td>
                <td>
                  <a href={`/tokens.css?seed=${encodeURIComponent(a.disc ?? SEED_COLOR)}`}>tokens.css</a>
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
        <p>
          Four of the six are known by eye — Oregon, Washington, British Columbia and Idaho, sampled from their
          published marks and recorded on beeline-2c3.12. None has been confirmed against a brand source.
        </p>
        <p>
          New Mexico and Oklahoma have marks and colours too; they simply have not been found. Neither runs a website —
          both are reachable only as iNaturalist projects, whose icons are stand-ins rather than identity (New Mexico&apos;s
          is a photograph of a bee; Oklahoma&apos;s is a green state silhouette). Do not read a null pair as an atlas
          without a mark.
        </p>
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
        linking home. That is a placeholder for the atlas roundel, not a design — no mark ships in this repository.
      </p>
      <p>
        One constraint the real marks impose: the roundel carries its own circular type, so the mark and the atlas
        name are a single object. There is no lockup to break apart, and at small sizes the wrapped name is
        unreadable — which means a favicon or an avatar needs the bee-and-pin glyph on its own, and that cropped
        version does not currently exist as an asset.
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
        ]}
        donts={[
          "Don't give an atlas its own separate logo; the program mark adapts.",
          "Don't hard-code an atlas colour anywhere but the colorway table.",
          "Don't seed the palette from a ring colour — Washington would come out navy throughout.",
          "Don't put decoration behind data.",
        ]}
      />
    </DesignPage>
  );
}
