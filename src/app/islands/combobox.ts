/**
 * The combobox (beeline-wn2): one text box with a list of choices under it,
 * for every field that offers known values. The rules — which options a
 * query shows, what each key does — are in combobox-model.ts; this element
 * draws them and talks to the page. WAI-ARIA's combobox pattern with list
 * autocomplete: the box is `role="combobox"`, the list a `listbox` of
 * `option`s, and the highlighted one is named by `aria-activedescendant`,
 * so focus never leaves the box.
 *
 * Two ways to supply the choices:
 *  - `options`, a fixed list, filtered as the person types and shown whole
 *    when the box is empty or holds one of them. The server draws these as
 *    a <datalist> (components/combobox.tsx), which is the whole control
 *    without scripting; this element reads them out of it when it starts.
 *  - `search`, a function from what is typed to options, for lists too long
 *    to send with the page (the taxon picker's). The list opens only once
 *    something is typed.
 *
 * Two ways to use a choice:
 *  - by default a pick fills the box, which submits under `name` with its
 *    form: a field.
 *  - `clear-on-pick` empties the box instead, and the page acts on the
 *    `pick` event's option: a picker.
 *
 * `free` lets text that is no option stand and submit; without it Enter
 * takes only a highlighted option. Events, all bubbling: `pick` (detail: the
 * option) and `cancel` (Escape).
 */
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { filterOptions, keyAction, type ComboboxOption } from "./combobox-model.js";
import { messagesFor } from "../messages/index.js";

const m = messagesFor(null);
let lists = 0;

export class BeelineCombobox extends LitElement {
  static properties = {
    name: {},
    value: {},
    inputId: { attribute: "input-id" },
    placeholder: {},
    type: {},
    disabled: { type: Boolean },
    autofocus: { type: Boolean },
    free: { type: Boolean },
    clearOnPick: { type: Boolean, attribute: "clear-on-pick" },
    emptyText: { attribute: "empty-text" },
    options: { attribute: false },
    search: { attribute: false },
    renderOption: { attribute: false },
    renderFooter: { attribute: false },
    query: { state: true },
    open: { state: true },
    active: { state: true },
  };
  declare name: string;
  declare value: string;
  declare inputId: string;
  declare placeholder: string;
  declare type: string;
  declare disabled: boolean;
  declare autofocus: boolean;
  declare free: boolean;
  declare clearOnPick: boolean;
  declare emptyText: string;
  declare options: ComboboxOption[];
  declare search: ((query: string) => ComboboxOption[]) | undefined;
  declare renderOption: ((option: ComboboxOption) => TemplateResult | string) | undefined;
  declare renderFooter: (() => TemplateResult) | undefined;
  declare query: string;
  declare open: boolean;
  declare active: number;
  /** What the box held when it was focused: what a second Escape puts back. */
  #initial = "";
  readonly #listId = `combobox-${++lists}`;

  constructor() {
    super();
    this.name = "";
    this.value = "";
    this.inputId = "";
    this.placeholder = "";
    this.type = "text";
    this.disabled = false;
    this.autofocus = false;
    this.free = false;
    this.clearOnPick = false;
    this.emptyText = m.combobox.noMatches;
    this.options = [];
    this.search = undefined;
    this.renderOption = undefined;
    this.renderFooter = undefined;
    this.query = "";
    this.open = false;
    this.active = -1;
  }

  override createRenderRoot() {
    return this; // light DOM, by convention for all islands
  }

  /**
   * Take over the fallback the server drew — a plain <input> with a
   * <datalist> — keeping its id (which its <label for> names), its name,
   * value and choices, and then remove it, since this element draws the box
   * itself.
   */
  override connectedCallback() {
    const input = this.querySelector<HTMLInputElement>(":scope input");
    if (input !== null) {
      this.inputId ||= input.id;
      this.name ||= input.name;
      this.value ||= input.value;
      this.placeholder ||= input.placeholder;
      const list = this.querySelector<HTMLDataListElement>(":scope datalist");
      if (list !== null && this.options.length === 0) {
        this.options = Array.from(list.options, (o) => ({ value: o.value, ...(o.label && o.label !== o.value ? { note: o.label } : {}) }));
      }
      this.replaceChildren();
    }
    this.query = this.value;
    super.connectedCallback();
  }

  override firstUpdated() {
    if (this.autofocus) this.querySelector("input")?.focus();
  }

  /** The options shown for what is in the box now. */
  #shown(): ComboboxOption[] {
    if (this.search !== undefined) return this.query.trim() === "" ? [] : this.search(this.query);
    return filterOptions(this.options, this.query);
  }

  /** Open the list, highlighting the option the box holds, if any. */
  #openList(shown: ComboboxOption[]) {
    this.open = true;
    const at = shown.findIndex((o) => o.value === this.query);
    this.active = at >= 0 ? at : -1;
  }

  #pick(option: ComboboxOption) {
    this.query = this.clearOnPick ? "" : option.value;
    this.open = false;
    this.active = -1;
    this.dispatchEvent(new CustomEvent<ComboboxOption>("pick", { detail: option, bubbles: true }));
  }

  #key(e: KeyboardEvent, shown: ComboboxOption[]) {
    if (!this.open && e.key === "ArrowDown" && shown.length > 0) {
      e.preventDefault();
      this.#openList(shown);
      if (this.active < 0 && !e.altKey) this.active = 0;
      return;
    }
    const r = keyAction({ open: this.open, active: this.active, count: shown.length, free: this.free }, e.key, e.altKey);
    if (r.prevent) e.preventDefault();
    const option = r.pick ? shown[this.active] : undefined;
    this.open = r.open;
    this.active = r.active;
    if (option !== undefined) this.#pick(option);
    if (r.revert || (r.cancel && this.clearOnPick)) this.query = this.clearOnPick ? "" : this.#initial;
    if (r.cancel) this.dispatchEvent(new CustomEvent("cancel", { bubbles: true }));
  }

  override render() {
    const shown = this.#shown();
    const showPanel = this.open && (shown.length > 0 || (this.search !== undefined && this.query.trim() !== "") || this.renderFooter !== undefined);
    const activeId = this.open && this.active >= 0 && this.active < shown.length ? `${this.#listId}-${this.active}` : nothing;
    return html`<div class="combobox">
      <input
        id=${this.inputId || nothing}
        name=${this.name || nothing}
        type=${this.type}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded=${showPanel ? "true" : "false"}
        aria-controls=${this.#listId}
        aria-activedescendant=${activeId}
        autocomplete="off"
        .value=${this.query}
        placeholder=${this.placeholder || nothing}
        ?disabled=${this.disabled}
        @input=${(e: InputEvent) => {
          this.query = (e.target as HTMLInputElement).value;
          this.open = true;
          this.active = this.search !== undefined ? 0 : -1;
        }}
        @focus=${() => {
          this.#initial = this.query;
          // A fixed list opens on focus, so its choices are seen before
          // anything is typed; a search waits for a query.
          if (this.search === undefined) this.#openList(shown);
          else this.open = true;
        }}
        @click=${() => {
          if (!this.open && this.search === undefined) this.#openList(shown);
        }}
        @blur=${() => setTimeout(() => (this.open = false), 150)}
        @keydown=${(e: KeyboardEvent) => this.#key(e, shown)}
      />
      ${this.search === undefined
        ? html`<button
            type="button"
            class="combobox-toggle"
            tabindex="-1"
            aria-label=${m.combobox.toggle}
            aria-controls=${this.#listId}
            aria-expanded=${showPanel ? "true" : "false"}
            ?disabled=${this.disabled}
            @mousedown=${(e: Event) => {
              // Keep focus in the box, which is where the keys work. Whether
              // the list was open is read first: focusing the box opens it.
              e.preventDefault();
              const wasOpen = this.open;
              this.querySelector("input")?.focus();
              if (wasOpen) this.open = false;
              else this.#openList(filterOptions(this.options, ""));
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" width="16" height="16" class="icon icon-small" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          </button>`
        : nothing}
      ${showPanel
        ? html`<div class="combobox-panel">
            ${shown.length === 0
              ? html`<p class="meta">${this.emptyText}</p>`
              : html`<ul role="listbox" id=${this.#listId}>
                  ${shown.map(
                    (o, i) => html`<li
                      role="option"
                      id=${`${this.#listId}-${i}`}
                      aria-selected=${i === this.active ? "true" : "false"}
                      @mousedown=${(e: Event) => {
                        e.preventDefault();
                        this.#pick(o);
                      }}
                    >
                      ${this.renderOption !== undefined ? this.renderOption(o) : html`<span>${o.label ?? o.value}</span>`}
                      ${o.note !== undefined && this.renderOption === undefined ? html`<span class="meta">${o.note}</span>` : nothing}
                    </li>`,
                  )}
                </ul>`}
            ${this.renderFooter !== undefined ? this.renderFooter() : nothing}
          </div>`
        : nothing}
    </div>`;
  }
}
customElements.define("beeline-combobox", BeelineCombobox);
