/**
 * Previous and Next for a PhotoCarousel. The row of photos scrolls without
 * this (by touch, trackpad, or the arrow keys); scripting adds the buttons a
 * mouse user expects, which the page draws hidden so nobody without the
 * script sees buttons that do nothing.
 *
 * A button moves to the photo before or after the one at the row's start,
 * since the photos differ in width and a fixed step would land between
 * them. Each button is disabled at its end of the row.
 */

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** The photos' offsets from the start of the row, in order (the track is positioned, so it is their offsetParent). */
const stops = (track: HTMLElement) => Array.from(track.children, (slide) => (slide as HTMLElement).offsetLeft);

function update(carousel: HTMLElement) {
  const track = carousel.querySelector<HTMLElement>(".carousel-track");
  if (track === null) return;
  const atStart = track.scrollLeft <= 1;
  const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 1;
  carousel.querySelector<HTMLButtonElement>('[data-carousel="previous"]')!.disabled = atStart;
  carousel.querySelector<HTMLButtonElement>('[data-carousel="next"]')!.disabled = atEnd;
}

for (const controls of document.querySelectorAll<HTMLElement>(".carousel-controls[hidden]")) {
  const carousel = controls.closest<HTMLElement>(".carousel");
  const track = carousel?.querySelector<HTMLElement>(".carousel-track");
  if (carousel == null || track == null) continue;
  controls.hidden = false;
  update(carousel);
  track.addEventListener("scroll", () => update(carousel), { passive: true });
  window.addEventListener("resize", () => update(carousel));
  controls.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>("[data-carousel]");
    if (button === null) return;
    const offsets = stops(track);
    const here = track.scrollLeft;
    const to =
      button.dataset.carousel === "next"
        ? offsets.find((x) => x > here + 1)
        : offsets.filter((x) => x < here - 1).at(-1);
    if (to === undefined) return;
    track.scrollTo({ left: to, behavior: reduceMotion.matches ? "auto" : "smooth" });
  });
}
