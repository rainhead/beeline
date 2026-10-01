/**
 * PROTOTYPE (beeline-bcq), variant C — one specimen at a time, into a tray.
 *
 * For the volunteer who determines as labels arrive, with the bee under the
 * scope: the specimen and where it came from fill the screen, the name is
 * reached by buttons down the tree (family, genus, species — commonest first,
 * stop wherever you stop being sure), and each answer goes into a tray. The
 * tray is the draft/commit boundary made visible: nothing is a determination
 * until you press Record.
 */
import { html, nothing } from "lit";
import { Light, sexButtons } from "./shared.js";
import { bySample, inatHref, placeLabel, sampleLabel, sexLabel, store, taxonName, type Assertion, type Specimen, type Taxon } from "./store.js";

const byUse = (a: Taxon, b: Taxon) => b.uses - a.uses || a.name.localeCompare(b.name);
const SPECIES_SHOWN = 18;

class TrayVariant extends Light {
  static properties = {
    currentId: { state: true },
    family: { state: true },
    genus: { state: true },
    bycatch: { state: true },
    choice: { state: true },
    sex: { state: true },
    speciesFilter: { state: true },
    allSpecies: { state: true },
    tray: { state: true },
    last: { state: true },
  };
  declare currentId: number | null;
  declare family: string | null;
  declare genus: string | null;
  declare bycatch: boolean;
  declare choice: number | null;
  declare sex: { sex: string | null; caste: string | null };
  declare speciesFilter: string;
  declare allSpecies: boolean;
  /** Specimen ids in the order they went into the tray. */
  declare tray: number[];
  declare last: Assertion | null;
  #onChange = () => this.requestUpdate();

  constructor() {
    super();
    this.currentId = null;
    this.family = null;
    this.genus = null;
    this.bycatch = false;
    this.choice = null;
    this.sex = { sex: null, caste: null };
    this.speciesFilter = "";
    this.allSpecies = false;
    this.tray = [];
    this.last = null;
  }

  override connectedCallback() {
    super.connectedCallback();
    store().addEventListener("change", this.#onChange);
    this.currentId = this.#queue()[0]?.id ?? null;
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    store().removeEventListener("change", this.#onChange);
  }

  /** What is left to do: no name before this session, and not in the tray or recorded since. */
  #queue(): Specimen[] {
    const s = store();
    return s.data.specimens.filter((x) => x.prior === null && !this.tray.includes(x.id) && !s.lastEvent(x.id));
  }

  #choose(t: Taxon) {
    this.choice = t.id;
    if (t.rank === "family") this.family = t.name;
    if (t.genus) this.genus = t.genus;
    if (t.family) this.family = t.family;
    if (!t.bee) this.bycatch = true;
  }

  #add() {
    const id = this.currentId;
    if (id === null || this.choice === null) return;
    const a = { animalId: this.choice, sex: this.sex.sex, caste: this.sex.caste };
    store().setDrafts([id], a);
    this.tray = [...this.tray.filter((x) => x !== id), id];
    this.last = a;
    this.choice = null;
    this.sex = { sex: null, caste: null };
    this.speciesFilter = "";
    this.allSpecies = false;
    // Stay in the genus: the next bee in the sample is most likely a sibling.
    this.currentId = this.#queue()[0]?.id ?? null;
  }

  #sameAsLast() {
    if (!this.last?.animalId) return;
    this.#choose(store().taxa.get(this.last.animalId)!);
    this.sex = { sex: this.last.sex, caste: this.last.caste };
  }

  #edit(id: number) {
    const d = store().drafts.get(id);
    this.currentId = id;
    if (d?.animalId) this.#choose(store().taxa.get(d.animalId)!);
    this.sex = { sex: d?.sex ?? null, caste: d?.caste ?? null };
  }

  #remove(id: number) {
    store().clearDraft(id);
    this.tray = this.tray.filter((x) => x !== id);
    if (this.currentId === null) this.currentId = id;
  }

  #recordAll() {
    store().record(this.tray);
    this.tray = [];
  }

  #drill() {
    const taxa = store().data.taxa;
    const crumbs = html`<nav class="proto-crumbs" aria-label="Where you are in the tree">
      <button type="button" class="outlined proto-small" @click=${() => { this.family = null; this.genus = null; this.choice = null; }}>${this.bycatch ? "Everything" : "All bees"}</button>
      ${this.family ? html`› <button type="button" class="outlined proto-small" @click=${() => { this.genus = null; this.choice = null; }}>${this.family}</button>` : nothing}
      ${this.genus ? html`› <button type="button" class="outlined proto-small" @click=${() => (this.choice = null)}><i>${this.genus}</i></button>` : nothing}
    </nav>`;

    if (this.family === null) {
      const families = taxa.filter((t) => t.rank === "family" && t.bee === !this.bycatch).sort(byUse);
      const orders = this.bycatch ? taxa.filter((t) => t.rank === "order").sort(byUse) : [];
      return html`${crumbs}
        <div class="proto-choices">
          ${families.map((t) => html`<button type="button" class="tonal" @click=${() => { this.family = t.name; this.choice = null; }}>${t.name}</button>`)}
          ${orders.map((t) => html`<button type="button" class="outlined" @click=${() => this.#choose(t)}>${t.name} <span class="proto-rank">order</span></button>`)}
        </div>
        <p><button type="button" class="outlined proto-small" @click=${() => { this.bycatch = !this.bycatch; }}>${this.bycatch ? "Back to bees" : "Not a bee"}</button></p>`;
    }
    if (this.genus === null) {
      const fam = taxa.find((t) => t.rank === "family" && t.name === this.family);
      const genera = taxa.filter((t) => t.rank === "genus" && t.family === this.family).sort(byUse);
      return html`${crumbs}
        <div class="proto-choices">
          ${genera.map((t) => html`<button type="button" class=${this.choice === t.id ? "" : "tonal"} @click=${() => { this.genus = t.name; this.choice = t.id; }}><i>${t.name}</i></button>`)}
        </div>
        ${fam ? html`<p><button type="button" class=${this.choice === fam.id ? "" : "outlined"} @click=${() => (this.choice = fam.id)}>Stop at ${fam.name}</button></p>` : nothing}`;
    }
    const gen = taxa.find((t) => t.rank === "genus" && t.name === this.genus);
    const f = this.speciesFilter.toLowerCase();
    const species = taxa
      .filter((t) => t.rank === "species" && t.genus === this.genus && (f === "" || t.name.toLowerCase().includes(f)))
      .sort(byUse);
    const shown = this.allSpecies || f !== "" ? species : species.slice(0, SPECIES_SHOWN);
    return html`${crumbs}
      <p>
        ${gen ? html`<button type="button" class=${this.choice === gen.id ? "" : "outlined"} @click=${() => (this.choice = gen.id)}>Stop at <i>${gen.name}</i> — the genus is plenty</button>` : nothing}
        <input class="proto-species-filter" type="search" placeholder="Filter species" .value=${this.speciesFilter}
          @input=${(e: InputEvent) => (this.speciesFilter = (e.target as HTMLInputElement).value)} />
      </p>
      <div class="proto-choices proto-species">
        ${shown.map((t) => html`<button type="button" class=${this.choice === t.id ? "" : "outlined"} @click=${() => (this.choice = t.id)}><i>${t.name.split(" ").slice(1).join(" ")}</i></button>`)}
      </div>
      ${shown.length < species.length
        ? html`<p><button type="button" class="outlined proto-small" @click=${() => (this.allSpecies = true)}>All ${species.length} species of <i>${this.genus}</i></button></p>`
        : nothing}`;
  }

  override render() {
    const s = store();
    const queue = this.#queue();
    const sp = this.currentId === null ? null : (s.specimens.get(this.currentId) ?? null);
    const siblings = sp ? s.data.specimens.filter((x) => x.sampleId === sp.sampleId) : [];
    const href = sp ? inatHref(sp) : null;
    return html`<div class="proto-tray-layout">
      <aside class="proto-queue">
        <h2>To do · ${queue.length}</h2>
        <ol>
          ${bySample(queue.slice(0, 120)).map(
            (g) => html`<li class="proto-queue-sample">
              <span class="meta">${sampleLabel(g[0]!)}</span>
              ${g.map((x) => html`<button type="button" class=${x.id === this.currentId ? "proto-small" : "outlined proto-small"} @click=${() => (this.currentId = x.id)}>${x.fieldNumber}</button>`)}
            </li>`,
          )}
        </ol>
        ${queue.length > 120 ? html`<p class="meta">…and ${queue.length - 120} more.</p>` : nothing}
      </aside>

      <section class="proto-card card">
        ${sp === null
          ? html`<p>Nothing left without a name in ${s.data.season}.</p>`
          : html`
              <header class="proto-card-head">
                <p class="proto-big-number">${sp.fieldNumber}</p>
                <p>
                  <strong>${sampleLabel(sp)}</strong> · ${placeLabel(sp)}${sp.county && sp.locality ? html`, ${sp.county}` : nothing}
                  · ${sp.kind}${sp.host ? html` · on <i>${sp.host}</i>` : nothing}
                  ${href ? html` · <a href=${href} target="_blank" rel="noopener">iNat ↗</a>` : nothing}
                </p>
                <p class="meta">Specimen ${sp.specimenNumber} of ${siblings.length} in this sample</p>
              </header>
              ${this.last?.animalId
                ? html`<p><button type="button" class="tonal" @click=${() => this.#sameAsLast()}>Same as the last one: ${taxonName(this.last.animalId)}${this.last.sex ? `, ${sexLabel(this.last)}` : ""}</button></p>`
                : nothing}
              <h3>What is it?</h3>
              ${this.#drill()}
              <details class="proto-or-type">
                <summary>Or type the name</summary>
                <det-taxon-picker @pick=${(e: CustomEvent<number>) => this.#choose(s.taxa.get(e.detail)!)}></det-taxon-picker>
              </details>
              ${this.choice !== null
                ? html`<h3>Sex</h3>
                    ${sexButtons(this.choice, this.sex, (sex, caste) => (this.sex = { sex, caste }))}
                    <p class="proto-answer">${taxonName(this.choice, { rank: true })} ${this.sex.sex ? html`· ${sexLabel(this.sex)}` : nothing}</p>
                    <button type="button" class="tonal" @click=${() => this.#add()}>Put in the tray and go to the next one</button>`
                : nothing}
            `}
      </section>

      <aside class="proto-tray">
        <h2>Tray · ${this.tray.length}</h2>
        ${this.tray.length === 0
          ? html`<p class="meta">Answers wait here until you record them. Change or drop any of them first.</p>`
          : html`<ol>
              ${[...this.tray].reverse().map((id) => {
                const d = s.drafts.get(id);
                return html`<li>
                  <span class="proto-number">${s.specimens.get(id)?.fieldNumber}</span>
                  <span>${taxonName(d?.animalId ?? null)} ${sexLabel(d ?? null)}</span>
                  <span class="proto-tray-actions">
                    <button type="button" class="outlined proto-small" @click=${() => this.#edit(id)}>Change</button>
                    <button type="button" class="outlined proto-small" @click=${() => this.#remove(id)}>Drop</button>
                  </span>
                </li>`;
              })}
            </ol>`}
        <button type="button" ?disabled=${this.tray.length === 0} @click=${() => this.#recordAll()}>
          Record ${this.tray.length} determination${this.tray.length === 1 ? "" : "s"}
        </button>
        <p class="meta">Nothing is recorded until you press this. Once recorded, a change is a newer determination beside the old one.</p>
      </aside>
    </div>`;
  }
}
customElements.define("det-proto-tray", TrayVariant);
