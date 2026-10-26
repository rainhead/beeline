/**
 * Copy buttons: `<button data-copy="text" data-copied="Copied"
 * data-copy-failed="…" hidden>`. The server renders them hidden, because
 * without script they would do nothing; this reveals the ones the browser
 * can serve and copies on click, saying on the button for a moment whether
 * it worked (SuggestedLocality, beeline-7i6). Both messages come from the
 * catalog through the attributes.
 */

if (navigator.clipboard !== undefined) {
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
    button.hidden = false;
  }
}

document.addEventListener("click", (e) => {
  const button = e.target instanceof Element ? e.target.closest<HTMLButtonElement>("button[data-copy]") : null;
  if (button === null) return;
  // Kept on the button the first time, so a second click while it still
  // says "Copied" does not take that for its label.
  const label = (button.dataset.label ??= button.textContent ?? "");
  const say = (text: string | undefined, ms: number) => {
    button.textContent = text ?? label;
    setTimeout(() => (button.textContent = label), ms);
  };
  // Refused (no permission, or an insecure page): the name beside the
  // button can still be selected by hand, so say that.
  navigator.clipboard.writeText(button.dataset.copy ?? "").then(
    () => say(button.dataset.copied, 1500),
    () => say(button.dataset.copyFailed, 4000),
  );
});
