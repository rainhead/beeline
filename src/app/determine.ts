import { sql, type Kysely, type RawBuilder } from "kysely";
import type { Database, DraftCaste, DraftSex } from "../model.js";
import { NumberIndex, type NumberEntry } from "../determination-numbers.js";

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

/** Bee families. Everything else in the tree is bycatch, offered only on request. */
export const BEE_FAMILIES: readonly string[] = ["Andrenidae", "Apidae", "Colletidae", "Halictidae", "Megachilidae", "Melittidae"];

export interface EntryValue {
  animalId: number | null;
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
  bee: boolean;
  castes: boolean;
  /** Specimens whose determination of record is this node: how common it is, to order suggestions. */
  uses: number;
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
               WHERE dd.specimen_id = sp.entity_id AND dd.determiner_id = ${determinerId} AND dd.animal_id IS NOT NULL)) AS INTEGER) AS unnamed
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
  prior_animal: number | null;
  prior_sex: DraftSex | null;
  prior_caste: DraftCaste | null;
  prior_on: string | null;
  prior_channel: string | null;
  draft_animal: number | null;
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
           s.kind, s.locality, s.county, CAST(s.inat_observation_id AS TEXT) AS observation,
           s.host_name_as_observed AS host,
           vol.animal_id AS prior_animal, vol.sex AS prior_sex, vol.caste AS prior_caste,
           CAST(vol.determined_on AS TEXT) AS prior_on, vol.channel AS prior_channel,
           dd.animal_id AS draft_animal, dd.sex AS draft_sex, dd.caste AS draft_caste,
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
    },
    prior:
      r.prior_animal === null
        ? null
        : { animalId: r.prior_animal, sex: r.prior_sex, caste: r.prior_caste, determinedOn: r.prior_on, channel: r.prior_channel ?? "" },
    draft:
      r.draft_at === null ? null : { animalId: r.draft_animal, sex: r.draft_sex, caste: r.draft_caste, updatedAt: r.draft_at },
  }));
}

/**
 * Collecting order: the season the way it was collected, and within a day
 * the collector's own numbering — length first, so 9 comes before 12 (the
 * listings' rule, src/app/listings.ts). Never the entity id, which is upload
 * order.
 */
const BY_SAMPLE = sql`s.date_start, length(s.sample_number), s.sample_number, s.date_end, s.entity_id, sp.specimen_number`;

export const seasonRows = (db: Kysely<Database>, personId: number, determinerId: number, season: number) =>
  loadRows(db, personId, determinerId, {
    where: sql`sp.sample_id IN (SELECT sample_id FROM sample_season WHERE season = ${season})`,
    order: BY_SAMPLE,
  });

export const batchRows = (db: Kysely<Database>, personId: number, determinerId: number) =>
  loadRows(db, personId, determinerId, {
    join: sql`JOIN determination_batch b ON b.specimen_id = sp.entity_id AND b.person_id = ${determinerId}`,
    where: sql`true`,
    order: sql`b.position`,
  });

const rowsById = (db: Kysely<Database>, personId: number, determinerId: number, ids: readonly number[]) =>
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
    await sql<{ id: number; rank: string; name: string; parent_id: number | null; castes: boolean; uses: number }>`
      SELECT a.entity_id AS id, a.rank, a.scientific_name AS name, a.parent_id, c.has_castes AS castes,
             CAST(coalesce(u.n, 0) AS INTEGER) AS uses
      FROM animal a
      JOIN animal_castes c ON c.animal_id = a.entity_id
      LEFT JOIN (SELECT animal_id, count(*) AS n FROM determination_of_record GROUP BY animal_id) u ON u.animal_id = a.entity_id`.execute(db)
  ).rows;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const family = (id: number): string | null => {
    for (let n = byId.get(id); n !== undefined; n = n.parent_id === null ? undefined : byId.get(n.parent_id)) {
      if (n.rank === "family") return n.name;
    }
    return null;
  };
  const taxa = nodes
    // Kingdom to class are scaffolding: nobody names a pinned insect "Insecta".
    .filter((n) => !["kingdom", "phylum", "class"].includes(n.rank))
    .map((n) => {
      const f = family(n.id);
      return { id: n.id, rank: n.rank, name: n.name, family: f, bee: f !== null && BEE_FAMILIES.includes(f), castes: n.castes, uses: n.uses };
    });
  taxaMemo = { at: now, taxa };
  return taxa;
}

/** For tests: forget the remembered taxa. */
export const forgetEntryTaxa = () => {
  taxaMemo = null;
};

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

export interface DraftWrite extends EntryValue {
  specimenId: number;
}

const same = (a: EntryValue, b: EntryValue) => a.animalId === b.animalId && a.sex === b.sex && a.caste === b.caste;

/**
 * Write what each specimen should now say. The value is normalised against
 * the taxon — a caste only where the taxon has castes, and a male of a social
 * bee is a drone — and a value that says nothing new (empty, or the same as
 * the determination already made) removes the draft rather than keeping one.
 * Returns the rows as they now stand.
 */
export async function saveDrafts(
  db: Kysely<Database>,
  personId: number,
  determinerId: number,
  writes: readonly DraftWrite[],
  now: Date = new Date(),
): Promise<EntryRow[]> {
  const ids = [...new Set(writes.map((w) => w.specimenId))];
  await assertReachable(db, personId, ids);
  const animalIds = [...new Set(writes.map((w) => w.animalId).filter((id): id is number => id !== null))];
  const castes = new Map<number, boolean>();
  if (animalIds.length > 0) {
    const found = await sql<{ id: number; castes: boolean }>`
      SELECT animal_id AS id, has_castes AS castes FROM animal_castes WHERE animal_id IN (${sql.join(animalIds)})`.execute(db);
    for (const r of found.rows) castes.set(r.id, r.castes);
    const missing = animalIds.filter((id) => !castes.has(id));
    if (missing.length > 0) throw new UnknownTaxon(missing);
  }
  const before = new Map((await rowsById(db, personId, determinerId, ids)).map((r) => [r.id, r]));

  const upserts: DraftWrite[] = [];
  const removals: number[] = [];
  for (const w of new Map(writes.map((w) => [w.specimenId, w])).values()) {
    const sex: DraftSex | null = w.sex === "female" || w.sex === "male" ? w.sex : null;
    const social = w.animalId !== null && castes.get(w.animalId) === true;
    let caste: DraftCaste | null = null;
    if (social && sex === "male") caste = "drone";
    else if (social && sex === "female" && (w.caste === "gyne" || w.caste === "worker")) caste = w.caste;
    const value: EntryValue = { animalId: w.animalId, sex, caste };
    const prior = before.get(w.specimenId)?.prior ?? null;
    const says = value.animalId !== null || value.sex !== null;
    if (!says || (prior !== null && same(value, prior))) removals.push(w.specimenId);
    else upserts.push({ specimenId: w.specimenId, ...value });
  }

  if (upserts.length > 0) {
    const values = upserts.map((u) => sql`(${u.specimenId}, ${determinerId}, ${u.animalId}, ${u.sex}, ${u.caste}, ${now.toISOString()})`);
    await sql`
      INSERT INTO determination_draft (specimen_id, determiner_id, animal_id, sex, caste, updated_at)
      VALUES ${sql.join(values)}
      ON CONFLICT (specimen_id, determiner_id) DO UPDATE SET
        animal_id = excluded.animal_id, sex = excluded.sex, caste = excluded.caste, updated_at = excluded.updated_at`.execute(db);
  }
  if (removals.length > 0) {
    await sql`DELETE FROM determination_draft WHERE determiner_id = ${determinerId} AND specimen_id IN (${sql.join(removals)})`.execute(db);
  }
  return rowsById(db, personId, determinerId, ids);
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

/** The names rows already carry, so the page can show them before the full list loads. */
export async function rowTaxa(
  db: Kysely<Database>,
  rows: readonly EntryRow[],
): Promise<Record<number, { name: string; rank: string; castes: boolean }>> {
  const ids = [...new Set(rows.flatMap((r) => [r.prior?.animalId ?? null, r.draft?.animalId ?? null]).filter((id): id is number => id !== null))];
  if (ids.length === 0) return {};
  const found = await sql<{ id: number; name: string; rank: string; castes: boolean }>`
    SELECT a.entity_id AS id, a.scientific_name AS name, a.rank, c.has_castes AS castes
    FROM animal a JOIN animal_castes c ON c.animal_id = a.entity_id
    WHERE a.entity_id IN (${sql.join(ids)})`.execute(db);
  return Object.fromEntries(found.rows.map((r) => [r.id, { name: r.name, rank: r.rank, castes: r.castes }]));
}
