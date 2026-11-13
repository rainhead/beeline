/**
 * The name picker for Identify your specimens (beeline-bcq): a search over
 * the curated taxonomy, never free text — what comes out is a node, so a
 * misspelling or a genus filed under the wrong family cannot be entered.
 * Bees by default; anyone may widen it to bycatch.
 */
import { html, LitElement, nothing } from "lit";
import { matchesWords, type ComboboxOption } from "../combobox-model.js";
import "../combobox.js";
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
let pickers = 0;

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
    if (!matchesWords(query, t.name)) continue;
    const words = t.name.toLowerCase().replace(/[()]/g, "").split(/\s+/);
    const exact = words.join(" ") === q.join(" ");
    out.push({ t, score: (exact ? 1e9 : 0) + Math.log(t.uses + 1) * 10 + (t.bee ? 5 : 0) - words.length });
  }
  return out
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((o) => o.t);
}

/**
 * The general combobox (../combobox.ts) with the taxonomy as its search: it
 * supplies the names, how they are matched and how they are drawn, and the
 * bycatch switch under the list, and turns a pick into a `pick` event
 * carrying the taxon. Never free text, and the box empties on a pick, since
 * what the page wants is the node, not the words.
 */
export class DetermineTaxonPicker extends LitElement {
  static properties = {
    placeholder: {},
    label: {},
    autofocus: { type: Boolean },
    disabled: { type: Boolean },
    bycatch: { state: true },
    taxa: { state: true },
  };
  declare placeholder: string;
  declare label: string;
  declare autofocus: boolean;
  declare disabled: boolean;
  declare bycatch: boolean;
  declare taxa: PickerTaxon[];

  /**
   * The box is named a search because of Safari. Safari offers the Mac's
   * contacts in a box it guesses wants a person, beside our own list, and
   * ignores `autocomplete="off"`: Apple leaves AutoFill to the person's
   * settings. Its guess is not documented. On a page of eight variants of
   * this box (Peter, Safari, 2026-11-13) the only ones that never offered
   * contacts were the two whose `name` and `id` contain "search"; the others
   * did so on and off, with or without the word "name" in the grey text or
   * the label. Nothing submits the box, so the name is only for Safari to
   * read (GitHub #316, beeline-9u06).
   */
  readonly #searchId = `taxon-search-${++pickers}`;

  constructor() {
    super();
    this.placeholder = m.determine.picker.placeholder;
    this.label = "";
    this.autofocus = false;
    this.disabled = false;
    this.bycatch = false;
    this.taxa = [];
  }

  override createRenderRoot() {
    return this; // light DOM, by convention for all islands
  }

  override connectedCallback() {
    super.connectedCallback();
    loadTaxa().then((t) => (this.taxa = t)).catch(() => undefined);
  }

  override render() {
    const p = m.determine.picker;
    const search = (query: string): ComboboxOption<PickerTaxon>[] =>
      searchTaxa(this.taxa, query, this.bycatch).map((t) => ({ value: t.name, data: t }));
    return html`<beeline-combobox
      class="determine-picker"
      type="search"
      name="taxon-search"
      input-id=${this.#searchId}
      clear-on-pick
      placeholder=${this.placeholder}
      label=${this.label}
      ?autofocus=${this.autofocus}
      ?disabled=${this.disabled}
      empty-text=${this.bycatch ? p.noNames : p.noBees}
      .search=${search}
      .renderOption=${(o: ComboboxOption) => {
        const t = o.data as PickerTaxon;
        return html`${nameTemplate(t)} <span class="determine-rank">${t.rank}</span>
          <span class="meta">${t.rank === "family" ? "" : (t.family ?? "")}</span>`;
      }}
      .renderFooter=${() => html`<label class="determine-bycatch" @mousedown=${(e: Event) => e.preventDefault()}>
        <input type="checkbox" .checked=${this.bycatch} @change=${() => (this.bycatch = !this.bycatch)} />
        ${p.bycatch}
      </label>`}
      @pick=${(e: CustomEvent<ComboboxOption>) => {
        e.stopPropagation();
        this.dispatchEvent(new CustomEvent<PickerTaxon>("pick", { detail: e.detail.data as PickerTaxon, bubbles: true }));
      }}
    ></beeline-combobox>`;
  }
}
customElements.define("determine-taxon-picker", DetermineTaxonPicker);
