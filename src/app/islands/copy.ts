/**
 * Copy buttons: `<button data-copy="text" data-copied="Copied" hidden>`.
 * The server renders them hidden, because without script they would do
 * nothing; this reveals the ones the browser can serve and copies on click,
 * saying so on the button for a moment (SuggestedLocality, beeline-7i6).
 */

if (navigator.clipboard !== undefined) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
    button.hidden = false;
  }
}

document.addEventListener("click", (e) => {
  const button = e.target instanceof Element ? e.target.closest<HTMLButtonElement>("button[data-copy]") : null;
  if (button === null) return;
  const label = button.textContent;
  navigator.clipboard.writeText(button.dataset.copy ?? "").then(
    () => {
      button.textContent = button.dataset.copied ?? label;
      setTimeout(() => (button.textContent = label), 1500);
    },
    () => {
      // Refused (no permission, or an insecure page): leave the button as it was.
    },
  );
});
