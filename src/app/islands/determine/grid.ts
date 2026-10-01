/**
 * Identify your specimens (beeline-bcq): the grid.
 *
 * Every specimen is already a row, so a number is never typed to enter a
 * name — only to find rows. Two views over the same grid: by sample, the
 * season in collecting order; and the batch, specimens gathered by their
 * field numbers (a box sorted by genus) in the order they were added. Tick
 * rows and name them all at once — coarse first, the box is all Bombus, then
 * a few refined to species — or name one row at a time. Each change saves at
 * once as a draft; the overnight job makes the drafts determinations.
 *
 * Chosen over two other designs in a prototype on 2026-10-01 (branch
 * prototype/volunteer-determinations).
 */
import { html, LitElement, nothing, type TemplateResult } from "lit";
import type { EntryRow, EntryValue } from "../../determine.js";
import type { DeterminePageData } from "../../views/determine.js";
import { messagesFor } from "../../messages/index.js";
import { NumberIndex, pastedList, type NumberProblem } from "../../../determination-numbers.js";
import { problemText } from "./problems.js";
import { loadTaxa, nameTemplate, type PickerTaxon } from "./picker.js";
import "./picker.js";

const m = messagesFor(null);
const d = m.determine;

const CHUNK = 400;

type Write = EntryValue & { specimenId: number };
type TaxonInfo = { name: string; rank: string; castes: boolean };

/** A DATE as the calendar day it names, in the browser's zone: `new Date("2026-07-14")` is UTC midnight, the 13th here. */
const localDate = (iso: string) => {
  const [y, mo, day] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  return new Date(y, mo - 1, day);
};

const absent = (label: string) =>
  html`<span class="meta absent"><span aria-hidden="true">—</span><span class="visually-hidden">${label}</span></span>`;

class DetermineGrid extends LitElement {
  static properties = {
    rows: { state: true },
    filter: { state: true },
    selected: { state: true },
    editing: { state: true },
    limit: { state: true },
    lastBulk: { state: true },
    saving: { state: true },
    failed: { state: true },
    message: { state: true },
    problems: { state: true },
    flash: { state: true },
  };
  declare rows: EntryRow[];
  declare filter: "unnamed" | "all";
  declare selected: Set<number>;
  declare editing: number | null;
  declare limit: number;
  declare lastBulk: { before: Write[]; text: string } | null;
  declare saving: Set<number>;
  declare failed: Map<number, Write>;
  /** The last thing the number boxes or a bulk change did, in words. */
  declare message: string;
  declare problems: { text: string; why: string }[];
  declare flash: number | null;

  data: DeterminePageData;
  taxa = new Map<number, TaxonInfo>();
  /** Rows with no name when the page loaded: a row named now must not vanish from "not yet named". */
  #unnamedAtLoad: Set<number>;
  #anchor: number | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  /**
   * The newest write sent for each row and not yet answered. A row reads
   * through it, so a second change made before the first is saved builds on
   * the first — choosing a sex while the name is still saving must not send
   * the row without its name — and only the answer to the newest write is
   * allowed to land.
   */
  #pending = new Map<number, Write>();

  constructor() {
    super();
    this.data = JSON.parse(document.getElementById("determine-data")?.textContent ?? "{}") as DeterminePageData;
    this.rows = this.data.rows ?? [];
    for (const [id, t] of Object.entries(this.data.taxa ?? {})) this.taxa.set(Number(id), t);
    this.#unnamedAtLoad = new Set(this.rows.filter((r) => r.prior === null && r.draft?.animalId == null).map((r) => r.id));
    this.filter = this.data.view === "sample" && this.#unnamedAtLoad.size > 0 ? "unnamed" : "all";
    this.selected = new Set();
    this.editing = null;
    this.limit = CHUNK;
    this.lastBulk = null;
    this.saving = new Set();
    this.failed = new Map();
    this.message = "";
    this.problems = [];
    this.flash = null;
  }

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    loadTaxa()
      .then((list: PickerTaxon[]) => {
        for (const t of list) this.taxa.set(t.id, { name: t.name, rank: t.rank, castes: t.castes });
        this.requestUpdate();
      })
      .catch(() => undefined);
  }

  get #batch() {
    return this.data.view === "batch";
  }

  #shown(): EntryRow[] {
    return this.filter === "unnamed" ? this.rows.filter((r) => this.#unnamedAtLoad.has(r.id)) : this.rows;
  }

  #current(r: EntryRow): EntryValue {
    const v = this.#pending.get(r.id) ?? this.failed.get(r.id) ?? r.draft ?? r.prior;
    return v ? { animalId: v.animalId, sex: v.sex, caste: v.caste } : { animalId: null, sex: null, caste: null };
  }

  #castes(animalId: number | null) {
    return animalId !== null && this.taxa.get(animalId)?.castes === true;
  }

  /** The value a row should take when part of it changes. */
  #next(r: EntryRow, patch: Partial<EntryValue>): Write {
    const v = { ...this.#current(r), ...patch };
    const social = this.#castes(v.animalId);
    if (!social) v.caste = null;
    else if (v.sex === "male") v.caste = "drone";
    return { specimenId: r.id, ...v };
  }

  /** Send writes in order, one request at a time, and take the server's word for the result. */
  #send(writes: Write[]) {
    if (writes.length === 0 || this.data.readOnly) return Promise.resolve();
    for (const w of writes) this.#pending.set(w.specimenId, w);
    const ids = writes.map((w) => w.specimenId);
    this.saving = new Set([...this.saving, ...ids]);
    /** The rows this write is still the newest for; taking them out of pending as it lands. */
    const settle = () => {
      const latest = writes.filter((w) => this.#pending.get(w.specimenId) === w);
      for (const w of latest) this.#pending.delete(w.specimenId);
      return latest;
    };
    const run = async () => {
      try {
        const res = await fetch("/determinations/drafts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ writes }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const { rows } = (await res.json()) as { rows: EntryRow[] };
        const by = new Map(rows.map((r) => [r.id, r]));
        const landed = new Set(settle().map((w) => w.specimenId));
        this.rows = this.rows.map((r) => (landed.has(r.id) ? (by.get(r.id) ?? r) : r));
        const failed = new Map(this.failed);
        for (const id of landed) failed.delete(id);
        this.failed = failed;
      } catch {
        const failed = new Map(this.failed);
        for (const w of settle()) failed.set(w.specimenId, w);
        this.failed = failed;
        this.message = d.saveFailed;
      } finally {
        // Still saving while a newer write for the row is on its way.
        const saving = new Set(this.saving);
        for (const id of ids) if (!this.#pending.has(id)) saving.delete(id);
        this.saving = saving;
      }
    };
    this.#queue = this.#queue.then(run);
    return this.#queue;
  }

  #write(rows: EntryRow[], patch: Partial<EntryValue>) {
    return this.#send(rows.map((r) => this.#next(r, patch)));
  }

  #bulk(patch: Partial<EntryValue>, text: string) {
    const rows = this.rows.filter((r) => this.selected.has(r.id));
    this.lastBulk = { before: rows.map((r) => ({ specimenId: r.id, ...this.#current(r) })), text };
    this.message = "";
    void this.#write(rows, patch);
  }

  #undoBulk() {
    if (!this.lastBulk) return;
    void this.#send(this.lastBulk.before);
    this.lastBulk = null;
  }

  /** Back to what the row said before today: its earlier determination, or nothing. */
  #undoRow(r: EntryRow) {
    const p = r.prior;
    void this.#send([{ specimenId: r.id, animalId: p?.animalId ?? null, sex: p?.sex ?? null, caste: p?.caste ?? null }]);
  }

  #toggle(list: EntryRow[], index: number, shift: boolean) {
    const id = list[index]!.id;
    const next = new Set(this.selected);
    if (shift && this.#anchor !== null) {
      const from = list.findIndex((r) => r.id === this.#anchor);
      const [a, b] = from < index ? [from, index] : [index, from];
      const on = !this.selected.has(id);
      for (let i = a; i <= b; i++) (on ? next.add(list[i]!.id) : next.delete(list[i]!.id));
    } else {
      next.has(id) ? next.delete(id) : next.add(id);
      this.#anchor = id;
    }
    this.selected = next;
  }

  #toggleAll(group: EntryRow[]) {
    const next = new Set(this.selected);
    const all = group.every((r) => next.has(r.id));
    for (const r of group) (all ? next.delete(r.id) : next.add(r.id));
    this.selected = next;
  }

  #setFilter(filter: "unnamed" | "all") {
    this.filter = filter;
    const shown = new Set(this.#shown().map((r) => r.id));
    this.selected = new Set([...this.selected].filter((id) => shown.has(id)));
  }

  async #batchRequest(body: object) {
    const res = await fetch("/determinations/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(String(res.status));
    const out = (await res.json()) as {
      addition: null | { entries: { text: string; found: number; problem: NumberProblem | null }[]; added: number; already: number; named: number[] };
      rows: EntryRow[];
      taxa: Record<number, TaxonInfo>;
    };
    for (const [id, t] of Object.entries(out.taxa)) this.taxa.set(Number(id), t);
    // The view links carry the count; keep it true without a reload.
    const link = document.querySelector<HTMLAnchorElement>('a[href="/determinations?view=batch"]');
    if (link) link.textContent = d.mode.batch(out.rows.length);
    return out;
  }

  async #addNumbers(input: HTMLInputElement) {
    const typed = input.value.trim();
    if (typed === "" || this.data.readOnly) return;
    try {
      const out = await this.#batchRequest({ add: typed });
      input.value = "";
      this.rows = out.rows;
      const a = out.addition!;
      this.problems = [
        ...this.problems,
        ...a.entries.filter((e) => e.problem !== null).map((e) => ({ text: e.text, why: problemText(e.problem!) })),
      ];
      const one = a.named.length === 1 ? this.rows.find((r) => r.id === a.named[0]) : undefined;
      this.message =
        a.added === 0 && a.already === 1 && one?.fieldNumber
          ? d.batch.alreadyOne(one.fieldNumber)
          : a.added === 0 && a.already > 1
            ? d.batch.alreadyAll(a.already)
            : a.already > 0
            ? d.batch.addedSome(a.added, a.already)
            : a.added > 0
              ? d.batch.added(a.added)
              : "";
      const last = a.named[a.named.length - 1];
      if (last !== undefined) {
        this.flash = last;
        if (this.rows.length > this.limit) this.limit = this.rows.length;
        await this.updateComplete;
        this.querySelector(`[data-row="${last}"]`)?.scrollIntoView({ block: "nearest" });
      }
    } catch {
      this.message = d.saveFailed;
    }
  }

  async #addTickedToBatch() {
    try {
      const out = await this.#batchRequest({ addIds: this.rows.filter((r) => this.selected.has(r.id)).map((r) => r.id) });
      this.message = d.batch.added(this.selected.size);
      void out;
    } catch {
      this.message = d.saveFailed;
    }
  }

  async #removeFromBatch(ids: number[] | "all") {
    try {
      const out = await this.#batchRequest({ remove: ids });
      this.rows = out.rows;
      this.selected = new Set([...this.selected].filter((id) => out.rows.some((r) => r.id === id)));
      if (ids === "all") this.problems = [];
    } catch {
      this.message = d.saveFailed;
    }
  }

  #jump(input: HTMLInputElement) {
    const typed = input.value.trim();
    if (typed === "") return;
    const entry = new NumberIndex(this.rows).resolve(typed);
    if (entry.problem !== null || entry.ids.length !== 1) {
      this.message =
        entry.problem?.code === "ambiguous" ? problemText(entry.problem) : d.jump.notHere(typed, this.data.season ?? 0);
      return;
    }
    const id = entry.ids[0]!;
    if (!this.#shown().some((r) => r.id === id)) this.filter = "all";
    const index = this.#shown().findIndex((r) => r.id === id);
    if (index >= this.limit) this.limit = index + CHUNK;
    this.message = "";
    this.flash = id;
    this.selected = new Set([...this.selected, id]);
    input.value = "";
    void this.updateComplete.then(() => this.querySelector(`[data-row="${id}"]`)?.scrollIntoView({ block: "center" }));
  }

  #sexControl(animalId: number | null, current: EntryValue | null, onPick: (sex: EntryValue["sex"], caste: EntryValue["caste"]) => void, label: string, disabled = false) {
    const s = d.sex;
    const choices: { label: string; sex: "female" | "male"; caste: EntryValue["caste"] }[] = this.#castes(animalId)
      ? [
          { label: s.queen, sex: "female", caste: "gyne" },
          { label: s.worker, sex: "female", caste: "worker" },
          { label: s.male, sex: "male", caste: "drone" },
        ]
      : [
          { label: s.female, sex: "female", caste: null },
          { label: s.male, sex: "male", caste: null },
        ];
    return html`<div class=${`determine-sex determine-sex-${choices.length}`} role="group" aria-label=${label}
      title=${choices.length === 3 ? s.castesHint : nothing}>
      ${choices.map((c) => {
        const on = current?.sex === c.sex && (current?.caste ?? null) === c.caste;
        return html`<button type="button" aria-pressed=${on} ?disabled=${disabled || this.data.readOnly}
          @click=${() => (on ? onPick(null, null) : onPick(c.sex, c.caste))}>${c.label}</button>`;
      })}
    </div>`;
  }

  #saved(r: EntryRow): TemplateResult {
    const s = d.saved;
    if (this.saving.has(r.id)) return html`<span class="meta">${s.saving}</span>`;
    const failed = this.failed.get(r.id);
    if (failed)
      return html`<span class="chip blocking">${s.failed}</span>
        <button type="button" class="outlined small" @click=${() => void this.#send([failed])}>${s.retry}</button>`;
    if (r.draft)
      return html`<span class="chip" title=${s.todayHint}>${s.today}</span>
        ${this.data.readOnly ? nothing : html`<button type="button" class="outlined small" title=${s.undoHint} @click=${() => this.#undoRow(r)}>${s.undo}</button>`}`;
    if (r.prior) {
      if (r.prior.channel === "legacy_import") return html`<span class="meta">${s.beforeBeeline}</span>`;
      if (r.prior.determinedOn) return html`<span class="meta">${m.format.date(localDate(r.prior.determinedOn))}</span>`;
    }
    return absent(s.nothing);
  }

  #row(r: EntryRow, list: EntryRow[], index: number, position: number | null) {
    const t = d.table;
    const cur = this.#current(r);
    const ro = this.data.readOnly;
    const classes = [this.selected.has(r.id) ? "selected" : "", this.flash === r.id ? "flash" : ""].join(" ");
    return html`<tr data-row=${r.id} class=${classes}>
      <td class="tick">
        <input type="checkbox" .checked=${this.selected.has(r.id)} ?disabled=${ro} aria-label=${t.tick(r.fieldNumber ?? t.noNumber)}
          @click=${(e: MouseEvent) => this.#toggle(list, index, e.shiftKey)} />
      </td>
      ${position !== null ? html`<td class="position meta">${m.format.number(position)}</td>` : nothing}
      <td class="field-number">${r.fieldNumber ?? html`<span class="meta absent">${t.noNumber}</span>`}</td>
      ${position !== null ? html`<td class="sample" title=${this.#sampleText(r)}>${this.#sampleText(r)}</td>` : nothing}
      <td class="name">
        ${this.editing === r.id
          ? html`<determine-taxon-picker autofocus
              @pick=${(e: CustomEvent<PickerTaxon>) => {
                this.taxa.set(e.detail.id, e.detail);
                this.editing = null;
                void this.#write([r], { animalId: e.detail.id });
              }}
              @cancel=${() => (this.editing = null)}></determine-taxon-picker>`
          : html`<button type="button" class="name-cell" ?disabled=${ro} @click=${() => (this.editing = r.id)}>
              ${cur.animalId !== null ? this.#name(cur.animalId) : html`<span class="meta">${t.addName}</span>`}
            </button>`}
      </td>
      <td>${this.#sexControl(cur.animalId, cur, (sex, caste) => void this.#send([this.#next(r, { sex, caste })]), d.sex.label)}</td>
      <td class="saved">${this.#saved(r)}</td>
      ${position !== null
        ? html`<td class="tick"><button type="button" class="remove" ?disabled=${ro} aria-label=${d.batch.remove(r.fieldNumber ?? t.noNumber)}
            title=${d.batch.remove(r.fieldNumber ?? t.noNumber)} @click=${() => void this.#removeFromBatch([r.id])}>×</button></td>`
        : nothing}
    </tr>`;
  }

  #name(animalId: number) {
    const t = this.taxa.get(animalId);
    return t ? html`${nameTemplate(t)} <span class="determine-rank">${t.rank}</span>` : nothing;
  }

  #when(r: EntryRow) {
    return m.format.dateRange(localDate(r.sample.dateStart), localDate(r.sample.dateEnd));
  }

  #sampleText(r: EntryRow) {
    return `${d.table.sampleHeading(r.sample.number, this.#when(r))} · ${m.format.place([r.sample.locality, r.sample.county])}`;
  }

  #sampleHeading(r: EntryRow) {
    const t = d.table;
    const s = r.sample;
    return html`<a href=${`/samples/${s.id}`}>${t.sampleHeading(s.number, this.#when(r))}</a>
      · ${m.format.place([s.locality, s.county])}
      ${s.host ? html` · ${t.onHost} <i>${s.host}</i>` : nothing}
      ${s.observation
        ? html` <a class="inat-link" href=${`https://www.inaturalist.org/observations/${s.observation}`} title=${t.viewOnInat}>
            <img src="/static/inat-logo.png" alt=${t.viewOnInat} width="66" height="12" /></a>`
        : nothing}`;
  }

  #bulkBar() {
    const b = d.bulk;
    const ticked = this.rows.filter((r) => this.selected.has(r.id));
    const n = ticked.length;
    const currents = ticked.map((r) => this.#current(r));
    const social = n > 0 && currents.every((c) => this.#castes(c.animalId));
    const first = currents[0] ?? null;
    const same = n > 0 && currents.every((c) => c.sex === first?.sex && c.caste === first?.caste) ? first : null;
    const off = n === 0 || this.data.readOnly;
    return html`<div class="determine-bulk" ?data-empty=${n === 0}>
      <span class="count">${n === 0 ? b.none : html`<strong>${b.ticked(n)}</strong>`}</span>
      <determine-taxon-picker placeholder=${b.namePlaceholder(n)} ?disabled=${off}
        @pick=${(e: CustomEvent<PickerTaxon>) => {
          this.taxa.set(e.detail.id, e.detail);
          this.#bulk({ animalId: e.detail.id }, b.named(n, e.detail.name));
        }}></determine-taxon-picker>
      ${this.#sexControl(social ? first!.animalId : null, same, (sex, caste) => this.#bulk({ sex, caste }, b.sexSet(n)), b.sexLabel, off)}
      <span class="done">
        ${this.lastBulk
          ? html`<span class="meta">${this.lastBulk.text}</span>
              <button type="button" class="outlined small" @click=${() => this.#undoBulk()}>${b.undo}</button>`
          : nothing}
      </span>
      ${this.#batch
        ? html`<button type="button" class="outlined small" ?disabled=${off} @click=${() => void this.#removeFromBatch(ticked.map((r) => r.id))}>${b.removeFromBatch}</button>`
        : html`<button type="button" class="outlined small" ?disabled=${off} @click=${() => void this.#addTickedToBatch()}>${b.addToBatch}</button>`}
      <button type="button" class="outlined small" ?disabled=${n === 0} @click=${() => (this.selected = new Set())}>${b.untick}</button>
    </div>`;
  }

  #toolbar() {
    if (this.#batch) {
      const bt = d.batch;
      return html`<div class="determine-numbers">
        <label for="determine-add">${bt.add}</label>
        <div class="determine-numbers-box">
          ${this.problems.map(
            (p) => html`<span class="chip warning">${p.text} — ${p.why}
              <button type="button" class="remove" aria-label=${bt.dismiss(p.text)} @click=${() => (this.problems = this.problems.filter((x) => x !== p))}>×</button></span>`,
          )}
          <input id="determine-add" type="text" inputmode="numeric" autocomplete="off" ?disabled=${this.data.readOnly} placeholder=${bt.placeholder}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") void this.#addNumbers(e.target as HTMLInputElement);
            }}
            @paste=${(e: ClipboardEvent) => {
              // Pasting is typing, not Enter: a pasted number may start a
              // range. Only a pasted column is rewritten, since a text field
              // would drop its line breaks and run the numbers together.
              const text = e.clipboardData?.getData("text") ?? "";
              if (!/[\r\n\t]/.test(text)) return;
              e.preventDefault();
              const input = e.target as HTMLInputElement;
              input.setRangeText(pastedList(text), input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, "end");
            }} />
        </div>
        <button type="button" class="tonal" ?disabled=${this.data.readOnly}
          @click=${() => void this.#addNumbers(this.querySelector<HTMLInputElement>("#determine-add")!)}>${bt.addButton}</button>
        ${this.rows.length > 0
          ? html`<button type="button" class="outlined small" ?disabled=${this.data.readOnly} @click=${() => void this.#removeFromBatch("all")}>${bt.emptyBatch}</button>`
          : nothing}
        <p class="meta determine-hint">${bt.hint}</p>
      </div>`;
    }
    const sh = d.show;
    const unnamed = this.#unnamedAtLoad.size;
    return html`<div class="determine-toolbar">
      <div class="segmented" role="group" aria-label=${sh.label}>
        <a href="#unnamed" aria-current=${this.filter === "unnamed" ? "true" : nothing}
          @click=${(e: Event) => { e.preventDefault(); this.#setFilter("unnamed"); }}>${sh.unnamed(unnamed)}</a>
        <a href="#all" aria-current=${this.filter === "all" ? "true" : nothing}
          @click=${(e: Event) => { e.preventDefault(); this.#setFilter("all"); }}>${sh.all(this.rows.length)}</a>
      </div>
      <label class="determine-jump">${d.jump.label}
        <input type="text" inputmode="numeric" autocomplete="off" placeholder=${d.jump.placeholder}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") this.#jump(e.target as HTMLInputElement); }}
          @paste=${(e: ClipboardEvent) => {
            // Here a paste is the whole question, so it goes at once.
            e.preventDefault();
            const input = e.target as HTMLInputElement;
            input.value = (e.clipboardData?.getData("text") ?? "").trim();
            this.#jump(input);
          }} />
      </label>
    </div>`;
  }

  override render() {
    const t = d.table;
    const list = this.#shown();
    const shown = list.slice(0, this.limit);
    const batch = this.#batch;
    const allTicked = list.length > 0 && list.every((r) => this.selected.has(r.id));
    let index = 0;
    const groups: EntryRow[][] = [];
    if (!batch) for (const r of shown) (groups.length > 0 && groups[groups.length - 1]![0]!.sample.id === r.sample.id ? groups[groups.length - 1]!.push(r) : groups.push([r]));
    return html`
      ${this.#toolbar()}
      <p class="determine-message meta" role="status">${this.message}</p>
      ${this.#bulkBar()}
      <div class="table-scroll">
        <table class=${batch ? "determine-grid batch" : "determine-grid"}>
          <colgroup>
            <col class="tick" />
            ${batch ? html`<col class="position" />` : nothing}
            <col class="field-number" />
            ${batch ? html`<col class="sample" />` : nothing}
            <col /><col class="sex" /><col class="saved" />
            ${batch ? html`<col class="tick" />` : nothing}
          </colgroup>
          <thead>
            <tr>
              <th class="tick"><input type="checkbox" .checked=${allTicked} ?disabled=${this.data.readOnly || list.length === 0}
                aria-label=${t.tickAll(list.length)} title=${t.tickAll(list.length)} @click=${() => this.#toggleAll(list)} /></th>
              ${batch ? html`<th>${t.position}</th>` : nothing}
              <th>${t.fieldNumber}</th>
              ${batch ? html`<th>${t.sample}</th>` : nothing}
              <th>${t.name}</th><th>${t.sex}</th><th>${t.saved}</th>
              ${batch ? html`<th><span class="visually-hidden">${d.batch.emptyBatch}</span></th>` : nothing}
            </tr>
          </thead>
          ${batch
            ? html`<tbody>
                ${shown.length === 0
                  ? html`<tr><td colspan="8" class="meta">${d.batch.empty}</td></tr>`
                  : shown.map((r, i) => this.#row(r, list, i, i + 1))}
              </tbody>`
            : shown.length === 0
              ? html`<tbody><tr><td colspan="5" class="meta">${d.emptySeason}</td></tr></tbody>`
              : groups.map(
                  (group) => html`<tbody>
                    <tr class="sample-heading">
                      <td class="tick"><input type="checkbox" .checked=${group.every((r) => this.selected.has(r.id))} ?disabled=${this.data.readOnly}
                        aria-label=${t.tickSample} title=${t.tickSample} @click=${() => this.#toggleAll(group)} /></td>
                      <td colspan="4">${this.#sampleHeading(group[0]!)}</td>
                    </tr>
                    ${group.map((r) => this.#row(r, list, index++, null))}
                  </tbody>`,
                )}
        </table>
      </div>
      ${list.length > shown.length
        ? html`<p><button type="button" class="tonal" @click=${() => (this.limit += CHUNK)}>${t.showMore(Math.min(CHUNK, list.length - shown.length), list.length - shown.length)}</button></p>`
        : nothing}
    `;
  }
}
customElements.define("determine-grid", DetermineGrid);
