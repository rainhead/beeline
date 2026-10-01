/**
 * PROTOTYPE (beeline-bcq), variant A — the grid from the August wireframes.
 *
 * Every specimen is already a row, so a number is never typed. Select rows
 * (click, shift-click, or a whole sample) and fill them down: coarse first —
 * the box is all Bombus — then refine a few to species. Rows save as drafts
 * as you go; they become determinations only when something downstream
 * consumes them (an export, a review, a print), which the "freeze" button
 * stands in for here.
 */
import { html, nothing } from "lit";
import { Light } from "./shared.js";
import {
  bySample,
  inatHref,
  placeLabel,
  sampleLabel,
  sexChoices,
  sexLabel,
  store,
  taxonName,
  type Specimen,
} from "./store.js";

const CHUNK = 400;

class GridVariant extends Light {
  static properties = {
    filter: { state: true },
    selected: { state: true },
    editing: { state: true },
    fillAnimal: { state: true },
    fillSex: { state: true },
    limit: { state: true },
    jumpMessage: { state: true },
    flash: { state: true },
  };
  declare filter: "outstanding" | "all";
  declare selected: Set<number>;
  declare editing: number | null;
  declare fillAnimal: number | null;
  /** undefined: keep each row's own. */
  declare fillSex: { sex: string | null; caste: string | null } | undefined;
  declare limit: number;
  declare jumpMessage: string;
  declare flash: number | null;
  #anchor: number | null = null;
  #onChange = () => this.requestUpdate();

  constructor() {
    super();
    this.filter = "outstanding";
    this.selected = new Set();
    this.editing = null;
    this.fillAnimal = null;
    this.fillSex = undefined;
    this.limit = CHUNK;
    this.jumpMessage = "";
    this.flash = null;
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
   * Outstanding means "had no determination when you sat down", not "has
   * none now" — a row you just filled must not vanish under you, or the
   * coarse-then-fine pass has nothing left to refine.
   */
  #rows(): Specimen[] {
    const all = store().data.specimens;
    return this.filter === "all" ? all : all.filter((s) => s.prior === null);
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

  #toggleSample(group: Specimen[]) {
    const next = new Set(this.selected);
    const all = group.every((s) => next.has(s.id));
    for (const s of group) (all ? next.delete(s.id) : next.add(s.id));
    this.selected = next;
  }

  #apply() {
    if (this.fillAnimal === null && this.fillSex === undefined) return;
    const patch: { animalId?: number; sex?: string | null; caste?: string | null } = {};
    if (this.fillAnimal !== null) patch.animalId = this.fillAnimal;
    if (this.fillSex !== undefined) Object.assign(patch, this.fillSex);
    store().setDrafts(this.selected, patch);
    this.selected = new Set();
  }

  #jump(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    const input = e.target as HTMLInputElement;
    const typed = input.value.trim();
    if (typed === "") return;
    const s = store();
    const hits = s.data.specimens.filter((x) => x.fieldNumber === typed || (typed.length >= 3 && x.fieldNumber?.endsWith(typed)));
    if (hits.length !== 1) {
      this.jumpMessage = hits.length === 0 ? `${typed} is not one of your ${s.data.season} specimens.` : `${hits.length} of your numbers end in ${typed} — type more of it.`;
      return;
    }
    const hit = hits[0]!;
    if (this.filter === "outstanding" && hit.prior !== null) this.filter = "all";
    const rows = this.#rows();
    const index = rows.findIndex((r) => r.id === hit.id);
    if (index >= this.limit) this.limit = index + CHUNK;
    this.jumpMessage = "";
    this.flash = hit.id;
    this.selected = new Set([...this.selected, hit.id]);
    input.value = "";
    this.updateComplete.then(() => this.querySelector(`[data-row="${hit.id}"]`)?.scrollIntoView({ block: "center" }));
  }

  override render() {
    const s = store();
    const rows = this.#rows();
    const shown = rows.slice(0, this.limit);
    const groups = bySample(shown);
    let index = 0;
    const drafts = s.drafts.size;
    return html`
      <div class="proto-toolbar">
        <div class="segmented" role="group" aria-label="Rows">
          <a href="#" aria-current=${this.filter === "outstanding" ? "true" : nothing} @click=${(e: Event) => { e.preventDefault(); this.filter = "outstanding"; }}>
            Not yet determined (${s.data.specimens.filter((x) => x.prior === null).length})
          </a>
          <a href="#" aria-current=${this.filter === "all" ? "true" : nothing} @click=${(e: Event) => { e.preventDefault(); this.filter = "all"; }}>
            All (${s.data.specimens.length})
          </a>
        </div>
        <label class="proto-jump">
          Go to number
          <input type="text" inputmode="numeric" placeholder="26000412 or 412" @keydown=${(e: KeyboardEvent) => this.#jump(e)} />
        </label>
        ${this.jumpMessage ? html`<span class="chip warning">${this.jumpMessage}</span>` : nothing}
        <span class="proto-spacer"></span>
        <span class="meta">${drafts} draft${drafts === 1 ? "" : "s"} not yet history</span>
        <button type="button" class="tonal" ?disabled=${drafts === 0} @click=${() => s.record([...s.drafts.keys()])}
          title="Stands in for an export, a review or a print run consuming the rows">
          Simulate a freeze
        </button>
      </div>

      ${this.selected.size > 0
        ? html`<div class="proto-fillbar">
            <strong>${this.selected.size} selected</strong>
            <span>set to</span>
            ${this.fillAnimal === null
              ? html`<det-taxon-picker placeholder="Name for all of them…" @pick=${(e: CustomEvent<number>) => (this.fillAnimal = e.detail)}></det-taxon-picker>`
              : html`<span class="proto-fill-name">${taxonName(this.fillAnimal, { rank: true })}
                  <button type="button" class="outlined proto-small" @click=${() => (this.fillAnimal = null)}>change</button></span>`}
            <div class="proto-sex" role="group" aria-label="Sex for all of them">
              <button type="button" class=${this.fillSex === undefined ? "" : "outlined"} @click=${() => (this.fillSex = undefined)}>Keep each row's</button>
              ${sexChoices(this.fillAnimal).map(
                (c) => html`<button type="button" class=${this.fillSex?.sex === c.sex && this.fillSex?.caste === c.caste ? "" : "outlined"}
                  @click=${() => (this.fillSex = { sex: c.sex, caste: c.caste })}>${c.label}</button>`,
              )}
            </div>
            <button type="button" ?disabled=${this.fillAnimal === null && this.fillSex === undefined} @click=${() => this.#apply()}>Apply to ${this.selected.size}</button>
            <button type="button" class="outlined" @click=${() => (this.selected = new Set())}>Clear selection</button>
          </div>`
        : html`<p class="meta proto-hint">Tick rows (shift-click for a run, or a sample's own box for all of it), then name them all at once. Naming a run of them Bombus now and three of them Bombus vosnesenskii later is the normal way through a box.</p>`}

      <div class="table-scroll">
        <table class="proto-grid">
          <thead>
            <tr><th class="proto-check"></th><th>Number</th><th>Determination</th><th>Sex</th><th>Status</th></tr>
          </thead>
          ${groups.map((group) => {
            const first = group[0]!;
            const allOn = group.every((x) => this.selected.has(x.id));
            const href = inatHref(first);
            return html`<tbody>
              <tr class="proto-sample">
                <td class="proto-check"><input type="checkbox" .checked=${allOn} aria-label="Select this sample" @click=${() => this.#toggleSample(group)} /></td>
                <td colspan="4">
                  <strong>${sampleLabel(first)}</strong> · ${placeLabel(first)}
                  ${first.host ? html` · on <i>${first.host}</i>` : nothing} · ${first.kind}
                  ${href ? html` · <a href=${href} target="_blank" rel="noopener">iNat ↗</a>` : nothing}
                </td>
              </tr>
              ${group.map((sp) => {
                const i = index++;
                const cur = s.current(sp.id);
                const draft = s.drafts.get(sp.id);
                const rec = s.lastEvent(sp.id);
                return html`<tr data-row=${sp.id} class=${[this.selected.has(sp.id) ? "proto-selected" : "", this.flash === sp.id ? "proto-flash" : ""].join(" ")}>
                  <td class="proto-check">
                    <input type="checkbox" .checked=${this.selected.has(sp.id)} aria-label=${`Select ${sp.fieldNumber}`}
                      @click=${(e: MouseEvent) => this.#toggle(rows, i, e.shiftKey)} />
                  </td>
                  <td class="nowrap proto-number">${sp.fieldNumber}</td>
                  <td class="proto-det">
                    ${this.editing === sp.id
                      ? html`<det-taxon-picker autofocus
                          @pick=${(e: CustomEvent<number>) => { s.setDrafts([sp.id], { animalId: e.detail }); this.editing = null; }}
                          @cancel=${() => (this.editing = null)}></det-taxon-picker>`
                      : html`<button type="button" class="proto-cell" @click=${() => (this.editing = sp.id)}>
                          ${cur?.animalId != null ? taxonName(cur.animalId, { rank: true }) : html`<span class="absent">add a name…</span>`}
                        </button>`}
                  </td>
                  <td>
                    <select aria-label="Sex" @change=${(e: Event) => {
                      const v = (e.target as HTMLSelectElement).value;
                      const c = sexChoices(cur?.animalId ?? null).find((x) => x.label === v);
                      s.setDrafts([sp.id], { sex: c?.sex ?? null, caste: c?.caste ?? null });
                    }}>
                      <option value="" ?selected=${!cur?.sex}>—</option>
                      ${sexChoices(cur?.animalId ?? null).map((c) => html`<option ?selected=${sexLabel(cur) === c.label}>${c.label}</option>`)}
                    </select>
                  </td>
                  <td class="nowrap">
                    ${draft
                      ? html`<span class="chip">draft · ${new Date(draft.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                          <button type="button" class="outlined proto-small" @click=${() => s.clearDraft(sp.id)}>undo</button>`
                      : rec
                        ? html`<span class="chip success">recorded</span>`
                        : sp.prior
                          ? html`<span class="meta">entered ${sp.prior.recordedAt.slice(0, 10)}</span>`
                          : html`<span class="absent">not yet</span>`}
                  </td>
                </tr>`;
              })}
            </tbody>`;
          })}
        </table>
      </div>
      ${rows.length > shown.length
        ? html`<p><button type="button" class="tonal" @click=${() => (this.limit += CHUNK)}>Show ${Math.min(CHUNK, rows.length - shown.length)} more of ${rows.length - shown.length}</button></p>`
        : nothing}
      <p class="meta">Rows save as you go and can be changed freely. Once a row has been exported, reviewed or printed it is history, and changing it adds a newer determination rather than editing the old one.</p>
    `;
  }
}
customElements.define("det-proto-grid", GridVariant);

