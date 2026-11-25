/**
 * Dismissal for the header's <details class="menu"> dropdowns. The menus are
 * fully functional without this (native <details> toggling); scripting adds
 * only the conventions a dropdown is expected to honor: clicking elsewhere or
 * pressing Escape closes it, and opening one closes the others.
 */

const openMenus = () => document.querySelectorAll<HTMLDetailsElement>("details.menu[open]");

document.addEventListener("click", (e) => {
  for (const menu of openMenus()) {
    if (!(e.target instanceof Node) || !menu.contains(e.target)) menu.open = false;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const menu of openMenus()) menu.open = false;
});

// toggle doesn't bubble, so listen in the capture phase.
document.addEventListener(
  "toggle",
  (e) => {
    const opened = e.target;
    if (!(opened instanceof HTMLDetailsElement) || !opened.classList.contains("menu") || !opened.open) return;
    for (const menu of openMenus()) {
      if (menu !== opened) menu.open = false;
    }
  },
  true,
);

// A link marked data-close-details closes the <details> it is in without
// following the link, which is its fallback without scripting: the Place
// cell's Cancel goes back to the listing, which draws the cell closed. The
// form inside is put back as it was drawn.
document.addEventListener("click", (e) => {
  const link = (e.target as Element | null)?.closest?.("[data-close-details]");
  if (!link) return;
  const details = link.closest("details");
  if (details === null) return;
  e.preventDefault();
  details.querySelector("form")?.reset();
  details.open = false;
});

// A flag chip's box is fixed, so it does not scroll with the page
// (components.css, beeline-zlqm). Left in its own place it would open where
// the chip would be if the page were not scrolled, often below the window; the
// stylesheet's anchor positioning only moves it, so a tall box that fits on
// neither side of its chip still ran off. Here it is placed by hand in every
// browser: under the chip, or above it when it does not fit below and there
// is more room above, never taller than the room on the side it opens, and
// kept inside the window sideways. The `placed` class turns the stylesheet's
// own fallbacks off, since they would override these insets. It is placed
// again on scroll and resize while open.
/** The gap kept between the box and the window's edge, in pixels. */
const EDGE = 16;

function placeFlagPanel(menu: HTMLDetailsElement): void {
  const summary = menu.querySelector<HTMLElement>(":scope > summary");
  const panel = menu.querySelector<HTMLElement>(":scope > .flag-panel");
  if (summary === null || panel === null) return;
  panel.classList.add("placed");
  const style = panel.style;
  // Measured at its natural height: the scroll offset inside it would be lost
  // here, which is why scrolling inside the box does not place it again.
  style.top = style.bottom = style.left = style.maxHeight = "";
  const chip = summary.getBoundingClientRect();
  const { clientWidth: width, clientHeight: height } = document.documentElement;
  const margin = parseFloat(getComputedStyle(panel).marginTop) || 0;
  const below = height - chip.bottom - margin - EDGE;
  const above = chip.top - margin - EDGE;
  const box = panel.getBoundingClientRect();
  if (box.height <= below || below >= above) {
    style.top = `${chip.bottom}px`;
    style.bottom = "auto";
    style.maxHeight = `${Math.max(below, 0)}px`;
  } else {
    style.top = "auto";
    style.bottom = `${height - chip.top}px`;
    style.maxHeight = `${Math.max(above, 0)}px`;
  }
  style.left = `${Math.max(EDGE, Math.min(chip.left, width - box.width - EDGE))}px`;
}

const placeOpen = () => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.flag-menu[open]")) placeFlagPanel(menu);
};
document.addEventListener(
  "toggle",
  (e) => {
    const menu = e.target;
    if (menu instanceof HTMLDetailsElement && menu.open && menu.classList.contains("flag-menu")) placeFlagPanel(menu);
  },
  true,
);
// Capture, so a scroll inside the table's sideways-scrolling wrapper counts
// too; but not a scroll inside the box itself, which does not move its chip.
document.addEventListener(
  "scroll",
  (e) => {
    if (e.target instanceof Element && e.target.closest(".flag-panel") !== null) return;
    placeOpen();
  },
  { capture: true, passive: true },
);
window.addEventListener("resize", placeOpen);
