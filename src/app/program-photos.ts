import type { Photo } from "./views/components/photo-carousel.js";

/**
 * Each program's photographs, keyed by program code, in the order its page
 * shows them (beeline-8n7r). A program with none shows none: the page has
 * no gap to fill.
 *
 * Adding one is a change to this table and the files under
 * static/programs/<code>/, nothing else, the way an atlas's mark is
 * (src/app/theme/atlas.ts). The repository is public, so a file goes in
 * only with its metadata stripped — a phone writes where it was taken into
 * every photo — and converted to sRGB first, since stripping a wide-gamut
 * photo's colour profile dulls it:
 *
 *   magick in.jpeg -auto-orient -profile <an sRGB .icc> -strip -quality 80 out.webp
 *
 * Every photo is credited, and says its licence (/design/imagery).
 */
const CC_BY = { name: "CC BY", url: "https://creativecommons.org/licenses/by/4.0/" };

export const PROGRAM_PHOTOS: Readonly<Record<string, readonly Photo[]>> = {
  WaBA: [
    {
      src: "/static/programs/WaBA/volunteers-with-nets.webp",
      alt: "Six volunteers in safety vests, some holding insect nets, stand with a dog on a grassy bluff above the water under a cloudy sky.",
      width: 1280,
      height: 960,
      credit: "Peter Abrahamsen",
      licence: CC_BY,
    },
    {
      src: "/static/programs/WaBA/bumble-bee-at-rose.webp",
      alt: "A bumble bee with full pollen baskets flies in to a pink wild rose.",
      width: 1280,
      height: 960,
      credit: "Peter Abrahamsen",
      licence: CC_BY,
    },
    {
      src: "/static/programs/WaBA/cactus-above-river.webp",
      alt: "A cactus in bright pink bloom on a rocky slope, above a river winding through dry hills.",
      width: 960,
      height: 1280,
      credit: "Peter Abrahamsen",
      licence: CC_BY,
    },
  ],
};
