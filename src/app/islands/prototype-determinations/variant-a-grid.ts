/**
 * PROTOTYPE (beeline-bcq), variant A — the grid from the August wireframes.
 *
 * Every specimen is already a row, so a number is never typed to *enter* a
 * determination — only to find rows. A box sorted by genus or morphospecies
 * is found by its numbers: type a list or a range, or scan the labels one
 * after another, and the table shows only those. Tick rows and name them all
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
    filter: { state: true },
    numbers: { state: true },
    selected: { state: true },
    editing: { state: true },
    limit: { state: true },
    lastBulk: { state: true },
  };
  declare filter: "outstanding" | "all";
  declare numbers: NumberEntry[];
  declare selected: Set<number>;
  declare editing: number | null;
  declare limit: number;
  declare lastBulk: BulkChange | null;
  #anchor: number | null = null;
  #onChange = () => this.requestUpdate();

  constructor() {
    super();
    this.filter = "outstanding";
    this.numbers = [];
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
   * Numbers, when any are given, decide the rows on their own. Otherwise
   * outstanding means "had no determination when you sat down", not "has
   * none now" — a row you just filled must not vanish under you, or the
   * coarse-then-fine pass has nothing left to refine.
   */
  #rows(): Specimen[] {
    const all = store().data.specimens;
    const wanted = new Set(this.numbers.flatMap((n) => n.ids));
    if (wanted.size > 0) return all.filter((s) => wanted.has(s.id));
    return this.filter === "all" ? all : all.filter((s) => s.prior === null);
  }

  /** Ticked rows that are on screen — a bulk change never reaches a row you cannot see. */
  #pruneSelection() {
    const shown = new Set(this.#rows().map((r) => r.id));
    this.selected = new Set([...this.selected].filter((id) => shown.has(id)));
  }

  #addNumbers(raw: string) {
    const s = store();
    const added = tokens(raw).map((t) => resolve(t, s.data.specimens, s.data.season));
    if (added.length === 0) return;
    const seen = new Set(this.numbers.map((n) => n.text));
    this.numbers = [...this.numbers, ...added.filter((n) => !seen.has(n.text))];
    this.limit = Math.max(this.limit, CHUNK);
    this.#pruneSelection();
  }

  #removeNumber(entry: NumberEntry) {
    this.numbers = this.numbers.filter((n) => n !== entry);
    this.#pruneSelection();
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
      <button type="button" class="outlined proto-small" ?disabled=${n === 0} @click=${() => (this.selected = new Set())}>Untick all</button>
    </div>`;
  }

  override render() {
    const s = store();
    const rows = this.#rows();
    const shown = rows.slice(0, this.limit);
    const groups = bySample(shown);
    const byNumber = this.numbers.some((e) => e.ids.length > 0);
    let index = 0;
    const drafts = s.drafts.size;
    const allTicked = rows.length > 0 && rows.every((r) => this.selected.has(r.id));
    return html`
      <div class="proto-toolbar">
        <div class="segmented" role="group" aria-label="Rows" ?data-overridden=${byNumber}>
          <a href="#" aria-current=${!byNumber && this.filter === "outstanding" ? "true" : nothing}
            @click=${(e: Event) => { e.preventDefault(); this.numbers = []; this.filter = "outstanding"; this.#pruneSelection(); }}>
            Not yet determined (${s.data.specimens.filter((x) => x.prior === null).length})
          </a>
          <a href="#" aria-current=${!byNumber && this.filter === "all" ? "true" : nothing}
            @click=${(e: Event) => { e.preventDefault(); this.numbers = []; this.filter = "all"; this.#pruneSelection(); }}>
            All (${s.data.specimens.length})
          </a>
        </div>
        <span class="proto-spacer"></span>
        <span class="meta">${drafts} draft${drafts === 1 ? "" : "s"}</span>
        <button type="button" class="tonal" ?disabled=${drafts === 0} @click=${() => s.record([...s.drafts.keys()])}
          title="Stands in for an export, a review or a print run consuming the rows">
          Simulate a freeze
        </button>
      </div>

      <div class="proto-numbers">
        <label for="proto-numbers-input">Only these numbers</label>
        <div class="proto-numbers-box">
          ${this.numbers.map(
            (e) => html`<span class=${e.problem ? "chip warning" : "chip"}>
              ${e.text}${e.problem ? html` — ${e.problem}` : e.ids.length > 1 ? html` · ${e.ids.length}` : nothing}
              <button type="button" class="proto-chip-x" aria-label=${`Remove ${e.text}`} @click=${() => this.#removeNumber(e)}>×</button>
            </span>`,
          )}
          <input id="proto-numbers-input" type="text" inputmode="numeric" autocomplete="off"
            placeholder=${this.numbers.length === 0 ? "26019685-690, 26027608 — or scan the labels in a box" : "more…"}
            @keydown=${(e: KeyboardEvent) => {
              const input = e.target as HTMLInputElement;
              if (e.key === "Enter") {
                this.#addNumbers(input.value);
                input.value = "";
              } else if (e.key === "Backspace" && input.value === "" && this.numbers.length > 0) {
                this.#removeNumber(this.numbers[this.numbers.length - 1]!);
              }
            }}
            @paste=${(e: ClipboardEvent) => {
              e.preventDefault();
              this.#addNumbers(e.clipboardData?.getData("text") ?? "");
            }} />
        </div>
        ${this.numbers.length > 0
          ? html`<span class="meta">${rows.length} shown</span>
              <button type="button" class="outlined proto-small" @click=${() => { this.numbers = []; this.#pruneSelection(); }}>Show all again</button>`
          : nothing}
      </div>

      ${this.#bulkBar()}

      <div class="table-scroll">
        <table class="proto-grid">
          <colgroup>
            <col class="proto-col-check" /><col class="proto-col-number" /><col /><col class="proto-col-sex" /><col class="proto-col-entered" />
          </colgroup>
          <thead>
            <tr>
              <th class="proto-check"><input type="checkbox" .checked=${allTicked} aria-label=${`Tick all ${rows.length} shown`} title=${`Tick all ${rows.length} shown`} @click=${() => this.#toggleAll(rows)} /></th>
              <th>Number</th><th>Determination</th><th>Sex</th><th>Entered</th>
            </tr>
          </thead>
          ${groups.map((group) => {
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
              ${group.map((sp) => {
                const i = index++;
                const cur = s.current(sp.id);
                return html`<tr data-row=${sp.id} class=${this.selected.has(sp.id) ? "proto-selected" : ""}>
                  <td class="proto-check">
                    <input type="checkbox" .checked=${this.selected.has(sp.id)} aria-label=${`Tick ${sp.fieldNumber}`}
                      @click=${(e: MouseEvent) => this.#toggle(rows, i, e.shiftKey)} />
                  </td>
                  <td class="proto-number">${sp.fieldNumber}</td>
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
                </tr>`;
              })}
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
