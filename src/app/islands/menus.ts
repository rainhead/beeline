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

// A flag chip's box is fixed, so it does not scroll with the page. The
// stylesheet ties it to its chip with anchor positioning (components.css,
// beeline-zlqm); where the browser has none, the box would open where the
// chip would be if the page were not scrolled, often below the window. Here it is
// placed by hand instead: under the chip, or above it when there is more room
// there, never taller than the room it has, and kept inside the window
// sideways. It is placed again on scroll and resize while open.
const anchored = typeof CSS !== "undefined" && CSS.supports("anchor-scope: --flag-chip");
/** The gap kept between the box and the window's edge, in pixels. */
const EDGE = 16;

function placeFlagPanel(menu: HTMLDetailsElement): void {
  const summary = menu.querySelector<HTMLElement>(":scope > summary");
  const panel = menu.querySelector<HTMLElement>(":scope > .flag-panel");
  if (summary === null || panel === null) return;
  const style = panel.style;
  style.top = style.bottom = style.left = style.maxHeight = "";
  const chip = summary.getBoundingClientRect();
  const { clientWidth: width, clientHeight: height } = document.documentElement;
  const margin = parseFloat(getComputedStyle(panel).marginTop) || 0;
  const below = height - chip.bottom - margin - EDGE;
  const above = chip.top - margin - EDGE;
  const box = panel.getBoundingClientRect();
  if (box.height <= below || below >= above) {
    style.top = `${chip.bottom}px`;
    style.maxHeight = `${Math.max(below, 0)}px`;
  } else {
    style.top = "auto";
    style.bottom = `${height - chip.top}px`;
    style.maxHeight = `${Math.max(above, 0)}px`;
  }
  style.left = `${Math.max(EDGE, Math.min(chip.left, width - box.width - EDGE))}px`;
}

if (!anchored) {
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
  // Capture, so a scroll inside the table's sideways-scrolling wrapper counts too.
  document.addEventListener("scroll", placeOpen, { capture: true, passive: true });
  window.addEventListener("resize", placeOpen);
}
