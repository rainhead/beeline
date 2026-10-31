/**
 * Ticking specimens on the specimens listing and marking them for reprint
 * (beeline-1kb.23). The page draws a form, the bar under the table, and a
 * tick box in each row that belongs to it, so without this script the form
 * still marks whatever is ticked on the page in view. Scripting adds what a
 * collector's labels running to several pages needs: ticks kept while the
 * person pages and filters, a box that ticks the whole page, a count, and a
 * bar that stays out of the way until something is ticked.
 *
 * The ticks live in sessionStorage, so they belong to this tab and end with
 * it; a store that refuses (a private window, blocked site data) leaves the
 * page working as it does without the script. They are cleared when the
 * listing comes back from a marking (`reprinted` in its query), not on
 * submit, so a refused request leaves them for another try.
 */

const KEY = "beeline:reprint-ticks";

function load(): Set<string> {
  try {
    const raw = sessionStorage.getItem(KEY);
    return new Set(raw === null ? [] : (JSON.parse(raw) as string[]));
  } catch {
    return new Set();
  }
}

function save(ticked: Set<string>): void {
  try {
    if (ticked.size === 0) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify([...ticked]));
  } catch {
    // Kept for this page only; the form still carries what is ticked on it.
  }
}

const form = document.querySelector<HTMLFormElement>("form[data-bulk]");
if (form !== null) {
  const ticked = new URLSearchParams(location.search).has("reprinted") ? new Set<string>() : load();
  save(ticked);
  const rows = Array.from(document.querySelectorAll<HTMLInputElement>(`input[data-bulk-row][form="${form.id}"]`));
  const pageBox = document.querySelector<HTMLInputElement>("input[data-bulk-page]");
  const count = form.querySelector<HTMLElement>("[data-bulk-count]");
  const clear = form.querySelector<HTMLButtonElement>("[data-bulk-clear]");
  const one = form.dataset.countOne ?? "";
  const other = form.dataset.countOther ?? "";

  const refresh = () => {
    const onPage = rows.filter((r) => r.checked).length;
    if (pageBox !== null) {
      pageBox.checked = rows.length > 0 && onPage === rows.length;
      pageBox.indeterminate = onPage > 0 && onPage < rows.length;
    }
    if (count !== null) count.textContent = ticked.size === 1 ? one : other.replace("{n}", ticked.size.toLocaleString());
    form.hidden = ticked.size === 0;
  };

  for (const row of rows) {
    row.checked = ticked.has(row.value);
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
      save(ticked);
      refresh();
    });
  }
  // The boxes ticked on this page submit themselves; the ones ticked on
  // other pages travel as hidden fields.
  form.addEventListener("submit", () => {
    const here = new Set(rows.map((r) => r.value));
    for (const id of ticked) {
      if (here.has(id)) continue;
      const field = document.createElement("input");
      field.type = "hidden";
      field.name = "specimen";
      field.value = id;
      form.append(field);
    }
  });
  refresh();
}
