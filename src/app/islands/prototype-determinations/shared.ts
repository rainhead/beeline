/**
 * PROTOTYPE (beeline-bcq) — pieces every variant uses: the taxon picker, the
 * sex/caste choice, the ledger of what would be recorded, and the variant
 * switcher.
 */
import { html, LitElement, nothing } from "lit";
import { plainName, searchTaxa, sexChoices, sexLabel, store, taxonName, type Assertion, type Taxon } from "./store.js";

/** Light DOM, like every island here, so the app's stylesheets reach in. */
export class Light extends LitElement {
  override createRenderRoot() {
    return this;
  }
}

/**
 * A name search over the curated taxonomy. Never free text: what comes out is
 * a node, so a misspelling or a genus filed under the wrong family cannot be
 * entered at all.
 */
export class TaxonPicker extends Light {
  static properties = {
    placeholder: {},
    autofocus: { type: Boolean },
    query: { state: true },
    active: { state: true },
    bycatch: { state: true },
    open: { state: true },
  };
  declare placeholder: string;
  declare autofocus: boolean;
  declare query: string;
  declare active: number;
  declare bycatch: boolean;
  declare open: boolean;

  constructor() {
    super();
    this.placeholder = "Type a name — bom vos, osmia, halictidae…";
    this.query = "";
    this.active = 0;
    this.bycatch = false;
    this.open = false;
  }

  override firstUpdated() {
    if (this.autofocus) this.querySelector("input")?.focus();
  }

  focus() {
    this.querySelector("input")?.focus();
  }

  #pick(t: Taxon) {
    this.query = "";
    this.open = false;
    this.dispatchEvent(new CustomEvent("pick", { detail: t.id, bubbles: true }));
  }

  #key(e: KeyboardEvent, results: Taxon[]) {
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
    const results = searchTaxa(this.query, { bycatch: this.bycatch });
    return html`<div class="proto-picker">
      <input
        type="search"
        autocomplete="off"
        .value=${this.query}
        placeholder=${this.placeholder}
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
        ? html`<div class="proto-picker-panel">
            ${results.length === 0
              ? html`<p class="meta">No ${this.bycatch ? "" : "bee "}name starts like that.</p>`
              : html`<ul role="listbox">
                  ${results.map(
                    (t, i) => html`<li
                      role="option"
                      aria-selected=${i === this.active}
                      @mousedown=${(e: Event) => {
                        e.preventDefault();
                        this.#pick(t);
                      }}
                    >
                      ${taxonName(t.id)} <span class="proto-rank">${t.rank}</span>
                      <span class="meta">${t.rank === "family" ? "" : t.family}</span>
                    </li>`,
                  )}
                </ul>`}
            <label class="proto-bycatch" @mousedown=${(e: Event) => e.preventDefault()}>
              <input type="checkbox" .checked=${this.bycatch} @change=${() => (this.bycatch = !this.bycatch)} />
              Include wasps and other bycatch
            </label>
          </div>`
        : nothing}
    </div>`;
  }
}
customElements.define("det-taxon-picker", TaxonPicker);

/** Sex, or caste for bumble and honey bees, as buttons: there is no free-text sex. */
export function sexButtons(animalId: number | null, current: Pick<Assertion, "sex" | "caste"> | null, onPick: (sex: string | null, caste: string | null) => void) {
  return html`<div class="proto-sex" role="group" aria-label="Sex">
    ${sexChoices(animalId).map(
      (c) => html`<button
        type="button"
        class=${current?.sex === c.sex && (current?.caste ?? null) === c.caste ? "" : "outlined"}
        aria-pressed=${current?.sex === c.sex && (current?.caste ?? null) === c.caste}
        @click=${() => onPick(c.sex, c.caste)}
      >
        ${c.label}
      </button>`,
    )}
    <button
      type="button"
      class=${current?.sex == null ? "" : "outlined"}
      aria-pressed=${current?.sex == null}
      @click=${() => onPick(null, null)}
    >
      Not sure
    </button>
  </div>`;
}

/**
 * The state the prototype is about: drafts held in the session and the rows
 * it would append to `determination`. Rule 5 of a prototype — show it.
 */
export class Ledger extends Light {
  static properties = { variant: {} };
  declare variant: string;
  #onChange = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    store().addEventListener("change", this.#onChange);
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    store().removeEventListener("change", this.#onChange);
  }

  override render() {
    const s = store();
    const drafts = [...s.drafts.values()].sort((a, b) => b.at - a.at);
    const events = [...s.events].reverse();
    const num = (id: number) => s.specimens.get(id)?.fieldNumber ?? `#${id}`;
    return html`<details class="proto-ledger" open>
      <summary>
        What this would record — ${events.length} determination${events.length === 1 ? "" : "s"} ·
        ${drafts.length} draft${drafts.length === 1 ? "" : "s"} not yet recorded
      </summary>
      <div class="proto-ledger-body">
        <section>
          <h3>Rows appended to <code>determination</code></h3>
          ${events.length === 0
            ? html`<p class="meta">None yet.</p>`
            : html`<table>
                <thead>
                  <tr><th>seq</th><th>specimen</th><th>verbatim_identification</th><th>animal</th><th>sex</th><th>caste</th><th>channel</th><th>is_expert</th><th>recorded_at</th></tr>
                </thead>
                <tbody>
                  ${events.map(
                    (e) => html`<tr>
                      <td>${e.seq}</td>
                      <td class="nowrap">${num(e.specimenId)}</td>
                      <td>${plainName(e.animalId)}</td>
                      <td>${taxonName(e.animalId, { rank: true })}</td>
                      <td>${e.sex ?? "NULL"}</td>
                      <td>${e.caste ?? "NULL"}</td>
                      <td>in_app</td>
                      <td>false</td>
                      <td class="nowrap">${new Date(e.at).toLocaleTimeString()}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>`}
        </section>
        <section>
          <h3>Drafts — in this session only</h3>
          ${drafts.length === 0
            ? html`<p class="meta">None.</p>`
            : html`<table>
                <thead><tr><th>specimen</th><th>value</th><th>sex</th><th>since</th></tr></thead>
                <tbody>
                  ${drafts.slice(0, 50).map(
                    (d) => html`<tr>
                      <td class="nowrap">${num(d.specimenId)}</td>
                      <td>${d.animalId == null ? html`<span class="absent">no name</span>` : taxonName(d.animalId, { rank: true })}</td>
                      <td>${sexLabel(d)}</td>
                      <td class="nowrap">${new Date(d.at).toLocaleTimeString()}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
              ${drafts.length > 50 ? html`<p class="meta">…and ${drafts.length - 50} more.</p>` : nothing}`}
        </section>
      </div>
    </details>`;
  }
}
customElements.define("det-proto-ledger", Ledger);

/** The floating variant switcher: ← and → cycle, the URL keeps the choice. */
export class ProtoSwitcher extends Light {
  static properties = { variants: {}, current: {} };
  declare variants: string;
  declare current: string;

  #list = () => this.variants.split(",").map((v) => v.split(":") as [string, string]);

  #go(delta: number) {
    const list = this.#list();
    const i = list.findIndex(([k]) => k === this.current);
    const next = list[(i + delta + list.length) % list.length]![0];
    const url = new URL(location.href);
    url.searchParams.set("variant", next);
    location.assign(url);
  }

  #onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.closest("input, textarea, select, [contenteditable]") || t.isContentEditable)) return;
    if (e.key === "ArrowLeft") this.#go(-1);
    if (e.key === "ArrowRight") this.#go(1);
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.#onKey);
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this.#onKey);
  }

  override render() {
    const name = this.#list().find(([k]) => k === this.current)?.[1] ?? "";
    return html`<div class="proto-switcher" role="navigation" aria-label="Prototype variants">
      <button type="button" aria-label="Previous variant" @click=${() => this.#go(-1)}>←</button>
      <span>${this.current} · ${name}</span>
      <button type="button" aria-label="Next variant" @click=${() => this.#go(1)}>→</button>
    </div>`;
  }
}
customElements.define("proto-switcher", ProtoSwitcher);
