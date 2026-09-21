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
 * An atlas with no mark on file draws nothing. That is not an absence to
 * announce: the atlas's name is on the page anyway, and the mark only
 * repeats it.
 */
export function AtlasMark({ code, name }: { code: string; name: string }) {
  const identity = ATLAS_IDENTITY[code];
  if (identity === undefined) return null;
  return <img class="atlas-mark" src={identity.logo} alt={name} width={72} height={72} />;
}
