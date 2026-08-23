import { DesignPage, DoDont, OpenQuestion } from "./shell.js";

export function DesignImagery() {
  return (
    <DesignPage
      current="/design/imagery"
      title="Imagery"
      lede="Almost none, so far — and the photographs that are coming belong to other people."
    >
      <h2>What the product shows today</h2>
      <p>
        One thing: a volunteer's iNaturalist avatar in the account menu, at 1.75rem, circular, cropped to fill, and
        with an empty <code>alt</code> because the button beside it already says whose account it is. When there is no
        avatar, an outline person icon takes its place rather than initials or a generated shape.
      </p>
      <p>
        There is no photography in the design otherwise — no hero images, no illustration, no stock. This is a working
        tool, and a photograph on a page whose job is "here is what needs fixing" is noise.
      </p>

      <h2>What is coming</h2>
      <p>
        Two kinds, and they raise different questions. <strong>Observation photographs</strong> from iNaturalist —
        mostly the floral host — would help a volunteer confirm they are looking at the right sample. Later,{" "}
        <strong>specimen photographs</strong> attached to determinations, which is how a taxonomist shows what they
        actually saw.
      </p>
      <p>
        The design constraints are easy: full-width inside their container, never cropped to a fixed aspect that cuts
        the subject, never the primary content of a row, and never load-blocking. The hard part is not visual.
      </p>

      <OpenQuestion bead="beeline-2c3.15">
        <p>
          These photographs belong to the volunteers who took them, licensed on iNaturalist under terms that vary per
          photo and per user. Before any screen shows one we need to know which licences permit display here, what
          attribution has to travel with the image, whether hot-linking iNaturalist's CDN is acceptable to them, and
          what happens to a cached image when someone changes their licence or deletes the observation. None of that
          is a styling decision, and all of it has to be settled first.
        </p>
      </OpenQuestion>

      <DoDont
        dos={[
          "Give a decorative image an empty alt when adjacent text already names it.",
          "Let images size to their container rather than to a fixed pixel width.",
          "Settle licence and attribution before design.",
        ]}
        donts={[
          "Don't add photography for atmosphere.",
          "Don't crop a specimen or a host to a decorative aspect ratio.",
          "Don't show a photograph you cannot attribute.",
        ]}
      />
    </DesignPage>
  );
}
