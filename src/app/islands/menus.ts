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
