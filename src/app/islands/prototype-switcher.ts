/**
 * PROTOTYPE (beeline-d0u4): keeps ?variant= on every same-site link and GET
 * form, so a variant survives clicking through the app, and cycles variants
 * with ← and → (not while typing). Does nothing on a page without the bar.
 */
function init(): void {
  const bar = document.querySelector(".proto-switcher");
  if (bar === null) return;
  const variant = new URL(location.href).searchParams.get("variant");
  if (variant !== null) {
    for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href^='/']")) {
      if (a.closest(".proto-switcher") || /^\/(static|assets|auth)\//.test(a.getAttribute("href")!)) continue;
      const url = new URL(a.href);
      if (!url.searchParams.has("variant")) url.searchParams.set("variant", variant);
      a.href = `${url.pathname}${url.search}${url.hash}`;
    }
    for (const form of document.querySelectorAll<HTMLFormElement>("form")) {
      if ((form.getAttribute("method") ?? "get").toLowerCase() !== "get" || form.querySelector("input[name=variant]")) continue;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "variant";
      input.value = variant;
      form.append(input);
    }
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("input, textarea, select, [contenteditable]")) return;
    const link = bar.querySelector<HTMLAnchorElement>(`[data-proto=${e.key === "ArrowLeft" ? "prev" : "next"}]`);
    if (link) location.href = link.href;
  });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
