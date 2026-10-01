/**
 * PROTOTYPE (beeline-bcq) — the in-browser state every determination variant
 * shares. Nothing persists: a reload starts over, which is the point.
 *
 * Two kinds of thing, kept apart because telling them apart is the open
 * design question: a *draft* is the working value of a specimen in this
 * session, and an *event* is what the page would append to `determination`.
 * Each variant decides when one becomes the other.
 */
import { html, nothing, type TemplateResult } from "lit";

export interface Taxon {
  id: number;
  rank: string;
  name: string;
  family: string | null;
  genus: string | null;
  parentId: number | null;
  bee: boolean;
  uses: number;
}

export interface Prior {
  animalId: number;
  sex: string | null;
  caste: string | null;
  qualifier: string | null;
  recordedAt: string;
}

export interface Specimen {
  id: number;
  fieldNumber: string | null;
  specimenNumber: number;
  sampleId: number;
  sampleNumber: string;
  dateStart: string;
  dateEnd: string;
  kind: string;
  locality: string | null;
  county: string | null;
  observation: number | null;
  host: string | null;
  prior: Prior | null;
}

export interface Data {
  person: string;
  season: number;
  specimens: Specimen[];
  taxa: Taxon[];
}

export interface Assertion {
  animalId: number | null;
  sex: string | null;
  caste: string | null;
}

export interface Draft extends Assertion {
  specimenId: number;
  at: number;
}

export interface Recorded extends Draft {
  seq: number;
}

const ITALIC = new Set(["genus", "subgenus", "species", "subspecies"]);
const CASTE_GENERA = new Set(["Bombus", "Apis"]);

class Store extends EventTarget {
  data: Data;
  taxa: Map<number, Taxon>;
  specimens: Map<number, Specimen>;
  byNumber: Map<string, Specimen>;
  drafts = new Map<number, Draft>();
  events: Recorded[] = [];
  #seq = 0;

  constructor() {
    super();
    const el = document.getElementById("det-proto-data");
    this.data = JSON.parse(el?.textContent ?? "{}") as Data;
    this.taxa = new Map(this.data.taxa.map((t) => [t.id, t]));
    this.specimens = new Map(this.data.specimens.map((s) => [s.id, s]));
    this.byNumber = new Map(this.data.specimens.filter((s) => s.fieldNumber).map((s) => [s.fieldNumber!, s]));
  }

  changed() {
    this.dispatchEvent(new Event("change"));
  }

  /** The value a specimen shows: this session's draft, else what it recorded, else what the store already held. */
  current(id: number): Assertion | null {
    const d = this.drafts.get(id);
    if (d) return d;
    const e = this.lastEvent(id);
    if (e) return e;
    const p = this.specimens.get(id)?.prior;
    return p ? { animalId: p.animalId, sex: p.sex, caste: p.caste } : null;
  }

  lastEvent(id: number): Recorded | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]!.specimenId === id) return this.events[i];
    return undefined;
  }

  isOutstanding(id: number): boolean {
    return this.current(id)?.animalId == null;
  }

  setDrafts(ids: Iterable<number>, a: Partial<Assertion>) {
    const at = Date.now();
    for (const id of ids) {
      const base = this.current(id) ?? { animalId: null, sex: null, caste: null };
      const next = { ...base, ...a };
      // A taxon change can make the caste meaningless (Bombus → Andrena).
      if (a.animalId !== undefined && !hasCaste(next.animalId)) next.caste = null;
      this.drafts.set(id, { ...next, specimenId: id, at });
    }
    this.changed();
  }

  clearDraft(id: number) {
    this.drafts.delete(id);
    this.changed();
  }

  /** Turn drafts into would-be events. Returns the events made. */
  record(ids: Iterable<number>): Recorded[] {
    const made: Recorded[] = [];
    for (const id of ids) {
      const d = this.drafts.get(id);
      if (!d || d.animalId == null) continue;
      const e = { ...d, seq: ++this.#seq, at: Date.now() };
      this.events.push(e);
      this.drafts.delete(id);
      made.push(e);
    }
    this.changed();
    return made;
  }

  /** In-session retraction of an event nothing has consumed yet. */
  unrecord(seq: number) {
    this.events = this.events.filter((e) => e.seq !== seq);
    this.changed();
  }
}

let instance: Store | null = null;
export const store = (): Store => (instance ??= new Store());

export function hasCaste(animalId: number | null): boolean {
  if (animalId == null) return false;
  const t = store().taxa.get(animalId);
  return t?.genus != null && CASTE_GENERA.has(t.genus);
}

export interface SexChoice {
  label: string;
  sex: string | null;
  caste: string | null;
}

/** Bumble and honey bees are sexed by caste; everything else by sex. */
export function sexChoices(animalId: number | null): SexChoice[] {
  return hasCaste(animalId)
    ? [
        { label: "Queen", sex: "female", caste: "gyne" },
        { label: "Worker", sex: "female", caste: "worker" },
        { label: "Male", sex: "male", caste: "drone" },
      ]
    : [
        { label: "Female", sex: "female", caste: null },
        { label: "Male", sex: "male", caste: null },
      ];
}

export function sexLabel(a: Pick<Assertion, "sex" | "caste"> | null): string {
  if (!a || a.sex == null) return "";
  if (a.caste === "gyne") return "Queen";
  if (a.caste === "worker") return "Worker";
  if (a.sex === "female") return "Female";
  if (a.sex === "male") return "Male";
  return a.sex;
}

export function taxonName(id: number | null, opts: { rank?: boolean } = {}): TemplateResult | typeof nothing {
  if (id == null) return nothing;
  const t = store().taxa.get(id);
  if (!t) return html`#${id}`;
  const name = ITALIC.has(t.rank) ? html`<i>${t.name}</i>` : html`${t.name}`;
  return html`<span class="taxon">${name}</span>${opts.rank ? html` <span class="proto-rank">${t.rank}</span>` : nothing}`;
}

export const plainName = (id: number | null): string => (id == null ? "" : (store().taxa.get(id)?.name ?? `#${id}`));

/**
 * Names matching what someone typed: every word they typed must start a word
 * of the name, in order — `bom vos` finds Bombus vosnesenskii, `b vos` too.
 * Commoner names first, bees before bycatch.
 */
export function searchTaxa(query: string, { bycatch = false, limit = 10 } = {}): Taxon[] {
  const q = query.toLowerCase().replace(/[().]/g, " ").split(/\s+/).filter(Boolean);
  if (q.length === 0) return [];
  const out: { t: Taxon; score: number }[] = [];
  for (const t of store().data.taxa) {
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

export const fmtDate = (iso: string): string =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export const sampleLabel = (s: Specimen): string =>
  `Sample ${s.sampleNumber} · ${s.dateStart === s.dateEnd ? fmtDate(s.dateStart) : `${fmtDate(s.dateStart)}–${fmtDate(s.dateEnd)}`}`;

export const placeLabel = (s: Specimen): string => s.locality ?? s.county ?? "no locality";

export const inatHref = (s: Specimen): string | null =>
  s.observation === null ? null : `https://www.inaturalist.org/observations/${s.observation}`;

/** Specimens grouped by sample, in the order loaded. */
export function bySample(list: Specimen[]): Specimen[][] {
  const groups: Specimen[][] = [];
  let last: number | null = null;
  for (const s of list) {
    if (s.sampleId !== last) groups.push([]);
    groups[groups.length - 1]!.push(s);
    last = s.sampleId;
  }
  return groups;
}
