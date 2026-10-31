/**
 * Ticking specimens for a bulk action on the specimens listing
 * (beeline-1kb.23). The action is chosen first, which puts the listing in
 * its mode: the page draws the action's form, the bar under the table, and
 * a tick box on each row the action can take, belonging to that form, so
 * without this script the form still acts on whatever is ticked on the page
 * in view. Scripting adds what a collector's labels running to several pages
 * needs: ticks kept while the person pages and filters, a box that ticks the
 * whole page, a count, and a button held until something is ticked.
 *
 * The ticks live in sessionStorage, so they belong to this tab and end with
 * it, under a key that names the action and who is signed in: a tab
 * outlives a sign-out,
 * and the next admin's marking must not carry the last one's ticks under
 * the next one's name. A store that refuses (a private window, blocked site
 * data) leaves the page working as it does without the script. They are
 * cleared when the listing comes back from a marking (`reprinted` in its
 * query), not on submit, so a refused request leaves them for another try.
 */

const form = document.querySelector<HTMLFormElement>("form[data-bulk]");
if (form !== null) {
  const key = `beeline:ticks:${form.dataset.bulk ?? ""}:${form.dataset.bulkOwner ?? ""}`;
  const load = (): Set<string> => {
    try {
      const raw = sessionStorage.getItem(key);
      return new Set(raw === null ? [] : (JSON.parse(raw) as string[]));
    } catch {
      return new Set();
    }
  };
  const save = (ticked: Set<string>): void => {
    try {
      if (ticked.size === 0) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify([...ticked]));
    } catch {
      // Kept for this page only; the form still carries what is ticked on it.
    }
  };

  // Back from a marking: the ticks it took are done with. The marker is then
  // taken out of the address, so a reload later on keeps ticks made since.
  const url = new URL(location.href);
  let ticked = url.searchParams.has("reprinted") ? new Set<string>() : load();
  save(ticked);
  if (url.searchParams.has("reprinted")) {
    url.searchParams.delete("reprinted");
    url.searchParams.delete("of");
    history.replaceState(history.state, "", url);
  }
  const rows = Array.from(document.querySelectorAll<HTMLInputElement>(`input[data-bulk-row][form="${form.id}"]`));
  const pageBox = document.querySelector<HTMLInputElement>("input[data-bulk-page]");
  const count = form.querySelector<HTMLElement>("[data-bulk-count]");
  const clear = form.querySelector<HTMLButtonElement>("[data-bulk-clear]");
  const none = form.dataset.countNone ?? "";
  const one = form.dataset.countOne ?? "";
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const other = form.dataset.countOther ?? "";

  /** The fields carrying ticks from other pages, added at submit. */
  const dropCarried = () => {
    for (const field of form.querySelectorAll("input[data-bulk-carried]")) field.remove();
  };
  const fromStore = () => {
    for (const row of rows) row.checked = ticked.has(row.value);
  };

  const refresh = () => {
    const onPage = rows.filter((r) => r.checked).length;
    if (pageBox !== null) {
      pageBox.checked = rows.length > 0 && onPage === rows.length;
      pageBox.indeterminate = onPage > 0 && onPage < rows.length;
    }
    if (count !== null) {
      count.textContent =
        ticked.size === 0 ? none : ticked.size === 1 ? one : other.replace("{n}", ticked.size.toLocaleString());
    }
    if (submit !== null) submit.disabled = ticked.size === 0;
  };

  fromStore();
  for (const row of rows) {
    row.addEventListener("change", () => {
      if (row.checked) ticked.add(row.value);
      else ticked.delete(row.value);
      save(ticked);
      refresh();
    });
  }
  if (pageBox !== null) {
    pageBox.hidden = false;
    pageBox.addEventListener("change", () => {
      for (const row of rows) {
        row.checked = pageBox.checked;
        if (pageBox.checked) ticked.add(row.value);
        else ticked.delete(row.value);
      }
      save(ticked);
      refresh();
    });
  }
  if (clear !== null) {
    clear.hidden = false;
    clear.addEventListener("click", () => {
      ticked.clear();
      for (const row of rows) row.checked = false;
      dropCarried();
      save(ticked);
      refresh();
    });
  }
  // The boxes ticked on this page submit themselves; the ones ticked on
  // other pages travel as hidden fields, rebuilt at each submit so that a
  // page the browser restores from its back-forward cache carries none left
  // over from the last one.
  form.addEventListener("submit", () => {
    dropCarried();
    const here = new Set(rows.map((r) => r.value));
    for (const id of ticked) {
      if (here.has(id)) continue;
      const field = document.createElement("input");
      field.type = "hidden";
      field.name = "specimen";
      field.value = id;
      field.dataset.bulkCarried = "";
      form.append(field);
    }
  });
  // A restored page shows the ticks as they were when it was left, which
  // another page of the listing may since have changed.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    dropCarried();
    ticked = load();
    fromStore();
    refresh();
  });
  refresh();
}
