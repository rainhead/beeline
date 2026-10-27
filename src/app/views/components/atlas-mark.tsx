import { programHref } from "../../programs.js";
import { ATLAS_IDENTITY } from "../../theme/atlas.js";

/**
 * An atlas's mark: the program roundel in that atlas's colorway. The mark
 * carries the atlas name in its own circular type, so its alt text is that
 * name and nothing is set beside it.
 *
 * Cropped to its circle because the only files so far are JPEGs with a
 * white field around the roundel, which would show as a square on any
 * surface but white (beeline-2c3.13). Drawn at one small size: the files are
 * 216px, which is sharp at 72 CSS pixels (4.5rem) on a 3x screen and nowhere larger.
 *
 * A mark links to its program, since an atlas's program code is its atlas
 * code (schema/010) and the mark is where a reader reaches for it
 * (beeline-8n7r). `href` says otherwise: the atlas's own website where
 * the reader cannot reach the program pages (the signed-out page), and
 * `null` on the program's own page, which a link would only reload.
 *
 * An atlas with no mark on file draws nothing. That is not an absence to
 * announce: the atlas's name is on the page anyway, and the mark only
 * repeats it.
 */
export function AtlasMark({ code, name, href }: { code: string; name: string; href?: string | null }) {
  const identity = ATLAS_IDENTITY[code];
  if (identity === undefined) return null;
  const mark = <img class="atlas-mark" src={identity.logo} alt={name} width={72} height={72} />;
  if (href === null) return mark;
  return (
    <a class="atlas-mark-link" href={href ?? programHref(code)}>
      {mark}
    </a>
  );
}
