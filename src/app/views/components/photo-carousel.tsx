import type { Messages } from "../../messages/index.js";

/** A photograph to show, with what it shows and whose it is. */
export interface Photo {
  src: string;
  /** What the photo shows, for anyone who cannot see it. */
  alt: string;
  width: number;
  height: number;
  /** Who took it. */
  credit: string;
  licence: { name: string; url: string };
}

/**
 * Photographs in a row the reader scrolls through, each at one height and
 * its own width, so a portrait photo is never cropped to a landscape frame
 * (/design/imagery). Each carries its credit and licence beneath it.
 *
 * It works with no script: the row scrolls sideways, by touch, trackpad or
 * the arrow keys once it has focus, and stops on each photo. The islands
 * bundle (islands/carousel.ts) adds Previous and Next, which the page draws
 * hidden so a reader without the script never meets buttons that do
 * nothing. One photo needs neither.
 *
 * No photos draws nothing: a page with none has no gap to announce.
 */
export function PhotoCarousel({ m, photos }: { m: Messages; photos: readonly Photo[] }) {
  if (photos.length === 0) return null;
  const c = m.photos;
  return (
    <section class="carousel" aria-label={c.label}>
      <ul class="carousel-track" tabindex={0}>
        {photos.map((photo, i) => (
          <li>
            <figure>
              <img
                src={photo.src}
                alt={photo.alt}
                width={photo.width}
                height={photo.height}
                loading={i === 0 ? undefined : "lazy"}
                decoding="async"
              />
              <figcaption class="meta">
                {c.credit(photo.credit)}, <a href={photo.licence.url}>{photo.licence.name}</a>
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
      {photos.length > 1 && (
        <div class="carousel-controls" hidden>
          <button type="button" class="outlined" data-carousel="previous">
            {c.previous}
          </button>
          <button type="button" class="outlined" data-carousel="next">
            {c.next}
          </button>
        </div>
      )}
    </section>
  );
}
