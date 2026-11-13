import { sql, type Kysely } from "kysely";
import { BEE_FAMILIES } from "../bee-families.js";
import type { Database, DeterminationQualifier } from "../model.js";

/**
 * What the "Your bees" page and the front page read about a person's
 * specimens (beeline-xegx, beeline-fiay): how far each year's bees are
 * identified, and the experts' identifications as they arrived, in batches.
 * "Yours" is any specimen whose sample the person collected, as a second
 * collector included (beeline-77j). The caller passes the effective person:
 * while acting for somebody, theirs.
 */

/** One collection year's bees, by how far each one's determination of record goes. */
export interface YearOfBees {
  season: number;
  collected: number;
  /** Determined to species or finer. */
  species: number;
  /** To genus or subgenus. */
  genus: number;
  /** To family or anything coarser. */
  coarser: number;
  /** Not determined at all. */
  none: number;
}

/** How an identification changed the name a specimen had from an expert before. */
export type ChangeKind = "first" | "confirmed" | "finer" | "coarser" | "corrected" | "certainty";

/** How many of a batch's identifications did one kind of thing. */
export interface BatchKind {
  kind: ChangeKind;
  /** For finer and coarser: the rank the name went from, and to. */
  from: string | null;
  to: string | null;
  count: number;
  /** How many replaced a name the person had given themselves. */
  own: number;
}

/** A specimen an identification named, for a link to its page. */
export interface BatchSpecimen {
  specimen_id: number;
  field_number: string | null;
  sample_number: string;
  specimen_number: number;
}

export interface BatchName {
  /** The specimens the name was given to that day, in field-number order. */
  specimens: BatchSpecimen[];
  scientific_name: string;
  rank: string;
  qualifier: DeterminationQualifier | null;
  previous: { scientific_name: string; rank: string; qualifier: DeterminationQualifier | null } | null;
  count: number;
}

/** The identifications of one day: what an expert did to the person's bees then. */
export interface Batch {
  /** When the first of the day's identifications was made; shown as its day in Pacific time. */
  identified_at: Date;
  /** True when the day is only the latest it could have been: an expert's sheet that stated no day. */
  on_or_before: boolean;
  /** How many of each collection year's bees, newest year first. */
  seasons: { season: number; count: number }[];
  kinds: BatchKind[];
  determiners: string[];
  names: BatchName[];
}

export interface Batches {
  batches: Batch[];
  /**
   * Specimens an expert has named that are in no batch, because no
   * identification of them has a date Beeline can use: most were named in the
   * old Beeline, which kept no dates. Null where it was not counted.
   */
  undated: number | null;
}

/**
 * Up to this many specimens, the ones the feed could show are passed to
 * expert_identification as a list of ids rather than as a subquery. DuckDB
 * pushes a list of constants into the view, below its window functions, and
 * computes only those specimens' histories: 11 ms for a collector with the
 * median 81 specimens on production's store of 2026-11-11, against 92 ms for
 * the subquery, which computes every specimen's. Past a few thousand the list
 * itself costs more than the subquery (420 ms for 40,326 against 86 ms).
 */
const IDS_INLINE_LIMIT = 2_000;

/** The calendar day an instant fell on in Oregon, as the page shows it. */
const PACIFIC_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });

const mine = (personId: number) =>
  sql<boolean>`EXISTS (SELECT 1 FROM sample_collector mine WHERE mine.sample_id = sp.sample_id AND mine.person_id = ${personId})`;

/**
 * The specimens a person's pages count as bees: everything they collected
 * except what is identified to a family that is not a bee's (src/bee-families.ts),
 * so a wasp caught as bycatch is not a bee "to species". On production's store
 * of 2026-11-11, 990 of 227,115 determinations of record were not bees. A
 * specimen with no family yet stays in: it may be a bee.
 */
const BEES = (personId: number) => sql`
  mine_records AS (
    SELECT sp.entity_id AS specimen_id, sp.sample_id, d.entity_id AS determination_id, d.animal_id, d.qualifier
    FROM specimen sp LEFT JOIN determination_of_record d ON d.specimen_id = sp.entity_id
    WHERE ${mine(personId)}
  ),
  up(start, node) AS (
    SELECT DISTINCT animal_id, animal_id FROM mine_records WHERE animal_id IS NOT NULL
    UNION
    SELECT up.start, a.parent_id FROM up JOIN animal a ON a.entity_id = up.node WHERE a.parent_id IS NOT NULL
  ),
  not_bee AS (
    SELECT DISTINCT up.start AS animal_id FROM up JOIN animal a ON a.entity_id = up.node
    WHERE a.rank = 'family' AND a.scientific_name NOT IN (${sql.join(BEE_FAMILIES)})
  ),
  bees AS (
    SELECT * FROM mine_records WHERE animal_id IS NULL OR animal_id NOT IN (SELECT animal_id FROM not_bee)
  )`;

/** The person's bees by the year they were collected, oldest first. */
export async function beesByYear(db: Kysely<Database>, personId: number): Promise<YearOfBees[]> {
  const result = await sql<{ season: unknown; collected: unknown; species: unknown; genus: unknown; coarser: unknown; none: unknown }>`
    WITH RECURSIVE ${BEES(personId)},
    ranks AS (
      SELECT max(CASE WHEN rank = 'species' THEN ordinal END) AS species,
             max(CASE WHEN rank = 'genus' THEN ordinal END) AS genus
      FROM animal_rank
    )
    SELECT ss.season,
           count(*) AS collected,
           sum(CASE WHEN r.ordinal >= ranks.species THEN 1 ELSE 0 END) AS species,
           sum(CASE WHEN r.ordinal >= ranks.genus AND r.ordinal < ranks.species THEN 1 ELSE 0 END) AS genus,
           sum(CASE WHEN r.ordinal < ranks.genus THEN 1 ELSE 0 END) AS coarser,
           sum(CASE WHEN b.determination_id IS NULL THEN 1 ELSE 0 END) AS none
    FROM bees b
    CROSS JOIN ranks
    JOIN sample_season ss ON ss.sample_id = b.sample_id
    LEFT JOIN animal a ON a.entity_id = b.animal_id
    LEFT JOIN animal_rank r ON r.rank = a.rank
    GROUP BY ss.season
    ORDER BY ss.season`.execute(db);
  return result.rows.map((r) => ({
    season: Number(r.season),
    collected: Number(r.collected),
    species: Number(r.species),
    genus: Number(r.genus),
    coarser: Number(r.coarser),
    none: Number(r.none),
  }));
}

/**
 * The experts' identifications of the person's bees, grouped by the day they
 * were made, newest first (schema/111). A day is a batch because experts
 * work in batches, by morphospecies, across several seasons at once. Each
 * identification is classified by what it did to the name an expert gave
 * the bee before — the first name, a finer one, a coarser one, a correction —
 * since a bare "changed" says nothing, and 89% of the store's changes take
 * a bee from genus to species. Identifications only the old Beeline holds
 * carry no date and are counted, not placed.
 */
export async function identificationBatches(
  db: Kysely<Database>,
  personId: number,
  {
    maxBatches = Number.POSITIVE_INFINITY,
    countUndated = true,
    inlineLimit = IDS_INLINE_LIMIT,
  }: {
    /** Only the newest this many days. */
    maxBatches?: number;
    /**
     * Whether to count the bees an expert named with no date to show. It reads
     * every one of the person's expert-named specimens rather than only the
     * datable, which for production's busiest account costs 135 ms against
     * 14 ms for a typical volunteer, so the front page does without it.
     */
    countUndated?: boolean;
    /** Only for tests, which cannot make a person with thousands of specimens cheaply. */
    inlineLimit?: number;
  } = {},
): Promise<Batches> {
  // Which specimens to read. Without the undated count, only those the feed
  // could show: with an expert determination the view could date. Every
  // determination not the old Beeline's carries a time, and one of the old
  // Beeline's only if it states a day (a year is not enough: schema/111 dates
  // a stated day and nothing coarser). That keeps the list short: production's
  // most prolific collector has 40,326 specimens and 746 qualify, which takes
  // the query from 86 ms to 23 ms. With the count, every expert-named one, so
  // the count is of the same stretches the batches are made of.
  const specimens = db
    .selectFrom("determination as d")
    .innerJoin("specimen as sp", "sp.entity_id", "d.specimen_id")
    .where(mine(personId))
    .where("d.is_expert", "=", true)
    .$if(!countUndated, (q) =>
      q.where((eb) =>
        eb.or([eb("d.channel", "<>", "legacy_import"), eb.and([eb("d.determined_on", "is not", null), eb("d.determined_on_precision", "is", null)])]),
      ),
    )
    .select("d.specimen_id")
    .distinct();
  const ids = (await specimens.execute()).map((r) => Number(r.specimen_id));
  if (ids.length === 0) return { batches: [], undated: countUndated ? 0 : null };
  // The person's name as written, for determinations that name them but were
  // not tied to their record, such as an Ecdysis determiner no alias matched.
  const me = (await db.selectFrom("person").where("entity_id", "=", personId).select("display_name").executeTakeFirst())?.display_name ?? null;
  const isMe = (id: unknown, name: string | null) =>
    id !== null ? Number(id) === personId : me !== null && name !== null && name.trim().toLowerCase() === me.trim().toLowerCase();

  const rows = await db
    .selectFrom("expert_identification as ei")
    .innerJoin("specimen as sp", "sp.entity_id", "ei.specimen_id")
    .innerJoin("sample_season as ss", "ss.sample_id", "sp.sample_id")
    .innerJoin("sample as s", "s.entity_id", "sp.sample_id")
    .innerJoin("animal as a", "a.entity_id", "ei.animal_id")
    .leftJoin("animal as was", "was.entity_id", "ei.previous_animal_id")
    .leftJoin("person as det", "det.entity_id", "ei.determiner_id")
    .where("ei.specimen_id", "in", ids.length <= inlineLimit ? ids : specimens)
    .select([
      "ei.specimen_id",
      "sp.field_number",
      "sp.specimen_number",
      "s.sample_number",
      "ss.season",
      "ei.animal_id",
      "a.scientific_name",
      "a.rank",
      "ei.qualifier",
      "ei.previous_animal_id",
      "was.scientific_name as previous_name",
      "was.rank as previous_rank",
      "ei.previous_qualifier",
      "ei.previous_determiner_id",
      "ei.previous_determiner_name",
      "ei.determiner_id",
      "ei.determiner_name",
      sql<string | null>`coalesce(det.display_name, ei.determiner_name)`.as("determiner"),
      "ei.identified_at",
      "ei.identified_at_is_bound",
      "ei.is_latest",
    ])
    .orderBy("ei.identified_at", "desc")
    .orderBy("ei.specimen_id")
    .execute();

  const [ancestors, nonBeeFamilies] = await Promise.all([
    ancestorsOf(db, rows.flatMap((r) => (r.previous_animal_id === null ? [Number(r.animal_id)] : [Number(r.animal_id), Number(r.previous_animal_id)]))),
    db
      .selectFrom("animal")
      .where("rank", "=", "family")
      .where("scientific_name", "not in", [...BEE_FAMILIES])
      .select("entity_id")
      .execute()
      .then((found) => new Set(found.map((f) => Number(f.entity_id)))),
  ]);
  // A wasp caught as bycatch is not a bee identified, as on the chart: a
  // specimen whose current expert name is not a bee's has no bee batches, even
  // for the bee name it once had.
  const isBee = (animalId: number) => !nonBeeFamilies.has(animalId) && ![...(ancestors.get(animalId) ?? [])].some((a) => nonBeeFamilies.has(a));
  const notBeeNow = new Set(rows.filter((r) => r.is_latest && !isBee(Number(r.animal_id))).map((r) => Number(r.specimen_id)));
  // A season's count is of bees, not identifications: an expert who renames one
  // bee twice in a day has identified one bee, as the chart by year counts it.
  const byDay = new Map<string, { batch: Batch; kinds: Map<string, BatchKind>; names: Map<string, BatchName>; seasons: Map<number, Set<number>>; determiners: Set<string> }>();
  // The person's own names are not news to them: Washington's staff upload
  // volunteers' identifications to Ecdysis, where they read as experts'.
  // A stretch that could be news: an expert's that is not the person's own,
  // of a bee, on a specimen that is a bee now. Dated, it is in a batch;
  // undated, its specimen is counted, so a bee is in one or the other.
  const eligible = rows.filter((r) => !isMe(r.determiner_id, r.determiner_name) && isBee(Number(r.animal_id)) && !notBeeNow.has(Number(r.specimen_id)));
  const theirs = eligible.filter((r) => r.identified_at !== null);
  for (const r of theirs) {
    const at = r.identified_at as Date;
    // An exact day and an "on or before" one are separate entries even on the
    // same date, so neither borrows the other's certainty.
    const key = `${PACIFIC_DAY.format(at)}:${r.identified_at_is_bound}`;
    let day = byDay.get(key);
    if (day === undefined) {
      if (byDay.size >= maxBatches) continue;
      day = {
        batch: { identified_at: at, on_or_before: false, seasons: [], kinds: [], determiners: [], names: [] },
        kinds: new Map(),
        names: new Map(),
        seasons: new Map(),
        determiners: new Set(),
      };
      byDay.set(key, day);
    }
    if (at < day.batch.identified_at) day.batch.identified_at = at;
    day.batch.on_or_before = r.identified_at_is_bound;
    const season = day.seasons.get(Number(r.season)) ?? new Set<number>();
    season.add(Number(r.specimen_id));
    day.seasons.set(Number(r.season), season);
    if (r.determiner !== null) day.determiners.add(r.determiner);

    const kind = classify(Number(r.animal_id), r.qualifier, r.previous_animal_id === null ? null : Number(r.previous_animal_id), r.previous_qualifier, ancestors);
    const ranks = kind === "finer" || kind === "coarser" ? { from: r.previous_rank, to: r.rank } : { from: null, to: null };
    const kindKey = `${kind}:${ranks.from}:${ranks.to}`;
    const k = day.kinds.get(kindKey) ?? { kind, ...ranks, count: 0, own: 0 };
    k.count++;
    if (r.previous_animal_id !== null && isMe(r.previous_determiner_id, r.previous_determiner_name)) k.own++;
    day.kinds.set(kindKey, k);

    const previous =
      r.previous_name === null || r.previous_rank === null
        ? null
        : { scientific_name: r.previous_name, rank: r.previous_rank, qualifier: r.previous_qualifier };
    const nameKey = `${r.previous_animal_id}:${r.previous_qualifier}>${r.animal_id}:${r.qualifier}`;
    const n = day.names.get(nameKey) ?? { specimens: [], scientific_name: r.scientific_name, rank: r.rank, qualifier: r.qualifier, previous, count: 0 };
    n.count++;
    n.specimens.push({ specimen_id: Number(r.specimen_id), field_number: r.field_number, sample_number: r.sample_number, specimen_number: Number(r.specimen_number) });
    day.names.set(nameKey, n);
  }
  const batches = [...byDay.values()].map(({ batch, kinds, names, seasons, determiners }) => ({
    ...batch,
    seasons: [...seasons].map(([season, bees]) => ({ season, count: bees.size })).sort((a, b) => b.season - a.season),
    kinds: [...kinds.values()].sort((a, b) => b.count - a.count),
    determiners: [...determiners],
    names: [...names.values()]
      .map((n) => ({ ...n, specimens: n.specimens.sort((a, b) => String(a.field_number).localeCompare(String(b.field_number))) }))
      .sort((a, b) => b.count - a.count || a.scientific_name.localeCompare(b.scientific_name)),
  }));
  const shown = new Set(theirs.map((r) => Number(r.specimen_id)));
  const undated = countUndated ? new Set(eligible.map((r) => Number(r.specimen_id)).filter((id) => !shown.has(id))).size : null;
  return { batches, undated };
}

/** What an identification did to the name before it. */
export function classify(
  animalId: number,
  qualifier: DeterminationQualifier | null,
  previousId: number | null,
  previousQualifier: DeterminationQualifier | null,
  ancestors: ReadonlyMap<number, ReadonlySet<number>>,
): ChangeKind {
  if (previousId === null) return "first";
  // The same name from somebody else: the view starts a stretch there only
  // when the person giving it changes.
  if (previousId === animalId) return qualifier === previousQualifier ? "confirmed" : "certainty";
  if (ancestors.get(animalId)?.has(previousId)) return "finer";
  if (ancestors.get(previousId)?.has(animalId)) return "coarser";
  return "corrected";
}

/** Each name's ancestors in the tree, for the names asked about. */
async function ancestorsOf(db: Kysely<Database>, ids: number[]): Promise<Map<number, Set<number>>> {
  const map = new Map<number, Set<number>>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return map;
  const result = await sql<{ start: unknown; ancestor: unknown }>`
    WITH RECURSIVE up(start, ancestor) AS (
      SELECT entity_id, parent_id FROM animal WHERE entity_id IN (${sql.join(unique)}) AND parent_id IS NOT NULL
      UNION
      SELECT up.start, a.parent_id FROM up JOIN animal a ON a.entity_id = up.ancestor WHERE a.parent_id IS NOT NULL
    )
    SELECT start, ancestor FROM up`.execute(db);
  for (const r of result.rows) {
    const start = Number(r.start);
    const set = map.get(start) ?? new Set<number>();
    set.add(Number(r.ancestor));
    map.set(start, set);
  }
  return map;
}

/** One species-level name among the person's bees, as its determination of record gives it. */
export interface SpeciesFound {
  scientific_name: string;
  rank: string;
  qualifier: DeterminationQualifier | null;
  bees: number;
}

/** A species others in the person's atlas have found and the person has not. */
export interface SpeciesByOthers {
  scientific_name: string;
  /** How many of others' specimens are identified as it. */
  bees: number;
}

export interface GenusFound {
  /** Null for bees whose family is known and whose genus is not. */
  name: string | null;
  /** The person's own; 0 for a genus only others have found. */
  bees: number;
  /** Bees identified to this genus (or a subgenus of it) and no further. */
  toGenusOnly: number;
  species: SpeciesFound[];
  /** Species of this genus others in the person's atlas have found and the person has not, most collected first. */
  byOthers: SpeciesByOthers[];
}

export interface FamilyFound {
  /** Null for bees identified to something no family is above, such as an order. */
  name: string | null;
  bees: number;
  genera: GenusFound[];
}

/** What the person's identified bees are, by family and genus (beeline-fiay). */
export interface TaxaFound {
  /**
   * The atlases the person's samples were collected in, and how many
   * families, genera and species have been found there by anybody, the person
   * included. Null when none of their samples is in an atlas.
   */
  atlas: {
    names: string[];
    families: number;
    genera: number;
    species: number;
    /** How many of those the person found there, from their own specimens collected in those atlases. */
    yours: { families: number; genera: number; species: number };
  } | null;
  /** The person's specimens, less those identified as something other than a bee. */
  collected: number;
  identified: number;
  /** Specimens identified to a family that is not a bee's, left out of everything else. */
  notBees: number;
  families: number;
  genera: number;
  species: number;
  byFamily: FamilyFound[];
}

/**
 * Which taxa the person's bees are, as far as each is identified: every
 * determination of record rolled up through the name tree to its genus and
 * family. Volunteers' own determinations count, as on the chart by year, and
 * specimens identified as something other than a bee are counted apart. A
 * species is counted once whether or not it is "cf.", which asserts the
 * species pending confirmation; "aff." and "nr." say it is probably something
 * else (schema/040), so they add no species found. The list shows them all.
 *
 * Beside them, what others have found in the atlases the person collects in
 * (beeline-fiay, Peter 2026-11-12): every species there the person has not
 * found, under its genus and family, with how many specimens others have of
 * it, so a volunteer can see what is still out there. 26 ms for the busiest
 * account on production's store of 2026-11-12, whose samples span three atlases.
 */
export async function taxaFound(db: Kysely<Database>, personId: number): Promise<TaxaFound> {
  const atlases = await sql<{ atlas_id: unknown; name: string }>`
    SELECT DISTINCT p.entity_id AS atlas_id, p.name
    FROM sample_atlas sa JOIN program p ON p.entity_id = sa.atlas_id
    WHERE EXISTS (SELECT 1 FROM sample_collector mine WHERE mine.sample_id = sa.sample_id AND mine.person_id = ${personId})
    ORDER BY p.name`.execute(db);
  const atlasIds = atlases.rows.map((a) => Number(a.atlas_id));
  const [names, totals, others] = await Promise.all([
    // in_atlas: whether the specimen was collected in one of those atlases,
    // so the comparison counts only what was found there.
    sql<{ animal_id: unknown; qualifier: DeterminationQualifier | null; in_atlas: boolean; bees: unknown }>`
      SELECT d.animal_id, d.qualifier,
             ${
               atlasIds.length === 0
                 ? sql`FALSE`
                 : sql`EXISTS (SELECT 1 FROM sample_atlas sa WHERE sa.sample_id = sp.sample_id AND sa.atlas_id IN (${sql.join(atlasIds)}))`
             } AS in_atlas,
             count(*) AS bees
      FROM specimen sp JOIN determination_of_record d ON d.specimen_id = sp.entity_id
      WHERE ${mine(personId)}
      GROUP BY 1, 2, 3`.execute(db),
    sql<{ collected: unknown }>`SELECT count(*) AS collected FROM specimen sp WHERE ${mine(personId)}`.execute(db),
    // Others' specimens in those atlases, by their names. "aff." and "nr."
    // still place a bee in its family and genus; only the species is withheld.
    atlasIds.length === 0
      ? Promise.resolve({ rows: [] as { animal_id: unknown; qualifier: DeterminationQualifier | null; bees: unknown }[] })
      : sql<{ animal_id: unknown; qualifier: DeterminationQualifier | null; bees: unknown }>`
          SELECT d.animal_id, d.qualifier, count(*) AS bees
          FROM specimen sp
          JOIN sample_atlas sa ON sa.sample_id = sp.sample_id
          JOIN determination_of_record d ON d.specimen_id = sp.entity_id
          WHERE sa.atlas_id IN (${sql.join(atlasIds)}) AND NOT ${mine(personId)}
          GROUP BY 1, 2`.execute(db),
  ]);
  const ids = [...new Set([...names.rows, ...others.rows].map((r) => Number(r.animal_id)))];
  const lineage = await lineageOf(db, ids);

  const families = new Map<string, { name: string | null; genera: Map<string, GenusFound> }>();
  const speciesSeen = new Set<number>();
  let identified = 0;
  let notBees = 0;
  for (const r of names.rows) {
    const bees = Number(r.bees);
    const line = lineage.get(Number(r.animal_id));
    const family = line?.family ?? null;
    if (family !== null && !BEE_FAMILIES.includes(family)) {
      notBees += bees;
      continue;
    }
    identified += bees;
    const genus = line?.genus ?? null;
    const fam = families.get(String(family)) ?? { name: family, genera: new Map() };
    families.set(String(family), fam);
    const gen = fam.genera.get(String(genus)) ?? { name: genus, bees: 0, toGenusOnly: 0, species: [], byOthers: [] };
    fam.genera.set(String(genus), gen);
    gen.bees += bees;
    if (line?.species !== undefined && line.species !== null && line.self !== null) {
      if (r.qualifier !== "aff." && r.qualifier !== "nr.") speciesSeen.add(line.species);
      // One entry per name and qualifier, though the rows come apart by
      // whether the specimen was collected in the atlas.
      const same = gen.species.find((x: SpeciesFound) => x.scientific_name === line.self!.scientific_name && x.qualifier === r.qualifier);
      if (same !== undefined) same.bees += bees;
      else gen.species.push({ scientific_name: line.self.scientific_name, rank: line.self.rank, qualifier: r.qualifier, bees });
    } else if (genus !== null && line?.atOrBelowGenus) {
      gen.toGenusOnly += bees;
    }
  }
  // What others have found that the person has not. Only names placed in a
  // bee family and genus count: a genus or family others have found joins the
  // page with none of the person's bees, and a species of it is listed.
  /** The families, genera and species a set of names covers, as the summary counts them. */
  const cover = () => ({ families: new Set<string>(), genera: new Set<string>(), species: new Set<number>() });
  const add = (into: ReturnType<typeof cover>, animalId: number, qualifier: DeterminationQualifier | null) => {
    const line = lineage.get(animalId);
    const family = line?.family ?? null;
    if (family === null || !BEE_FAMILIES.includes(family)) return null;
    into.families.add(family);
    const genus = line?.genus ?? null;
    if (genus === null) return null;
    into.genera.add(`${family}/${genus}`);
    if (line?.species === null || line?.species === undefined || line.speciesName === null) return null;
    if (qualifier === "aff." || qualifier === "nr.") return null;
    into.species.add(line.species);
    return { family, genus, species: line.species, name: line.speciesName };
  };
  // Found in the atlases by anybody, and by the person there: only specimens
  // collected in those atlases, so what the person found elsewhere never
  // counts toward what the atlas has.
  const inAtlas = cover();
  const yoursThere = cover();
  for (const r of names.rows) {
    if (!r.in_atlas) continue;
    add(inAtlas, Number(r.animal_id), r.qualifier);
    add(yoursThere, Number(r.animal_id), r.qualifier);
  }
  const othersFamilies = new Set<string>();
  const othersGenera = new Set<string>();
  const othersBySpecies = new Map<number, { family: string; genus: string; name: string; bees: number }>();
  for (const r of others.rows) {
    const placed = add(inAtlas, Number(r.animal_id), r.qualifier);
    const line = lineage.get(Number(r.animal_id));
    if (line?.family != null && BEE_FAMILIES.includes(line.family)) {
      othersFamilies.add(line.family);
      if (line.genus !== null) othersGenera.add(`${line.family}/${line.genus}`);
    }
    if (placed === null || speciesSeen.has(placed.species)) continue;
    const o = othersBySpecies.get(placed.species) ?? { family: placed.family, genus: placed.genus, name: placed.name, bees: 0 };
    o.bees += Number(r.bees);
    othersBySpecies.set(placed.species, o);
  }
  // A family others found, even one they named no genus in, is a row too.
  for (const family of othersFamilies) if (!families.has(family)) families.set(family, { name: family, genera: new Map() });
  for (const key of othersGenera) {
    const [family, genus] = key.split("/") as [string, string];
    const fam = families.get(family) ?? { name: family, genera: new Map() };
    families.set(family, fam);
    if (!fam.genera.has(genus)) fam.genera.set(genus, { name: genus, bees: 0, toGenusOnly: 0, species: [], byOthers: [] });
  }
  for (const o of othersBySpecies.values()) families.get(o.family)!.genera.get(o.genus)!.byOthers.push({ scientific_name: o.name, bees: o.bees });

  const othersBees = (g: GenusFound) => g.byOthers.reduce((s, o) => s + o.bees, 0);
  const byFamily: FamilyFound[] = [...families.values()]
    .map((f) => {
      const genera = [...f.genera.values()]
        .map((g) => ({
          ...g,
          species: g.species.sort((a, b) => b.bees - a.bees || a.scientific_name.localeCompare(b.scientific_name)),
          byOthers: g.byOthers.sort((a, b) => b.bees - a.bees || a.scientific_name.localeCompare(b.scientific_name)),
        }))
        .sort((a, b) => b.bees - a.bees || othersBees(b) - othersBees(a) || String(a.name).localeCompare(String(b.name)));
      return { name: f.name, bees: genera.reduce((s, g) => s + g.bees, 0), genera };
    })
    // Named families first, the person's largest first, then those only
    // others have found; whatever has no family last.
    .sort((a, b) => (a.name === null ? 1 : 0) - (b.name === null ? 1 : 0) || b.bees - a.bees || String(a.name).localeCompare(String(b.name)));
  const ownGenera = new Set(byFamily.flatMap((f) => f.genera.flatMap((g) => (g.name === null || g.bees === 0 ? [] : [`${f.name}/${g.name}`]))));
  const ownFamilies = byFamily.filter((f) => f.name !== null && f.bees > 0).map((f) => String(f.name));
  return {
    atlas:
      atlasIds.length === 0
        ? null
        : {
            names: atlases.rows.map((a) => a.name),
            families: inAtlas.families.size,
            genera: inAtlas.genera.size,
            species: inAtlas.species.size,
            yours: { families: yoursThere.families.size, genera: yoursThere.genera.size, species: yoursThere.species.size },
          },
    collected: Number(totals.rows[0]?.collected ?? 0) - notBees,
    identified,
    notBees,
    families: ownFamilies.length,
    genera: ownGenera.size,
    species: speciesSeen.size,
    byFamily,
  };
}

interface Lineage {
  self: { scientific_name: string; rank: string } | null;
  family: string | null;
  genus: string | null;
  /** The species-rank node at or above this name, for counting species once whatever is finer. */
  species: number | null;
  speciesName: string | null;
  /** Whether the name is a genus or anything finer, so "to genus only" can tell a genus from a family. */
  atOrBelowGenus: boolean;
}

/** Each name's family, genus and species, read up the tree. */
async function lineageOf(db: Kysely<Database>, ids: number[]): Promise<Map<number, Lineage>> {
  const map = new Map<number, Lineage>();
  if (ids.length === 0) return map;
  const result = await sql<{ start: unknown; node: unknown; rank: string; scientific_name: string; ordinal: unknown; genus_ordinal: unknown; depth: unknown }>`
    WITH RECURSIVE up(start, node, depth) AS (
      SELECT entity_id, entity_id, 0 FROM animal WHERE entity_id IN (${sql.join(ids)})
      UNION ALL
      SELECT up.start, a.parent_id, up.depth + 1 FROM up JOIN animal a ON a.entity_id = up.node
      WHERE a.parent_id IS NOT NULL AND up.depth < 32
    )
    SELECT up.start, up.node, a.rank, a.scientific_name, r.ordinal,
           (SELECT ordinal FROM animal_rank WHERE rank = 'genus') AS genus_ordinal, up.depth
    FROM up JOIN animal a ON a.entity_id = up.node LEFT JOIN animal_rank r ON r.rank = a.rank`.execute(db);
  for (const r of result.rows) {
    const start = Number(r.start);
    const line = map.get(start) ?? { self: null, family: null, genus: null, species: null, speciesName: null, atOrBelowGenus: false };
    if (Number(r.depth) === 0) {
      line.self = { scientific_name: r.scientific_name, rank: r.rank };
      line.atOrBelowGenus = r.ordinal !== null && Number(r.ordinal) >= Number(r.genus_ordinal);
    }
    if (r.rank === "family") line.family = r.scientific_name;
    if (r.rank === "genus") line.genus = r.scientific_name;
    if (r.rank === "species") {
      line.species = Number(r.node);
      line.speciesName = r.scientific_name;
    }
    map.set(start, line);
  }
  return map;
}

/** One place and host plant the person collected a taxon at (beeline-nstp). */
export interface CollectedGroup {
  locality: string | null;
  county: string | null;
  state_province: string | null;
  /** The floral host as observed; null for a bee taken off no flower, or none recorded. */
  host_name: string | null;
  host_rank: string | null;
  /** Collection years, newest first. */
  seasons: number[];
  specimens: number;
  /** The first and last collecting days, as ISO dates: the window the listing link is narrowed to. */
  from: string;
  to: string;
}

export interface Collected {
  total: number;
  /** The most specimens first. */
  groups: CollectedGroup[];
}

/**
 * The person's own specimens of a taxon or anything filed below it, by the
 * determination of record as the taxon page counts them, grouped by where
 * they were collected and off which plant (beeline-nstp). Only the person's
 * own samples are read, so nothing iNaturalist withholds from others is
 * shown to anyone but a collector of it.
 */
export async function collectedOf(db: Kysely<Database>, personId: number, animalId: number): Promise<Collected> {
  // The depth guard is the taxon page's own: the tree is not constrained against a cycle.
  const { rows } = await sql<{
    locality: string | null;
    county: string | null;
    state_province: string | null;
    host_name: string | null;
    host_rank: string | null;
    season: unknown;
    date_start: Date;
    date_end: Date;
  }>`
    WITH RECURSIVE below(entity_id, depth) AS (
      SELECT ${animalId}, 0
      UNION ALL
      SELECT a.entity_id, below.depth + 1 FROM animal a JOIN below ON a.parent_id = below.entity_id WHERE below.depth < 32
    )
    SELECT s.locality, s.county, s.state_province, s.host_name_as_observed AS host_name, s.host_rank, ss.season,
           s.date_start, s.date_end
    FROM specimen sp
    JOIN sample s ON s.entity_id = sp.sample_id
    JOIN sample_season ss ON ss.sample_id = sp.sample_id
    JOIN determination_of_record d ON d.specimen_id = sp.entity_id
    WHERE d.animal_id IN (SELECT entity_id FROM below) AND ${mine(personId)}
  `.execute(db);
  const groups = new Map<string, CollectedGroup>();
  const isoDay = (d: Date) => new Date(d).toISOString().slice(0, 10);
  for (const r of rows) {
    const key = JSON.stringify([r.locality, r.county, r.state_province, r.host_name, r.host_rank]);
    const from = isoDay(r.date_start);
    const to = isoDay(r.date_end);
    let g = groups.get(key);
    if (g === undefined) {
      g = { locality: r.locality, county: r.county, state_province: r.state_province, host_name: r.host_name, host_rank: r.host_rank, seasons: [], specimens: 0, from, to };
      groups.set(key, g);
    }
    const season = Number(r.season);
    if (!g.seasons.includes(season)) g.seasons.push(season);
    g.specimens++;
    if (from < g.from) g.from = from;
    if (to > g.to) g.to = to;
  }
  const place = (g: CollectedGroup) => [g.locality, g.county, g.state_province, g.host_name].map((s) => s ?? "").join("\t");
  return {
    total: rows.length,
    groups: [...groups.values()]
      .map((g) => ({ ...g, seasons: g.seasons.sort((a, b) => b - a) }))
      .sort((a, b) => b.specimens - a.specimens || place(a).localeCompare(place(b))),
  };
}
