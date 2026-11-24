import { sql, type Kysely, type RawBuilder } from "kysely";
import type { Database, DraftCaste, DraftSex } from "../model.js";
import { BEE_FAMILIES, notABee } from "../bee-families.js";
import { DETERMINATION_STATES, inRankBand, observationGone, type DeterminationState } from "./listings.js";
import { NumberIndex, type NumberEntry, type NumberProblem } from "../determination-numbers.js";
import { nearTrapSql } from "../trap-method.js";

/**
 * Volunteers naming their own specimens (beeline-bcq): what the entry screen
 * reads and the three things it writes.
 *
 * Reach is the "mine" rule the listings use — specimens from samples the
 * person collected, following the acting-for switch — and the person writing
 * is always whoever is signed in, never the one being acted for: a draft and
 * a batch belong to the determiner (delegation grants reach, never credit).
 *
 * Expert determinations are deliberately absent. The screen shows a
 * volunteer their own work so that they determine rather than copy; the
 * listings and the specimen page show the rest (Peter, 2026-10-01).
 *
 * Nothing written here is a determination. Drafts become determinations at
 * the overnight commit (src/commit-determinations.ts), which is why a draft
 * can simply be overwritten.
 */

export { BEE_FAMILIES };

export interface EntryValue {
  animalId: number | null;
  /**
   * A name chosen from Ecdysis that the tree does not hold yet, in place of
   * animalId (beeline-4wx3). Only a draft carries one: the overnight commit
   * adopts the name into the tree and records the determination against it.
   */
  ecdysisTid?: number | null;
  sex: DraftSex | null;
  caste: DraftCaste | null;
}

export interface EntrySample {
  id: number;
  number: string;
  dateStart: string;
  dateEnd: string;
  kind: string;
  locality: string | null;
  county: string | null;
  /** iNaturalist observation id, as text: it is a BIGINT. */
  observation: string | null;
  host: string | null;
  /** Whether the sample's method names a trap, so its plant was near the trap rather than visited (beeline-vjqy). */
  hostNearTrap: boolean;
}

export interface EntryRow {
  id: number;
  fieldNumber: string | null;
  specimenNumber: number;
  sample: EntrySample;
  /** The newest volunteer determination already made. Expert ones are not shown here. */
  prior: (EntryValue & { animalId: number; determinedOn: string | null; channel: string }) | null;
  /** This person's entry not yet committed. */
  draft: (EntryValue & { updatedAt: string }) | null;
}

export interface EntrySeason {
  season: number;
  specimens: number;
  /** Specimens no volunteer has named and the person has no draft name for. */
  unnamed: number;
}

export interface EntryTaxon {
  id: number;
  rank: string;
  name: string;
  family: string | null;
  /** Shown beside a name that is not a bee, so a katydid cannot be taken for a wasp of the same spelling. */
  order: string | null;
  bee: boolean;
  castes: boolean;
}

const SHOWN_RANK = "(SELECT x.rank FROM animal x WHERE x.entity_id = coalesce(dd.animal_id, vol.animal_id))";

/** The condition for a naming state on the rows `loadRows` builds, where `vol` and `dd` are joined. */
function namedWhere(det: DeterminationState): RawBuilder<unknown> {
  const hasName = sql`(coalesce(dd.animal_id, vol.animal_id) IS NOT NULL OR dd.ecdysis_tid IS NOT NULL)`;
  if (det === "any") return sql`true`;
  if (det === "determined") return hasName;
  if (det === "undetermined") return sql`NOT ${hasName}`;
  return inRankBand(det, SHOWN_RANK) ?? sql`true`;
}

/** Specimens a person can reach, as a subquery over sample ids. */
const reach = (personId: number) =>
  sql`(SELECT DISTINCT sample_id FROM sample_collector WHERE person_id = ${personId})`;

/**
 * The seasons a person has specimens in. Unnamed is what is left to do: no
 * volunteer has named it, and this person has no draft for it either.
 */
export async function entrySeasons(db: Kysely<Database>, personId: number, determinerId: number): Promise<EntrySeason[]> {
  const result = await sql<EntrySeason>`
    SELECT ss.season,
           CAST(count(*) AS INTEGER) AS specimens,
           CAST(count(*) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM determination d WHERE d.specimen_id = sp.entity_id AND NOT d.is_expert)
             AND NOT EXISTS (
               SELECT 1 FROM determination_draft dd
               WHERE dd.specimen_id = sp.entity_id AND dd.determiner_id = ${determinerId} AND (dd.animal_id IS NOT NULL OR dd.ecdysis_tid IS NOT NULL))) AS INTEGER) AS unnamed
    FROM specimen sp
    JOIN sample_season ss ON ss.sample_id = sp.sample_id
    WHERE sp.sample_id IN ${reach(personId)}
    GROUP BY ss.season
    ORDER BY ss.season DESC`.execute(db);
  return result.rows;
}

/** The season to open on: the newest with anything unnamed, else the newest. */
export const defaultSeason = (seasons: EntrySeason[]): number | null =>
  (seasons.find((s) => s.unnamed > 0) ?? seasons[0])?.season ?? null;

interface RawRow {
  id: number;
  field_number: string | null;
  specimen_number: number;
  sample_id: number;
  sample_number: string;
  date_start: string;
  date_end: string;
  kind: string;
  locality: string | null;
  county: string | null;
  observation: string | null;
  host: string | null;
  host_near_trap: boolean;
  prior_animal: number | null;
  prior_sex: DraftSex | null;
  prior_caste: DraftCaste | null;
  prior_on: string | null;
  prior_channel: string | null;
  draft_animal: number | null;
  draft_ecdysis: number | null;
  draft_sex: DraftSex | null;
  draft_caste: DraftCaste | null;
  draft_at: string | null;
}

/**
 * Rows for the screen. `where` narrows the reachable specimens; `join` and
 * `order` let the batch put them in the order they were added.
 */
async function loadRows(
  db: Kysely<Database>,
  personId: number,
  determinerId: number,
  { where, join = sql``, order }: { where: RawBuilder<unknown>; join?: RawBuilder<unknown>; order: RawBuilder<unknown> },
): Promise<EntryRow[]> {
  const result = await sql<RawRow>`
    WITH vol AS (
      SELECT specimen_id, animal_id, sex, caste, determined_on, channel FROM (
        SELECT d.*, row_number() OVER (PARTITION BY d.specimen_id ORDER BY d.recorded_at DESC, d.entity_id DESC) AS rn
        FROM determination d
        JOIN specimen sp ON sp.entity_id = d.specimen_id
        WHERE NOT d.is_expert AND sp.sample_id IN ${reach(personId)}
      ) ranked WHERE rn = 1
    )
    SELECT sp.entity_id AS id, sp.field_number, sp.specimen_number,
           s.entity_id AS sample_id, s.sample_number,
           CAST(s.date_start AS TEXT) AS date_start, CAST(s.date_end AS TEXT) AS date_end,
           s.kind, s.locality, s.county,
           -- Only to link to, so none where iNaturalist no longer has it (beeline-wcc6).
           CASE WHEN ${observationGone} THEN NULL ELSE CAST(s.inat_observation_id AS TEXT) END AS observation,
           s.host_name_as_observed AS host, ${sql.raw(nearTrapSql("s.entity_id"))} AS host_near_trap,
           vol.animal_id AS prior_animal, vol.sex AS prior_sex, vol.caste AS prior_caste,
           CAST(vol.determined_on AS TEXT) AS prior_on, vol.channel AS prior_channel,
           dd.animal_id AS draft_animal, CAST(dd.ecdysis_tid AS INTEGER) AS draft_ecdysis, dd.sex AS draft_sex, dd.caste AS draft_caste,
           CAST(dd.updated_at AS TEXT) AS draft_at
    FROM specimen sp
    JOIN sample s ON s.entity_id = sp.sample_id
    ${join}
    LEFT JOIN vol ON vol.specimen_id = sp.entity_id
    LEFT JOIN determination_draft dd ON dd.specimen_id = sp.entity_id AND dd.determiner_id = ${determinerId}
    WHERE sp.sample_id IN ${reach(personId)} AND ${where}
    ORDER BY ${order}`.execute(db);
  return result.rows.map((r) => ({
    id: r.id,
    fieldNumber: r.field_number,
    specimenNumber: r.specimen_number,
    sample: {
      id: r.sample_id,
      number: r.sample_number,
      dateStart: r.date_start,
      dateEnd: r.date_end,
      kind: r.kind,
      locality: r.locality,
      county: r.county,
      observation: r.observation,
      host: r.host,
      hostNearTrap: r.host_near_trap === true,
    },
    prior:
      r.prior_animal === null
        ? null
        : { animalId: r.prior_animal, ecdysisTid: null, sex: r.prior_sex, caste: r.prior_caste, determinedOn: r.prior_on, channel: r.prior_channel ?? "" },
    draft:
      r.draft_at === null
        ? null
        : { animalId: r.draft_animal, ecdysisTid: r.draft_ecdysis, sex: r.draft_sex, caste: r.draft_caste, updatedAt: r.draft_at },
  }));
}

/**
 * Collecting order: the season the way it was collected, and within a day
 * the collector's own numbering — length first, so 9 comes before 12 (the
 * listings' rule, src/app/listings.ts). Never the entity id, which is upload
 * order.
 */
const BY_SAMPLE = sql`s.date_start, length(s.sample_number), s.sample_number, s.date_end, s.entity_id, sp.specimen_number`;

/**
 * One collection year's rows, optionally only those named a given distance
 * (beeline-o9rd). Judged as this page judges a name, on what the person sees:
 * their draft if they have one, else the newest volunteer determination, never
 * the determination of record. A draft naming a taxon the tree does not hold
 * yet has no rank to judge, so it counts as named and falls in no band.
 */
export const seasonRows = (db: Kysely<Database>, personId: number, determinerId: number, season: number, det: DeterminationState = "any") =>
  loadRows(db, personId, determinerId, {
    where: sql`sp.sample_id IN (SELECT sample_id FROM sample_season WHERE season = ${season}) AND ${namedWhere(det)}`,
    order: BY_SAMPLE,
  });

export const batchRows = (db: Kysely<Database>, personId: number, determinerId: number) =>
  loadRows(db, personId, determinerId, {
    join: sql`JOIN determination_batch b ON b.specimen_id = sp.entity_id AND b.person_id = ${determinerId}`,
    where: sql`true`,
    order: sql`b.position`,
  });

/**
 * The page's rows for these specimens, as the page would show them to this
 * person: only those within their reach, so a specimen missing from the
 * answer is one this page would not let them name. An upload of their file
 * reads its rows through this (src/app/upload-drafts.ts), so it names exactly
 * the specimens the page does.
 */
export const entryRowsFor = (db: Kysely<Database>, personId: number, determinerId: number, ids: readonly number[]) =>
  ids.length === 0
    ? Promise.resolve([])
    : loadRows(db, personId, determinerId, {
        where: sql`sp.entity_id IN (${sql.join(ids)})`,
        order: BY_SAMPLE,
      });

export async function batchSize(db: Kysely<Database>, personId: number, determinerId: number): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT CAST(count(*) AS INTEGER) AS n FROM determination_batch b
    JOIN specimen sp ON sp.entity_id = b.specimen_id
    WHERE b.person_id = ${determinerId} AND sp.sample_id IN ${reach(personId)}`.execute(db);
  return result.rows[0]?.n ?? 0;
}

let taxaMemo: { at: number; taxa: EntryTaxon[] } | null = null;
const TAXA_TTL_MS = 10 * 60_000;

/**
 * Every name a specimen can be given, for the picker. The tree changes only
 * when it is promoted, so it is remembered for a few minutes rather than
 * recounted on every page.
 */
export async function entryTaxa(db: Kysely<Database>, now = Date.now()): Promise<EntryTaxon[]> {
  if (taxaMemo !== null && now - taxaMemo.at < TAXA_TTL_MS) return taxaMemo.taxa;
  const nodes = (
    await sql<{ id: number; rank: string; name: string; filed_under_id: number | null; castes: boolean }>`
      SELECT a.entity_id AS id, a.rank, a.scientific_name AS name, a.filed_under_id, c.has_castes AS castes
      FROM animal_tree a
      JOIN animal_castes c ON c.animal_id = a.entity_id`.execute(db)
  ).rows;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const above = (id: number, rank: string): string | null => {
    for (let n = byId.get(id); n !== undefined; n = n.filed_under_id === null ? undefined : byId.get(n.filed_under_id)) {
      if (n.rank === rank) return n.name;
    }
    return null;
  };
  const taxa = nodes
    // Kingdom to class are scaffolding: nobody names a pinned insect "Insecta".
    .filter((n) => !["kingdom", "phylum", "class"].includes(n.rank))
    .map((n) => {
      const f = above(n.id, "family");
      return {
        id: n.id,
        rank: n.rank,
        name: n.name,
        family: f,
        order: above(n.id, "order"),
        bee: f !== null && BEE_FAMILIES.includes(f),
        castes: n.castes,
      };
    });
  taxaMemo = { at: now, taxa };
  return taxa;
}

/** For tests: forget the remembered taxa. */
export const forgetEntryTaxa = () => {
  taxaMemo = null;
};

/** A name from Ecdysis that the tree does not hold yet, offered by the picker once the bycatch box is ticked. */
export interface EcdysisName {
  /** Ecdysis's taxon id. */
  tid: number;
  rank: string;
  name: string;
  family: string | null;
  order: string | null;
}

/** Fewer letters than this match too many of Ecdysis's names to be worth sending. */
export const ECDYSIS_SEARCH_MIN = 3;

const searchWords = (s: string) => s.toLowerCase().replace(/[().]/g, " ").split(/\s+/).filter(Boolean);

/**
 * Names from Ecdysis's taxonomy for what is typed (beeline-4wx3): those the
 * tree could adopt (ecdysis_adoptable) and does not already spell, leaving
 * out bees, since a bee's name the tree lacks waits for a taxonomist
 * (src/load-ecdysis.ts). The first word typed must start the name, so a
 * species is found through its genus (`tenthredo a`), not by its epithet
 * alone as names in the tree are: with no limit by place, an epithet alone
 * matches species from every continent. Each later word must start a later
 * word of the name, as in the picker's own search. Shortest names first, so
 * a genus comes before its species.
 */
export async function searchEcdysisNames(db: Kysely<Database>, query: string, limit = 10): Promise<EcdysisName[]> {
  // Capped, since each word adds a condition: no name needs more than four.
  const words = searchWords(query.slice(0, 100)).slice(0, 4);
  const first = words[0];
  if (first === undefined || first.length < ECDYSIS_SEARCH_MIN) return [];
  // Every key that starts with the first word sorts at or after it and before
  // the word with its last letter moved one on: a range the table's sort
  // lets the engine read only part of.
  const after = first.slice(0, -1) + String.fromCharCode(first.charCodeAt(first.length - 1) + 1);
  const later = words.slice(1).map((w) => sql`AND contains(e.name_key, ${` ${w}`})`);
  const result = await sql<{ tid: number; rank: string; name: string; family: string | null; order: string | null }>`
    SELECT CAST(e.tid AS INTEGER) AS tid, e.rank, e.name, e.family, e.insect_order AS "order"
    FROM ecdysis_adoptable e
    WHERE e.name_key >= ${first} AND e.name_key < ${after}
      ${later.length > 0 ? sql.join(later, sql` `) : sql``}
      AND ${sql.raw(notABee("e"))}
      AND NOT EXISTS (SELECT 1 FROM animal a WHERE a.scientific_name = e.name)
    ORDER BY length(e.name), e.name
    LIMIT 200`.execute(db);
  return result.rows
    .filter((r) => {
      // In order, each word starting a word of the name: what the SQL above
      // only approximates, since it does not check the order.
      let i = 0;
      for (const w of searchWords(r.name)) if (i < words.length && w.startsWith(words[i]!)) i++;
      return i === words.length;
    })
    .slice(0, limit);
}

export class UnreachableSpecimens extends Error {
  constructor(readonly ids: number[]) {
    super(`specimens not reachable: ${ids.join(", ")}`);
  }
}

/** A request whose body is not the shape the endpoint takes: the client's error, answered 400. */
export class BadRequest extends Error {}

export class UnknownTaxon extends Error {
  constructor(readonly ids: number[]) {
    super(`no such taxa: ${ids.join(", ")}`);
  }
}

async function assertReachable(db: Kysely<Database>, personId: number, ids: readonly number[]) {
  if (ids.length === 0) return;
  const found = await sql<{ id: number }>`
    SELECT entity_id AS id FROM specimen
    WHERE entity_id IN (${sql.join(ids)}) AND sample_id IN ${reach(personId)}`.execute(db);
  const ok = new Set(found.rows.map((r) => r.id));
  const missing = ids.filter((id) => !ok.has(id));
  if (missing.length > 0) throw new UnreachableSpecimens(missing);
}

/**
 * A change to what one specimen says. A part left out (`undefined`) stays as
 * the store has it; a part given, `null` included, replaces it. The name is
 * one part (`animalId` and `ecdysisTid` together, since a name is one or the
 * other) and the sex is the other (`sex` and `caste` together, since a caste
 * belongs to a sex).
 */
export interface DraftWrite {
  specimenId: number;
  animalId?: number | null;
  ecdysisTid?: number | null;
  sex?: DraftSex | null;
  caste?: DraftCaste | null;
}

const same = (a: EntryValue, b: EntryValue) =>
  a.animalId === b.animalId && (a.ecdysisTid ?? null) === (b.ecdysisTid ?? null) && a.sex === b.sex && a.caste === b.caste;

/**
 * Write what each specimen should now say. Each write changes the name, the
 * sex or both, and the part it leaves out stays as the store has it: the
 * person's draft, or with no draft the determination already made
 * (beeline-rt6h). Before that a write was the whole row as the sender's
 * screen showed it and replaced the draft, so a screen with an old copy of a
 * row (a second tab, a page the browser brought back) that set a sex on it
 * erased a name saved since. The result is normalised against the taxon — a
 * caste only where the taxon has castes, and a male of a social bee is a
 * drone — and one that says nothing new (empty, or the same as the
 * determination already made) removes the draft rather than keeping one.
 * Returns the rows as they now stand.
 */
export function saveDrafts(
  db: Kysely<Database>,
  personId: number,
  determinerId: number,
  writes: readonly DraftWrite[],
  now: Date = new Date(),
): Promise<EntryRow[]> {
  return inDraftTurn(() => saveDraftsInTurn(db, personId, determinerId, writes, now));
}

/**
 * Run `work` in the drafts' turn: after every save already waiting, and
 * before any that comes later. A save reads the draft, lays its parts over it
 * and writes the whole draft back, so two at once for one specimen (a name
 * from one tab and a sex from another) could each read the draft before the
 * other wrote, and the later would put back the part the earlier had changed.
 * An upload works its drafts out and writes them in one turn, so nothing the
 * page saves can land between the two (src/app/upload-drafts.ts). The app is
 * the only process that writes the store (ADR 0005).
 */
export function inDraftTurn<T>(work: () => Promise<T>): Promise<T> {
  const mine = savingDrafts.then(work);
  savingDrafts = mine.then(
    () => undefined,
    () => undefined,
  );
  return mine;
}

let savingDrafts: Promise<void> = Promise.resolve();

/**
 * saveDrafts' own work, for a caller already in the drafts' turn
 * (`inDraftTurn`), which may pass a transaction as `db`. Anywhere else, call
 * saveDrafts.
 */
export async function saveDraftsInTurn(
  db: Kysely<Database>,
  personId: number,
  determinerId: number,
  writes: readonly DraftWrite[],
  now: Date,
): Promise<EntryRow[]> {
  const ids = [...new Set(writes.map((w) => w.specimenId))];
  await assertReachable(db, personId, ids);
  if (writes.some((w) => (w.animalId ?? null) !== null && (w.ecdysisTid ?? null) !== null)) {
    throw new BadRequest("a write names a taxon in the tree and one from Ecdysis");
  }
  // Each write laid over what the store has for its specimen. Several for
  // one specimen apply in the order given.
  const before = new Map((await entryRowsFor(db, personId, determinerId, ids)).map((r) => [r.id, r]));
  const merged = new Map<number, EntryValue & { specimenId: number; named: boolean }>();
  for (const w of writes) {
    const row = before.get(w.specimenId);
    const base = merged.get(w.specimenId) ?? row?.draft ?? row?.prior ?? null;
    const names = w.animalId !== undefined || w.ecdysisTid !== undefined;
    const sexes = w.sex !== undefined || w.caste !== undefined;
    merged.set(w.specimenId, {
      specimenId: w.specimenId,
      animalId: names ? (w.animalId ?? null) : (base?.animalId ?? null),
      ecdysisTid: names ? (w.ecdysisTid ?? null) : (base?.ecdysisTid ?? null),
      sex: sexes ? (w.sex ?? null) : (base?.sex ?? null),
      caste: sexes ? (w.caste ?? null) : (base?.caste ?? null),
      named: names || merged.get(w.specimenId)?.named === true,
    });
  }
  const values = [...merged.values()];
  // A name from Ecdysis that the tree has adopted since it was offered (the
  // overnight commit adopted it for someone else's draft) is written as the
  // node, so a draft carries an Ecdysis id only while the tree lacks the name.
  const tids = [...new Set(values.map((w) => w.ecdysisTid ?? null).filter((id): id is number => id !== null))];
  const adopted = new Map<number, number>();
  const offered = new Set<number>();
  if (tids.length > 0) {
    const held = await sql<{ tid: number; id: number }>`
      SELECT CAST(ecdysis_tid AS INTEGER) AS tid, min(entity_id) AS id FROM animal
      WHERE ecdysis_tid IN (${sql.join(tids)}) GROUP BY ecdysis_tid`.execute(db);
    for (const r of held.rows) adopted.set(r.tid, r.id);
    // Only a name this request gives is checked. One a draft already holds
    // was checked when it was given, and a later fetch of Ecdysis that
    // stopped offering it must not refuse a sex set beside it.
    const given = new Set(values.filter((w) => w.named).map((w) => w.ecdysisTid ?? null));
    const rest = tids.filter((t) => !adopted.has(t) && given.has(t));
    if (rest.length > 0) {
      // What the search offers (searchEcdysisNames), checked again here
      // because an id is easy to type.
      const found = await sql<{ tid: number }>`
        SELECT CAST(e.tid AS INTEGER) AS tid FROM ecdysis_adoptable e
        WHERE e.tid IN (${sql.join(rest)})
          AND ${sql.raw(notABee("e"))}
          AND NOT EXISTS (SELECT 1 FROM animal a WHERE a.scientific_name = e.name)`.execute(db);
      for (const r of found.rows) offered.add(r.tid);
      const missing = rest.filter((t) => !offered.has(t));
      if (missing.length > 0) throw new UnknownTaxon(missing);
    }
  }
  const resolved = values.map((w) =>
    w.ecdysisTid != null && adopted.has(w.ecdysisTid) ? { ...w, animalId: adopted.get(w.ecdysisTid)!, ecdysisTid: null } : w,
  );
  const animalIds = [...new Set(resolved.map((w) => w.animalId).filter((id): id is number => id !== null))];
  const castes = new Map<number, boolean>();
  if (animalIds.length > 0) {
    const found = await sql<{ id: number; castes: boolean }>`
      SELECT animal_id AS id, has_castes AS castes FROM animal_castes WHERE animal_id IN (${sql.join(animalIds)})`.execute(db);
    for (const r of found.rows) castes.set(r.id, r.castes);
    const missing = animalIds.filter((id) => !castes.has(id));
    if (missing.length > 0) throw new UnknownTaxon(missing);
  }
  const upserts: (EntryValue & { specimenId: number })[] = [];
  const removals: number[] = [];
  for (const w of resolved) {
    const sex: DraftSex | null = w.sex === "female" || w.sex === "male" ? w.sex : null;
    // A name from Ecdysis is never a bee (searchEcdysisNames), so it has no castes.
    const social = w.animalId !== null && castes.get(w.animalId) === true;
    let caste: DraftCaste | null = null;
    if (social && sex === "male") caste = "drone";
    else if (social && sex === "female" && (w.caste === "gyne" || w.caste === "worker")) caste = w.caste;
    const value: EntryValue = { animalId: w.animalId, ecdysisTid: w.ecdysisTid ?? null, sex, caste };
    const prior = before.get(w.specimenId)?.prior ?? null;
    const says = value.animalId !== null || value.ecdysisTid != null || value.sex !== null;
    if (!says || (prior !== null && same(value, prior))) removals.push(w.specimenId);
    else upserts.push({ specimenId: w.specimenId, ...value });
  }

  if (upserts.length > 0) {
    const values = upserts.map(
      (u) => sql`(${u.specimenId}, ${determinerId}, ${u.animalId}, ${u.ecdysisTid ?? null}, ${u.sex}, ${u.caste}, ${now.toISOString()})`,
    );
    await sql`
      INSERT INTO determination_draft (specimen_id, determiner_id, animal_id, ecdysis_tid, sex, caste, updated_at)
      VALUES ${sql.join(values)}
      ON CONFLICT (specimen_id, determiner_id) DO UPDATE SET
        animal_id = excluded.animal_id, ecdysis_tid = excluded.ecdysis_tid, sex = excluded.sex, caste = excluded.caste,
        updated_at = excluded.updated_at`.execute(db);
  }
  if (removals.length > 0) {
    await sql`DELETE FROM determination_draft WHERE determiner_id = ${determinerId} AND specimen_id IN (${sql.join(removals)})`.execute(db);
  }
  return entryRowsFor(db, personId, determinerId, ids);
}

/** What adding numbers to a batch did, entry by entry. */
export interface BatchAddition {
  entries: { text: string; found: number; problem: NumberEntry["problem"] }[];
  added: number;
  already: number;
  /** The specimens the entries named, in the order given — for the screen to point at. */
  named: number[];
}

/**
 * Add what was typed, pasted or scanned to the end of the batch, in the
 * order given. Numbers are looked for among every specimen the person can
 * reach, in any season, since a box sorted by genus mixes years.
 */
export async function addToBatch(db: Kysely<Database>, personId: number, determinerId: number, typed: string): Promise<BatchAddition> {
  const numbered = await sql<{ id: number; fieldNumber: string | null }>`
    SELECT entity_id AS id, field_number AS "fieldNumber" FROM specimen WHERE sample_id IN ${reach(personId)}`.execute(db);
  const entries = new NumberIndex(numbered.rows).resolveAll(typed);
  const named = [...new Set(entries.flatMap((e) => e.ids))];
  const present = new Set(
    named.length === 0
      ? []
      : (
          await sql<{ id: number }>`
            SELECT specimen_id AS id FROM determination_batch
            WHERE person_id = ${determinerId} AND specimen_id IN (${sql.join(named)})`.execute(db)
        ).rows.map((r) => r.id),
  );
  const fresh = named.filter((id) => !present.has(id));
  if (fresh.length > 0) {
    const top = await sql<{ top: number }>`
      SELECT CAST(coalesce(max(position), 0) AS INTEGER) AS top FROM determination_batch WHERE person_id = ${determinerId}`.execute(db);
    const base = top.rows[0]?.top ?? 0;
    const values = fresh.map((id, i) => sql`(${determinerId}, ${id}, ${base + i + 1})`);
    await sql`
      INSERT INTO determination_batch (person_id, specimen_id, position) VALUES ${sql.join(values)}
      ON CONFLICT (person_id, specimen_id) DO NOTHING`.execute(db);
  }
  return {
    entries: entries.map((e) => ({ text: e.text, found: e.ids.length, problem: e.problem })),
    added: fresh.length,
    already: named.length - fresh.length,
    named,
  };
}

/**
 * A specimen found by its field number and the collection year it is listed
 * under; a range or a list, which names several (the find box takes one); or
 * what was wrong with the number.
 */
export type Located = { specimen: number; season: number } | { several: number } | { problem: NumberProblem };

/**
 * Finds one specimen by a typed field number, or its last few digits, among
 * every specimen the person can reach in any year (beeline-mjml). The By
 * season view looks in the year it shows first; this is where it looks when
 * the number is in another, so finding specimens from several years does not
 * mean switching the menu between them.
 */
export async function locateSpecimen(db: Kysely<Database>, personId: number, typed: string): Promise<Located> {
  const numbered = await sql<{ id: number; fieldNumber: string | null }>`
    SELECT entity_id AS id, field_number AS "fieldNumber" FROM specimen WHERE sample_id IN ${reach(personId)}`.execute(db);
  const entry = new NumberIndex(numbered.rows).resolve(typed.trim());
  if (entry.problem !== null) return { problem: entry.problem };
  if (entry.ids.length !== 1) return { several: entry.ids.length };
  const id = entry.ids[0]!;
  const season = await seasonOf(db, personId, id);
  return season === null ? { problem: { code: "noSpecimens" } } : { specimen: id, season };
}

/** The collection year of a specimen the person can reach, or null if they cannot reach it. */
export async function seasonOf(db: Kysely<Database>, personId: number, specimenId: number): Promise<number | null> {
  const result = await sql<{ season: number }>`
    SELECT ss.season FROM specimen sp JOIN sample_season ss ON ss.sample_id = sp.sample_id
    WHERE sp.entity_id = ${specimenId} AND sp.sample_id IN ${reach(personId)}`.execute(db);
  return result.rows[0]?.season ?? null;
}

/** Add specimens already on screen (ticked in the by-sample view) to the batch. */
export async function addSpecimensToBatch(db: Kysely<Database>, personId: number, determinerId: number, ids: readonly number[]) {
  await assertReachable(db, personId, ids);
  if (ids.length === 0) return;
  const top = await sql<{ top: number }>`
    SELECT CAST(coalesce(max(position), 0) AS INTEGER) AS top FROM determination_batch WHERE person_id = ${determinerId}`.execute(db);
  const base = top.rows[0]?.top ?? 0;
  const values = ids.map((id, i) => sql`(${determinerId}, ${id}, ${base + i + 1})`);
  await sql`
    INSERT INTO determination_batch (person_id, specimen_id, position) VALUES ${sql.join(values)}
    ON CONFLICT (person_id, specimen_id) DO NOTHING`.execute(db);
}

export async function removeFromBatch(db: Kysely<Database>, determinerId: number, ids: readonly number[] | "all") {
  if (ids === "all") {
    await sql`DELETE FROM determination_batch WHERE person_id = ${determinerId}`.execute(db);
  } else if (ids.length > 0) {
    await sql`DELETE FROM determination_batch WHERE person_id = ${determinerId} AND specimen_id IN (${sql.join(ids)})`.execute(db);
  }
}

/**
 * The key a name chosen from Ecdysis goes by in rowTaxa's answer and the
 * page's list of names, beside the tree's entity ids: the Ecdysis id made
 * negative, since an entity id never is (the picker reads it the same way,
 * src/app/islands/determine/picker.ts).
 */
export const ecdysisKey = (tid: number) => -tid;

/**
 * The names rows already carry, so the page can show them before the full
 * list loads: the tree's by entity id, and a draft's name from Ecdysis under
 * ecdysisKey.
 */
export async function rowTaxa(
  db: Kysely<Database>,
  rows: readonly EntryRow[],
): Promise<Record<number, { name: string; rank: string; castes: boolean }>> {
  const ids = [...new Set(rows.flatMap((r) => [r.prior?.animalId ?? null, r.draft?.animalId ?? null]).filter((id): id is number => id !== null))];
  const tids = [...new Set(rows.map((r) => r.draft?.ecdysisTid ?? null).filter((id): id is number => id !== null))];
  const out: Record<number, { name: string; rank: string; castes: boolean }> = {};
  if (ids.length > 0) {
    const found = await sql<{ id: number; name: string; rank: string; castes: boolean }>`
      SELECT a.entity_id AS id, a.scientific_name AS name, a.rank, c.has_castes AS castes
      FROM animal a JOIN animal_castes c ON c.animal_id = a.entity_id
      WHERE a.entity_id IN (${sql.join(ids)})`.execute(db);
    for (const r of found.rows) out[r.id] = { name: r.name, rank: r.rank, castes: r.castes };
  }
  if (tids.length > 0) {
    // From the thesaurus itself rather than ecdysis_adoptable, so a draft
    // still shows its name if a later fetch stopped offering it.
    const found = await sql<{ tid: number; name: string; rank: string }>`
      SELECT CAST(tid AS INTEGER) AS tid, name, rank FROM ecdysis_taxon WHERE tid IN (${sql.join(tids)})`.execute(db);
    for (const r of found.rows) out[ecdysisKey(r.tid)] = { name: r.name, rank: r.rank, castes: false };
  }
  return out;
}
