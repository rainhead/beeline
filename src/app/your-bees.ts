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
