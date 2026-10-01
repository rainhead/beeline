/**
 * PROTOTYPE (beeline-bcq), variant A — the grid from the August wireframes.
 *
 * Every specimen is already a row, so a number is never typed to *enter* a
 * determination — only to find rows. Two modes over the same grid: by
 * sample, the season in collecting order; and a batch, for a box sorted by
 * genus or morphospecies — type a list or a range, or scan the labels one
 * after another, and those rows line up in the order they were added. Tick rows and name them all
 * at once: coarse first — the box is all Bombus — then refine a few to
 * species. Rows save as drafts as you go; they become determinations only
 * when something downstream consumes them (an export, a review, a print),
 * which the "freeze" button stands in for here.
 */
import { html, nothing } from "lit";
import { Light, sexSegments } from "./shared.js";
import { bySample, fmtDate, hasCaste, inatHref, placeLabel, plainName, sampleLabel, store, taxonName, type Draft, type Specimen } from "./store.js";

const CHUNK = 400;
const MAX_RANGE = 2000;

/** One thing typed or scanned into the number box. */
interface NumberEntry {
  text: string;
  ids: number[];
  problem: string | null;
}

interface BulkChange {
  before: Map<number, Draft | undefined>;
  text: string;
}

const isDigits = (s: string | null): s is string => s !== null && /^\d+$/.test(s);

/**
 * Resolve one token: a whole number, the unique tail of one (412 for
 * 26000412), or a range whose end may be abbreviated (26019685-690).
 */
function resolve(token: string, specimens: Specimen[], season: number): NumberEntry {
  const range = /^(\d+)-(\d+)$/.exec(token);
  if (range) {
    const [, start, rawEnd] = range as unknown as [string, string, string];
    const end = rawEnd.length < start.length ? start.slice(0, start.length - rawEnd.length) + rawEnd : rawEnd;
    const text = `${start}–${end}`;
    if (!specimens.some((s) => s.fieldNumber?.length === start.length)) return { text, ids: [], problem: "start a range with a whole number" };
    if (BigInt(end) < BigInt(start)) return { text, ids: [], problem: "the range runs backwards" };
    if (BigInt(end) - BigInt(start) > BigInt(MAX_RANGE)) return { text, ids: [], problem: `more than ${MAX_RANGE} numbers — is that a typo?` };
    const ids = specimens
      .filter((s) => isDigits(s.fieldNumber) && s.fieldNumber.length === start.length && BigInt(s.fieldNumber) >= BigInt(start) && BigInt(s.fieldNumber) <= BigInt(end))
      .map((s) => s.id);
    return { text, ids, problem: ids.length === 0 ? `none of your ${season} numbers` : null };
  }
  if (!/^\d+$/.test(token)) return { text: token, ids: [], problem: "not a number" };
  const exact = specimens.find((s) => s.fieldNumber === token);
  if (exact) return { text: token, ids: [exact.id], problem: null };
  const tail = token.length >= 3 ? specimens.filter((s) => s.fieldNumber?.endsWith(token)) : [];
  if (tail.length === 1) return { text: tail[0]!.fieldNumber!, ids: [tail[0]!.id], problem: null };
  if (tail.length > 1) return { text: token, ids: [], problem: `${tail.length} of your numbers end in ${token}` };
  return { text: token, ids: [], problem: `not one of your ${season} specimens` };
}

function tokens(raw: string): string[] {
  return raw
    .replace(/\s*[-–—]\s*/g, "-")
    .split(/[\s,;]+/)
    .filter(Boolean);
}

class GridVariant extends Light {
  static properties = {
    mode: { state: true },
    filter: { state: true },
    batch: { state: true },
    problems: { state: true },
    added: { state: true },
    jumpMessage: { state: true },
    flash: { state: true },
    selected: { state: true },
    editing: { state: true },
    limit: { state: true },
    lastBulk: { state: true },
  };
  declare mode: "sample" | "batch";
  declare filter: "outstanding" | "all";
  /** Specimen ids, in the order they were added. */
  declare batch: number[];
  /** What the number box could not resolve, kept until dismissed. */
  declare problems: NumberEntry[];
  /** The last thing the number box did, in words. */
  declare added: string;
  declare jumpMessage: string;
  declare flash: number | null;
  declare selected: Set<number>;
  declare editing: number | null;
  declare limit: number;
  declare lastBulk: BulkChange | null;
  #anchor: number | null = null;
  #onChange = () => this.requestUpdate();

  constructor() {
    super();
    this.mode = "sample";
    this.filter = "outstanding";
    this.batch = [];
    this.problems = [];
    this.added = "";
    this.jumpMessage = "";
    this.flash = null;
    this.selected = new Set();
    this.editing = null;
    this.limit = CHUNK;
    this.lastBulk = null;
  }

  override connectedCallback() {
    super.connectedCallback();
    store().addEventListener("change", this.#onChange);
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    store().removeEventListener("change", this.#onChange);
  }

  /**
   * By sample, outstanding means "had no determination when you sat down",
   * not "has none now" — a row you just filled must not vanish under you, or
   * the coarse-then-fine pass has nothing left to refine. A batch is exactly
   * what was added to it, in that order.
   */
  #rows(): Specimen[] {
    const s = store();
    if (this.mode === "batch") return this.batch.map((id) => s.specimens.get(id)!);
    const all = s.data.specimens;
    return this.filter === "all" ? all : all.filter((x) => x.prior === null);
  }

  /** Ticked rows that are on screen — a bulk change never reaches a row you cannot see. */
  #pruneSelection() {
    const shown = new Set(this.#rows().map((r) => r.id));
    this.selected = new Set([...this.selected].filter((id) => shown.has(id)));
  }

  #setMode(mode: "sample" | "batch") {
    this.mode = mode;
    this.editing = null;
    this.#pruneSelection();
  }

  #addToBatch(ids: number[], what: string) {
    const have = new Set(this.batch);
    const fresh = ids.filter((id) => !have.has(id));
    this.batch = [...this.batch, ...fresh];
    const dup = ids.length - fresh.length;
    const row = (id: number) => this.batch.indexOf(id) + 1;
    this.added =
      fresh.length === 0 && ids.length === 1
        ? `${store().specimens.get(ids[0]!)?.fieldNumber} is already in the batch, row ${row(ids[0]!)}`
        : `Added ${fresh.length} ${what}${dup > 0 ? ` · ${dup} were already in the batch` : ""}`;
    this.flash = fresh[fresh.length - 1] ?? ids[ids.length - 1] ?? null;
    if (this.batch.length > this.limit) this.limit = this.batch.length;
    const last = this.flash;
    if (last !== null) this.updateComplete.then(() => this.querySelector(`[data-row="${last}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  #addNumbers(raw: string) {
    const s = store();
    const entries = tokens(raw).map((t) => resolve(t, s.data.specimens, s.data.season));
    if (entries.length === 0) return;
    const bad = entries.filter((e) => e.problem);
    const good = entries.filter((e) => !e.problem);
    this.problems = [...this.problems, ...bad];
    const ids = good.flatMap((e) => e.ids);
    if (ids.length > 0) this.#addToBatch(ids, good.length === 1 ? `(${good[0]!.text})` : `from ${good.length} entries`);
    else this.added = "";
  }

  #jump(input: HTMLInputElement) {
    const s = store();
    const entry = resolve(input.value.trim(), s.data.specimens, s.data.season);
    if (entry.problem || entry.ids.length !== 1) {
      this.jumpMessage = entry.problem ?? "go to one number at a time";
      return;
    }
    const id = entry.ids[0]!;
    if (this.filter === "outstanding" && s.specimens.get(id)?.prior) this.filter = "all";
    const index = this.#rows().findIndex((r) => r.id === id);
    if (index >= this.limit) this.limit = index + CHUNK;
    this.jumpMessage = "";
    this.flash = id;
    this.selected = new Set([...this.selected, id]);
    input.value = "";
    this.updateComplete.then(() => this.querySelector(`[data-row="${id}"]`)?.scrollIntoView({ block: "center" }));
  }

  #toggle(rows: Specimen[], index: number, shift: boolean) {
    const id = rows[index]!.id;
    const next = new Set(this.selected);
    if (shift && this.#anchor !== null) {
      const from = rows.findIndex((r) => r.id === this.#anchor);
      const [a, b] = from < index ? [from, index] : [index, from];
      const on = !this.selected.has(id);
      for (let i = a; i <= b; i++) (on ? next.add(rows[i]!.id) : next.delete(rows[i]!.id));
    } else {
      next.has(id) ? next.delete(id) : next.add(id);
      this.#anchor = id;
    }
    this.selected = next;
  }

  #toggleAll(group: Specimen[]) {
    const next = new Set(this.selected);
    const all = group.every((s) => next.has(s.id));
    for (const s of group) (all ? next.delete(s.id) : next.add(s.id));
    this.selected = next;
  }

  /** A bulk change applies at once and can be taken back whole. */
  #bulk(patch: { animalId?: number; sex?: string | null; caste?: string | null }, text: string) {
    const s = store();
    const before = new Map([...this.selected].map((id) => [id, s.drafts.get(id)] as const));
    s.setDrafts(this.selected, patch);
    this.lastBulk = { before, text };
  }

  #undoBulk() {
    if (!this.lastBulk) return;
    store().restoreDrafts(this.lastBulk.before);
    this.lastBulk = null;
  }

  #entered(sp: Specimen) {
    const s = store();
    const draft = s.drafts.get(sp.id);
    if (draft)
      return html`<span class="chip">draft · ${new Date(draft.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        <button type="button" class="outlined proto-small" @click=${() => s.clearDraft(sp.id)}>undo</button>`;
    const rec = s.lastEvent(sp.id);
    if (rec) return html`<span class="chip success">recorded ${new Date(rec.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>`;
    if (sp.prior) return html`<span class="meta">${sp.prior.channel === "legacy_import" ? "earlier, old system" : fmtDate(sp.prior.recordedAt.slice(0, 10))}</span>`;
    return nothing;
  }

  #bulkBar() {
    const s = store();
    const ids = [...this.selected];
    const n = ids.length;
    const currents = ids.map((id) => s.current(id));
    const social = n > 0 && currents.every((c) => hasCaste(c?.animalId ?? null));
    const first = currents[0];
    const sameSex = n > 0 && currents.every((c) => c?.sex === first?.sex && (c?.caste ?? null) === (first?.caste ?? null)) ? (first ?? null) : null;
    return html`<div class="proto-fillbar" ?data-empty=${n === 0}>
      <span class="proto-fill-count">${n === 0 ? "Tick rows to name several at once" : html`<strong>${n}</strong> ticked`}</span>
      <det-taxon-picker
        placeholder=${n === 0 ? "Name…" : `Name ${n === 1 ? "it" : `all ${n}`}…`}
        ?disabled=${n === 0}
        @pick=${(e: CustomEvent<number>) => this.#bulk({ animalId: e.detail }, `Named ${n} ${plainName(e.detail)}`)}
      ></det-taxon-picker>
      ${sexSegments(social ? first!.animalId : null, sameSex, (sex, caste) => this.#bulk({ sex, caste }, `Set sex on ${n}`), { disabled: n === 0, label: "Sex for the ticked rows" })}
      <span class="proto-fill-done">
        ${this.lastBulk
          ? html`<span class="meta">${this.lastBulk.text}.</span>
              <button type="button" class="outlined proto-small" @click=${() => this.#undoBulk()}>Undo</button>`
          : nothing}
      </span>
      ${this.mode === "sample"
        ? html`<button type="button" class="outlined proto-small" ?disabled=${n === 0}
            @click=${() => this.#addToBatch(s.data.specimens.filter((x) => this.selected.has(x.id)).map((x) => x.id), "ticked rows")}>Add to batch</button>`
        : html`<button type="button" class="outlined proto-small" ?disabled=${n === 0}
            @click=${() => { this.batch = this.batch.filter((id) => !this.selected.has(id)); this.selected = new Set(); }}>Take out of batch</button>`}
      <button type="button" class="outlined proto-small" ?disabled=${n === 0} @click=${() => (this.selected = new Set())}>Untick all</button>
    </div>`;
  }

  #row(sp: Specimen, rows: Specimen[], i: number, extra: { position?: number }) {
    const s = store();
    const cur = s.current(sp.id);
    const batch = this.mode === "batch";
    return html`<tr data-row=${sp.id} class=${[this.selected.has(sp.id) ? "proto-selected" : "", this.flash === sp.id ? "proto-flash" : ""].join(" ")}>
      <td class="proto-check">
        <input type="checkbox" .checked=${this.selected.has(sp.id)} aria-label=${`Tick ${sp.fieldNumber}`}
          @click=${(e: MouseEvent) => this.#toggle(rows, i, e.shiftKey)} />
      </td>
      ${batch ? html`<td class="proto-position meta">${extra.position}</td>` : nothing}
      <td class="proto-number">${sp.fieldNumber}</td>
      ${batch ? html`<td class="proto-sample-cell" title=${`${sampleLabel(sp)} · ${placeLabel(sp)}`}>${sampleLabel(sp)} · ${placeLabel(sp)}</td>` : nothing}
      <td class="proto-det">
        ${this.editing === sp.id
          ? html`<det-taxon-picker autofocus
              @pick=${(e: CustomEvent<number>) => { s.setDrafts([sp.id], { animalId: e.detail }); this.editing = null; }}
              @cancel=${() => (this.editing = null)}></det-taxon-picker>`
          : html`<button type="button" class="proto-cell" @click=${() => (this.editing = sp.id)}>
              ${cur?.animalId != null ? taxonName(cur.animalId, { rank: true }) : html`<span class="absent">add a name…</span>`}
            </button>`}
      </td>
      <td>${sexSegments(cur?.animalId ?? null, cur, (sex, caste) => s.setDrafts([sp.id], { sex, caste }))}</td>
      <td class="proto-entered">${this.#entered(sp)}</td>
      ${batch
        ? html`<td class="proto-check"><button type="button" class="proto-chip-x" aria-label=${`Take ${sp.fieldNumber} out of the batch`} title="Take out of the batch"
            @click=${() => { this.batch = this.batch.filter((id) => id !== sp.id); this.#pruneSelection(); }}>×</button></td>`
        : nothing}
    </tr>`;
  }

  #numberBox() {
    return html`<div class="proto-numbers">
      <label for="proto-numbers-input">Add to the batch</label>
      <div class="proto-numbers-box">
        ${this.problems.map(
          (e) => html`<span class="chip warning">
            ${e.text} — ${e.problem}
            <button type="button" class="proto-chip-x" aria-label=${`Dismiss ${e.text}`} @click=${() => (this.problems = this.problems.filter((p) => p !== e))}>×</button>
          </span>`,
        )}
        <input id="proto-numbers-input" type="text" inputmode="numeric" autocomplete="off" autofocus
          placeholder="26019685-697, 26027608 — or scan the labels in a box, one after another"
          @keydown=${(e: KeyboardEvent) => {
            if (e.key !== "Enter") return;
            const input = e.target as HTMLInputElement;
            this.#addNumbers(input.value);
            input.value = "";
          }}
          @paste=${(e: ClipboardEvent) => {
            e.preventDefault();
            this.#addNumbers(e.clipboardData?.getData("text") ?? "");
          }} />
      </div>
      ${this.added ? html`<span class="meta">${this.added}</span>` : nothing}
      ${this.batch.length > 0
        ? html`<button type="button" class="outlined proto-small" @click=${() => { this.batch = []; this.selected = new Set(); this.added = ""; }}>Empty the batch</button>`
        : nothing}
    </div>`;
  }

  override render() {
    const s = store();
    const rows = this.#rows();
    const shown = rows.slice(0, this.limit);
    const batch = this.mode === "batch";
    const drafts = s.drafts.size;
    const allTicked = rows.length > 0 && rows.every((r) => this.selected.has(r.id));
    let index = 0;
    const cols = batch ? 8 : 5;
    return html`
      <div class="proto-toolbar">
        <div class="segmented" role="group" aria-label="Mode">
          <a href="#" aria-current=${!batch ? "true" : nothing} @click=${(e: Event) => { e.preventDefault(); this.#setMode("sample"); }}>By sample</a>
          <a href="#" aria-current=${batch ? "true" : nothing} @click=${(e: Event) => { e.preventDefault(); this.#setMode("batch"); }}>Batch (${this.batch.length})</a>
        </div>
        ${batch
          ? nothing
          : html`<div class="segmented" role="group" aria-label="Rows">
              <a href="#" aria-current=${this.filter === "outstanding" ? "true" : nothing}
                @click=${(e: Event) => { e.preventDefault(); this.filter = "outstanding"; this.#pruneSelection(); }}>
                Not yet determined (${s.data.specimens.filter((x) => x.prior === null).length})
              </a>
              <a href="#" aria-current=${this.filter === "all" ? "true" : nothing}
                @click=${(e: Event) => { e.preventDefault(); this.filter = "all"; this.#pruneSelection(); }}>
                All (${s.data.specimens.length})
              </a>
            </div>
            <label class="proto-jump">
              Go to number
              <input type="text" inputmode="numeric" placeholder="26019685 or 685"
                @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") this.#jump(e.target as HTMLInputElement); }} />
            </label>
            ${this.jumpMessage ? html`<span class="chip warning">${this.jumpMessage}</span>` : nothing}`}
        <span class="proto-spacer"></span>
        <span class="meta">${drafts} draft${drafts === 1 ? "" : "s"}</span>
        <button type="button" class="tonal" ?disabled=${drafts === 0} @click=${() => s.record([...s.drafts.keys()])}
          title="Stands in for an export, a review or a print run consuming the rows">
          Simulate a freeze
        </button>
      </div>

      ${batch ? this.#numberBox() : nothing}
      ${this.#bulkBar()}

      <div class="table-scroll">
        <table class=${batch ? "proto-grid proto-grid-batch" : "proto-grid"}>
          <colgroup>
            <col class="proto-col-check" />
            ${batch ? html`<col class="proto-col-position" />` : nothing}
            <col class="proto-col-number" />
            ${batch ? html`<col class="proto-col-sample" />` : nothing}
            <col /><col class="proto-col-sex" /><col class="proto-col-entered" />
            ${batch ? html`<col class="proto-col-check" />` : nothing}
          </colgroup>
          <thead>
            <tr>
              <th class="proto-check"><input type="checkbox" .checked=${allTicked} aria-label=${`Tick all ${rows.length} shown`} title=${`Tick all ${rows.length} shown`} @click=${() => this.#toggleAll(rows)} /></th>
              ${batch ? html`<th>#</th>` : nothing}
              <th>Number</th>
              ${batch ? html`<th>Sample</th>` : nothing}
              <th>Determination</th><th>Sex</th><th>Entered</th>
              ${batch ? html`<th></th>` : nothing}
            </tr>
          </thead>
          ${batch
            ? html`<tbody>
                ${shown.length === 0
                  ? html`<tr><td colspan=${cols} class="meta">Nothing in the batch yet. Type or scan numbers above, or tick rows by sample and add them.</td></tr>`
                  : shown.map((sp, i) => this.#row(sp, rows, i, { position: i + 1 }))}
              </tbody>`
            : bySample(shown).map((group) => {
                const first = group[0]!;
                const allOn = group.every((x) => this.selected.has(x.id));
                const href = inatHref(first);
                return html`<tbody>
                  <tr class="proto-sample">
                    <td class="proto-check"><input type="checkbox" .checked=${allOn} aria-label="Tick this sample" @click=${() => this.#toggleAll(group)} /></td>
                    <td colspan="4">
                      <strong>${sampleLabel(first)}</strong> · ${placeLabel(first)}
                      ${first.host ? html` · on <i>${first.host}</i>` : nothing} · ${first.kind}
                      ${href ? html` · <a href=${href} target="_blank" rel="noopener">iNat ↗</a>` : nothing}
                    </td>
                  </tr>
                  ${group.map((sp) => this.#row(sp, rows, index++, {}))}
                </tbody>`;
              })}
        </table>
      </div>
      ${rows.length > shown.length
        ? html`<p><button type="button" class="tonal" @click=${() => (this.limit += CHUNK)}>Show ${Math.min(CHUNK, rows.length - shown.length)} more of ${rows.length - shown.length}</button></p>`
        : nothing}
      <p class="meta">To tick several rows in a row, tick the first, then hold Shift and tick the last. Rows save as you go and can be changed freely; once a row has been exported, reviewed or printed it is history, and changing it adds a newer determination rather than editing the old one.</p>
    `;
  }
}
customElements.define("det-proto-grid", GridVariant);
