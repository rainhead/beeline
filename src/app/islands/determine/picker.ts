/**
 * The name picker for Identify your specimens (beeline-bcq): a search over
 * the curated taxonomy, never free text — what comes out is a node, so a
 * misspelling or a genus filed under the wrong family cannot be entered.
 * Bees by default; anyone may widen it to bycatch, which also searches
 * Ecdysis's list of insect names for those the tree does not hold yet
 * (beeline-4wx3).
 */
import { html, LitElement, nothing } from "lit";
import { matchesWords, type ComboboxOption } from "../combobox-model.js";
import "../combobox.js";
import { messagesFor } from "../../messages/index.js";

const m = messagesFor(null);

export interface PickerTaxon {
  /**
   * The tree's entity id; for a name from Ecdysis the tree lacks, its Ecdysis
   * id made negative, which no entity id is. The page keys its names by this
   * (rowTaxa in src/app/determine.ts makes the same keys).
   */
  id: number;
  rank: string;
  name: string;
  family: string | null;
  order: string | null;
  bee: boolean;
  castes: boolean;
  uses: number;
  /** Set on a name from Ecdysis the tree does not hold yet: the draft names it by this id. */
  ecdysisTid?: number;
}

/** A name from the server's search of Ecdysis (searchEcdysisNames). */
interface EcdysisName {
  tid: number;
  rank: string;
  name: string;
  family: string | null;
  order: string | null;
}

let taxaPromise: Promise<PickerTaxon[]> | null = null;
let pickers = 0;

/**
 * Whether the bycatch box is ticked: one answer for every picker on the
 * page, since the grid makes a new picker for each row it edits and someone
 * naming a tray of wasps should not have to tick it on every row.
 */
let widened = false;
const live = new Set<DetermineTaxonPicker>();

/** The whole list, fetched once per page and shared by every picker on it. */
export function loadTaxa(): Promise<PickerTaxon[]> {
  taxaPromise ??= fetch("/determinations/taxa.json", { credentials: "same-origin" }).then((r) => {
    if (!r.ok) throw new Error(`taxa: ${r.status}`);
    return r.json() as Promise<PickerTaxon[]>;
  });
  return taxaPromise;
}

/** The server answers nothing for fewer letters than this (ECDYSIS_SEARCH_MIN in src/app/determine.ts). */
const ECDYSIS_MIN = 3;

/**
 * What Ecdysis's search answered for each query typed, shared by every
 * picker on the page: "pending" while asked, "failed" if it could not be.
 */
const ecdysisAnswers = new Map<string, EcdysisName[] | "pending" | "failed">();

const queryKey = (query: string) => query.toLowerCase().replace(/[().]/g, " ").split(/\s+/).filter(Boolean).join(" ");

/** A name from Ecdysis in the picker's shape. Never a bee (the server leaves bees out), so no castes. */
export const fromEcdysis = (e: EcdysisName): PickerTaxon => ({
  id: -e.tid,
  rank: e.rank,
  name: e.name,
  family: e.family,
  order: e.order,
  bee: false,
  castes: false,
  uses: 0,
  ecdysisTid: e.tid,
});

const ITALIC = new Set(["genus", "subgenus", "species", "subspecies"]);
export const isItalic = (rank: string) => ITALIC.has(rank);

/** A name set the way TaxonName sets it: italic at genus and below. */
export const nameTemplate = (t: { name: string; rank: string } | undefined) =>
  t === undefined ? nothing : html`<span class="taxon">${isItalic(t.rank) ? html`<i>${t.name}</i>` : t.name}</span>`;

/**
 * What goes beside a name: its family for a bee; for anything else its
 * family and order, or the order alone at family rank and above, so that a
 * katydid cannot be taken for a wasp spelled the same way.
 */
export function placeOf(t: PickerTaxon): string {
  const family = t.rank === "family" ? null : t.family;
  if (t.bee) return family ?? "";
  const order = t.rank === "order" ? null : t.order;
  return [family, order].filter((s) => s !== null && s !== "").join(" · ");
}

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
 * The tree's matches, then Ecdysis's for the same query once they have come
 * back, leaving out any name the tree's list already has. The tree's come
 * first and stay put, so the option Enter takes does not change under the
 * person's finger when Ecdysis answers.
 */
export function mergeNames(tree: readonly PickerTaxon[], ecdysis: readonly EcdysisName[], limit = 8): PickerTaxon[] {
  const held = new Set(tree.map((t) => t.name));
  return [...tree, ...ecdysis.filter((e) => !held.has(e.name)).slice(0, limit).map(fromEcdysis)];
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
  /** What the box held at the last search, and how many names it found: what the footer reports on. */
  #query = "";
  #found = 0;
  #askTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.placeholder = m.determine.picker.placeholder;
    this.label = "";
    this.autofocus = false;
    this.disabled = false;
    this.bycatch = widened;
    this.taxa = [];
  }

  override createRenderRoot() {
    return this; // light DOM, by convention for all islands
  }

  override connectedCallback() {
    super.connectedCallback();
    live.add(this);
    this.bycatch = widened;
    loadTaxa().then((t) => (this.taxa = t)).catch(() => undefined);
  }

  override disconnectedCallback() {
    live.delete(this);
    clearTimeout(this.#askTimer);
    super.disconnectedCallback();
  }

  /**
   * Ask Ecdysis's search for a query once typing pauses, unless it has been
   * asked already. Every picker on the page redraws when the answer comes,
   * since they share the answers.
   */
  #ask(key: string) {
    clearTimeout(this.#askTimer);
    if (ecdysisAnswers.has(key)) return;
    this.#askTimer = setTimeout(() => {
      if (ecdysisAnswers.has(key)) return;
      ecdysisAnswers.set(key, "pending");
      fetch(`/determinations/ecdysis.json?q=${encodeURIComponent(key)}`, { credentials: "same-origin" })
        .then((r) => {
          if (!r.ok) throw new Error(`ecdysis: ${r.status}`);
          return r.json() as Promise<EcdysisName[]>;
        })
        .then((names) => ecdysisAnswers.set(key, names))
        // Forgotten after a failure, so typing the same query again asks again.
        .catch(() => {
          ecdysisAnswers.set(key, "failed");
          setTimeout(() => ecdysisAnswers.delete(key), 5000);
        })
        .finally(() => {
          for (const p of live) p.requestUpdate();
        });
    }, 250);
  }

  #search(query: string): PickerTaxon[] {
    this.#query = query;
    const found = this.#names(query);
    this.#found = found.length;
    return found;
  }

  #names(query: string): PickerTaxon[] {
    const tree = searchTaxa(this.taxa, query, this.bycatch);
    const key = queryKey(query);
    if (!this.bycatch || (key.split(" ")[0] ?? "").length < ECDYSIS_MIN) return tree;
    const answer = ecdysisAnswers.get(key);
    if (answer === undefined) this.#ask(key);
    return Array.isArray(answer) ? mergeNames(tree, answer) : tree;
  }

  /**
   * Under the list, once the box is ticked, and in place of the combobox's
   * own "nothing matches", which would show while Ecdysis is still being
   * asked: whether it is, whether it could not be, or that nothing matched.
   */
  #ecdysisStatus() {
    const p = m.determine.picker;
    if (!this.bycatch) return nothing;
    const key = queryKey(this.#query);
    if ((key.split(" ")[0] ?? "").length < ECDYSIS_MIN) {
      return html`${this.#found === 0 ? html`<p class="meta">${p.noNames}</p>` : nothing}
        <p class="meta">${p.ecdysisShort(ECDYSIS_MIN)}</p>`;
    }
    const answer = ecdysisAnswers.get(key);
    if (answer === "failed") return html`<p class="meta">${p.ecdysisFailed}</p>`;
    if (answer === undefined || answer === "pending") return html`<p class="meta">${p.searchingEcdysis}</p>`;
    return this.#found === 0 ? html`<p class="meta">${p.noNames}</p>` : nothing;
  }

  override render() {
    const p = m.determine.picker;
    const search = (query: string): ComboboxOption<PickerTaxon>[] => this.#search(query).map((t) => ({ value: t.name, data: t }));
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
      empty-text=${this.bycatch ? "" : p.noBees}
      .search=${search}
      .renderOption=${(o: ComboboxOption) => {
        const t = o.data as PickerTaxon;
        return html`${nameTemplate(t)} <span class="determine-rank">${t.rank}</span>
          ${t.ecdysisTid !== undefined ? html`<span class="determine-new" title=${p.fromEcdysisTitle}>${p.fromEcdysis}</span>` : nothing}
          <span class="meta">${placeOf(t)}</span>`;
      }}
      .renderFooter=${() => html`${this.#ecdysisStatus()}
        <label class="determine-bycatch" @mousedown=${(e: Event) => e.preventDefault()}>
          <input
            type="checkbox"
            .checked=${this.bycatch}
            @change=${() => {
              widened = !this.bycatch;
              for (const p of live) p.bycatch = widened;
            }}
          />
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
