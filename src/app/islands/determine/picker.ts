/**
 * The name picker for Identify your specimens (beeline-bcq): a search over
 * the curated taxonomy, never free text — what comes out is a node, so a
 * misspelling or a genus filed under the wrong family cannot be entered.
 * Bees by default; anyone may widen it to bycatch.
 */
import { html, LitElement, nothing } from "lit";
import { messagesFor } from "../../messages/index.js";

const m = messagesFor(null);

export interface PickerTaxon {
  id: number;
  rank: string;
  name: string;
  family: string | null;
  bee: boolean;
  castes: boolean;
  uses: number;
}

let taxaPromise: Promise<PickerTaxon[]> | null = null;

/** The whole list, fetched once per page and shared by every picker on it. */
export function loadTaxa(): Promise<PickerTaxon[]> {
  taxaPromise ??= fetch("/determinations/taxa.json", { credentials: "same-origin" }).then((r) => {
    if (!r.ok) throw new Error(`taxa: ${r.status}`);
    return r.json() as Promise<PickerTaxon[]>;
  });
  return taxaPromise;
}

const ITALIC = new Set(["genus", "subgenus", "species", "subspecies"]);
export const isItalic = (rank: string) => ITALIC.has(rank);

/** A name set the way TaxonName sets it: italic at genus and below. */
export const nameTemplate = (t: { name: string; rank: string } | undefined) =>
  t === undefined ? nothing : html`<span class="taxon">${isItalic(t.rank) ? html`<i>${t.name}</i>` : t.name}</span>`;

/**
 * Every word typed must start a word of the name, in order: `bom vos` finds
 * Bombus vosnesenskii, `b vos` too. Commoner names first, bees before
 * bycatch, an exact match before everything.
 */
export function searchTaxa(taxa: readonly PickerTaxon[], query: string, bycatch: boolean, limit = 10): PickerTaxon[] {
  const q = query.toLowerCase().replace(/[().]/g, " ").split(/\s+/).filter(Boolean);
  if (q.length === 0) return [];
  const out: { t: PickerTaxon; score: number }[] = [];
  for (const t of taxa) {
    if (!bycatch && !t.bee) continue;
    const words = t.name.toLowerCase().replace(/[()]/g, "").split(/\s+/);
    let i = 0;
    for (const w of words) if (i < q.length && w.startsWith(q[i]!)) i++;
    if (i < q.length) continue;
    const exact = words.join(" ") === q.join(" ");
    out.push({ t, score: (exact ? 1e9 : 0) + Math.log(t.uses + 1) * 10 + (t.bee ? 5 : 0) - words.length });
  }
  return out
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((o) => o.t);
}

export class DetermineTaxonPicker extends LitElement {
  static properties = {
    placeholder: {},
    autofocus: { type: Boolean },
    disabled: { type: Boolean },
    query: { state: true },
    active: { state: true },
    bycatch: { state: true },
    open: { state: true },
    taxa: { state: true },
  };
  declare placeholder: string;
  declare autofocus: boolean;
  declare disabled: boolean;
  declare query: string;
  declare active: number;
  declare bycatch: boolean;
  declare open: boolean;
  declare taxa: PickerTaxon[];

  constructor() {
    super();
    this.placeholder = m.determine.picker.placeholder;
    this.autofocus = false;
    this.disabled = false;
    this.query = "";
    this.active = 0;
    this.bycatch = false;
    this.open = false;
    this.taxa = [];
  }

  override createRenderRoot() {
    return this; // light DOM, by convention for all islands
  }

  override connectedCallback() {
    super.connectedCallback();
    loadTaxa().then((t) => (this.taxa = t)).catch(() => undefined);
  }

  override firstUpdated() {
    if (this.autofocus) this.querySelector("input")?.focus();
  }

  #pick(t: PickerTaxon) {
    this.query = "";
    this.open = false;
    this.dispatchEvent(new CustomEvent<PickerTaxon>("pick", { detail: t, bubbles: true }));
  }

  #key(e: KeyboardEvent, results: PickerTaxon[]) {
    if (e.key === "ArrowDown") {
      this.active = Math.min(this.active + 1, results.length - 1);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      this.active = Math.max(this.active - 1, 0);
      e.preventDefault();
    } else if (e.key === "Enter") {
      const t = results[this.active];
      if (t) this.#pick(t);
      e.preventDefault();
    } else if (e.key === "Escape") {
      this.query = "";
      this.open = false;
      this.dispatchEvent(new CustomEvent("cancel", { bubbles: true }));
    }
  }

  override render() {
    const p = m.determine.picker;
    const results = searchTaxa(this.taxa, this.query, this.bycatch);
    const listId = `picker-${this.id || Math.random().toString(36).slice(2)}`;
    return html`<div class="determine-picker">
      <input
        type="search"
        role="combobox"
        aria-expanded=${this.open && this.query.trim() !== ""}
        aria-controls=${listId}
        autocomplete="off"
        .value=${this.query}
        placeholder=${this.placeholder}
        ?disabled=${this.disabled}
        @input=${(e: InputEvent) => {
          this.query = (e.target as HTMLInputElement).value;
          this.active = 0;
          this.open = true;
        }}
        @focus=${() => (this.open = true)}
        @blur=${() => setTimeout(() => (this.open = false), 150)}
        @keydown=${(e: KeyboardEvent) => this.#key(e, results)}
      />
      ${this.open && this.query.trim() !== ""
        ? html`<div class="determine-picker-panel">
            ${results.length === 0
              ? html`<p class="meta">${this.bycatch ? p.noNames : p.noBees}</p>`
              : html`<ul role="listbox" id=${listId}>
                  ${results.map(
                    (t, i) => html`<li
                      role="option"
                      aria-selected=${i === this.active}
                      @mousedown=${(e: Event) => {
                        e.preventDefault();
                        this.#pick(t);
                      }}
                    >
                      ${nameTemplate(t)} <span class="determine-rank">${t.rank}</span>
                      <span class="meta">${t.rank === "family" ? "" : (t.family ?? "")}</span>
                    </li>`,
                  )}
                </ul>`}
            <label class="determine-bycatch" @mousedown=${(e: Event) => e.preventDefault()}>
              <input type="checkbox" .checked=${this.bycatch} @change=${() => (this.bycatch = !this.bycatch)} />
              ${p.bycatch}
            </label>
          </div>`
        : nothing}
    </div>`;
  }
}
customElements.define("determine-taxon-picker", DetermineTaxonPicker);
