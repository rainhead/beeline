/**
 * PROTOTYPE (beeline-bcq), variant B — taxon first, then numbers.
 *
 * Most volunteers determine in winter from boxes they have already sorted by
 * taxon, so the box, not the specimen, is the unit of work: say once what the
 * box holds, then scan each label's DataMatrix (a handheld scanner types the
 * digits and Enter) or type the number. Every number is an assertion the
 * moment it is entered, and can be undone until you leave the page.
 */
import { html, nothing } from "lit";
import { Light, sexButtons } from "./shared.js";
import { bySample, placeLabel, plainName, sampleLabel, sexLabel, store, taxonName, type Specimen } from "./store.js";

interface LogEntry {
  kind: "ok" | "changed" | "error" | "same";
  text: string;
  specimen?: Specimen;
  seq?: number;
  was?: string;
  at: number;
}

class BoxVariant extends Light {
  static properties = {
    boxAnimal: { state: true },
    boxSex: { state: true },
    log: { state: true },
    confirm: { state: true },
  };
  declare boxAnimal: number | null;
  declare boxSex: { sex: string | null; caste: string | null };
  declare log: LogEntry[];
  /** A number that already has a different name, waiting for a second Enter. */
  declare confirm: Specimen | null;
  #onChange = () => this.requestUpdate();

  constructor() {
    super();
    this.boxAnimal = null;
    this.boxSex = { sex: null, caste: null };
    this.log = [];
    this.confirm = null;
  }

  override connectedCallback() {
    super.connectedCallback();
    store().addEventListener("change", this.#onChange);
  }
  override disconnectedCallback() {
    super.disconnectedCallback();
    store().removeEventListener("change", this.#onChange);
  }

  #input(): HTMLInputElement | null {
    return this.querySelector(".proto-scan input");
  }

  #push(e: Omit<LogEntry, "at">) {
    this.log = [{ ...e, at: Date.now() }, ...this.log];
  }

  #assign(sp: Specimen, was: string | undefined) {
    const s = store();
    s.setDrafts([sp.id], { animalId: this.boxAnimal!, sex: this.boxSex.sex, caste: this.boxSex.caste });
    const [made] = s.record([sp.id]);
    this.#push({ kind: was ? "changed" : "ok", text: sp.fieldNumber ?? "", specimen: sp, seq: made?.seq, was });
  }

  #enter(raw: string) {
    const s = store();
    const typed = raw.trim();
    if (typed === "") return;
    if (this.boxAnimal === null) {
      this.#push({ kind: "error", text: `${typed}: say what is in the box first.` });
      return;
    }
    if (this.confirm && (typed === this.confirm.fieldNumber || this.confirm.fieldNumber?.endsWith(typed))) {
      const sp = this.confirm;
      this.confirm = null;
      this.#assign(sp, plainName(s.current(sp.id)?.animalId ?? null));
      return;
    }
    this.confirm = null;
    const hits = s.data.specimens.filter((x) => x.fieldNumber === typed || (typed.length >= 3 && x.fieldNumber?.endsWith(typed)));
    if (hits.length === 0) {
      this.#push({ kind: "error", text: `${typed} is not one of your ${s.data.season} specimens. Nothing recorded.` });
      return;
    }
    if (hits.length > 1) {
      this.#push({ kind: "error", text: `${hits.length} of your numbers end in ${typed} (${hits.slice(0, 4).map((h) => h.fieldNumber).join(", ")}${hits.length > 4 ? "…" : ""}). Type more of it.` });
      return;
    }
    const sp = hits[0]!;
    const cur = s.current(sp.id);
    if (cur?.animalId === this.boxAnimal && cur.sex === this.boxSex.sex && cur.caste === this.boxSex.caste) {
      this.#push({ kind: "same", text: `${sp.fieldNumber} is already ${plainName(cur.animalId)}${cur.sex ? `, ${sexLabel(cur)}` : ""}. Nothing to do.`, specimen: sp });
      return;
    }
    if (cur?.animalId != null && cur.animalId !== this.boxAnimal) {
      this.confirm = sp;
      return;
    }
    this.#assign(sp, undefined);
  }

  #undo(entry: LogEntry) {
    if (entry.seq !== undefined) store().unrecord(entry.seq);
    this.log = this.log.filter((e) => e !== entry);
    this.#input()?.focus();
  }

  override render() {
    const s = store();
    const box = this.boxAnimal;
    const tally = box === null ? 0 : s.events.filter((e) => e.animalId === box).length;
    const outstanding = s.data.specimens.filter((x) => s.isOutstanding(x.id));
    return html`<div class="proto-box">
      <aside class="proto-box-side">
        <h2>1 · What is in this box?</h2>
        ${box === null
          ? html`<det-taxon-picker autofocus placeholder="The box's name — bombus, osmia lig…"
              @pick=${(e: CustomEvent<number>) => { this.boxAnimal = e.detail; this.boxSex = { sex: null, caste: null }; this.updateComplete.then(() => this.#input()?.focus()); }}></det-taxon-picker>
            <p class="meta">Go only as far as you are sure. A genus is plenty.</p>`
          : html`<p class="proto-box-name">${taxonName(box, { rank: true })}</p>
            <button type="button" class="outlined" @click=${() => { this.boxAnimal = null; this.confirm = null; }}>Next box</button>`}
        <h2>2 · Sex</h2>
        ${sexButtons(box, this.boxSex, (sex, caste) => { this.boxSex = { sex, caste }; this.#input()?.focus(); })}
        <p class="meta">Applies to every number until you change it — mixed boxes are fine, switch as you go.</p>
        ${box !== null ? html`<p class="proto-tally"><strong>${tally}</strong> named ${taxonName(box)} so far</p>` : nothing}
      </aside>

      <section class="proto-box-main">
        <h2>3 · Scan or type each number</h2>
        <label class="proto-scan">
          <span class="visually-hidden">Specimen number</span>
          <input type="text" inputmode="numeric" autocomplete="off" placeholder=${box === null ? "name the box first" : "26000412, or just 412"}
            ?disabled=${box === null}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Escape") { this.confirm = null; return; }
              if (e.key !== "Enter") return;
              const input = e.target as HTMLInputElement;
              this.#enter(input.value);
              input.value = this.confirm ? (this.confirm.fieldNumber ?? "") : "";
              if (this.confirm) input.select();
            }} />
        </label>
        ${this.confirm
          ? html`<p class="callout warning">
              <strong>${this.confirm.fieldNumber}</strong> is already ${taxonName(s.current(this.confirm.id)?.animalId ?? null)}.
              Press Enter again to make it ${taxonName(box)}, or Escape to leave it.
            </p>`
          : nothing}

        <ol class="proto-log">
          ${this.log.map(
            (e) => html`<li class=${`proto-log-${e.kind}`}>
              ${e.specimen && (e.kind === "ok" || e.kind === "changed")
                ? html`<span class="proto-number">${e.specimen.fieldNumber}</span>
                    <span>${taxonName(s.lastEvent(e.specimen.id)?.animalId ?? null)} ${sexLabel(s.lastEvent(e.specimen.id) ?? null)}</span>
                    ${e.was ? html`<span class="chip warning">was ${e.was}</span>` : nothing}
                    <span class="meta">${sampleLabel(e.specimen)} · ${placeLabel(e.specimen)}</span>
                    ${e.seq !== undefined ? html`<button type="button" class="outlined proto-small" @click=${() => this.#undo(e)}>Undo</button>` : nothing}`
                : html`<span>${e.text}</span>`}
            </li>`,
          )}
        </ol>

        <details class="proto-remaining">
          <summary>${outstanding.length} of your ${s.data.season} specimens have no name yet — tap one instead of typing it</summary>
          ${bySample(outstanding).map(
            (g) => html`<div class="proto-remaining-sample">
              <span class="meta">${sampleLabel(g[0]!)} · ${placeLabel(g[0]!)}</span>
              ${g.map((sp) => html`<button type="button" class="outlined proto-small" ?disabled=${box === null} @click=${() => this.#enter(sp.fieldNumber ?? "")}>${sp.fieldNumber}</button>`)}
            </div>`,
          )}
        </details>
        <p class="meta">Each number is recorded as you enter it. Undo takes it back until you leave this page; after that a change is a newer determination.</p>
      </section>
    </div>`;
  }
}
customElements.define("det-proto-box", BoxVariant);
