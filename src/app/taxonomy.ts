import { sql, type Kysely } from "kysely";
import type { AnimalEcdysisStanding, Database, CurationKind } from "../model.js";
import { ALL, toCsv } from "./listings.js";

/**
 * The curated taxonomy, as a page anyone signed in can read (beeline-45v.5).
 *
 * `animal` is the tree every determination points into, and animal_ecdysis
 * (schema/118) says how each node stands against Ecdysis's thesaurus
 * (beeline-7gob; ITIS until 2026-10-23). Two screens read them:
 * one node — where it is filed, how it stands, what is filed below it — and a
 * flat list of the nodes matching a name or a standing, which is the worklist
 * the curation layer (beeline-45v.1) grows into.
 *
 * A node is addressed by rank and name, never by entity_id: that is a
 * per-store sequence draw a rebuild redraws, and (rank, scientific_name) is
 * the table's own unique key. The name alone is not a key — the dev store
 * holds Lasioglossum (Lasioglossum) as both a subgenus and a species.
 */

export const PAGE_SIZE = 50;

/** The standings a list can be narrowed to. `not loaded` is a state of the store, not something to filter on. */
export const STANDING_FILTERS = ["any", "accepted", "synonym", "homonym", "absent"] as const;
export type StandingFilter = (typeof STANDING_FILTERS)[number];

/**
 * The taxonomists' decisions a list can be narrowed to (beeline-45v.1):
 * every name somebody has decided about, or only those the thesaurus now
 * loaded has moved from under — which is the curation worklist.
 */
export const DECIDED_FILTERS = ["any", "decided", "moved"] as const;
export type DecidedFilter = (typeof DECIDED_FILTERS)[number];

export interface TaxonomyQuery {
  /** Part of a scientific name, any case. */
  search: string;
  standing: StandingFilter;
  decided: DecidedFilter;
  page: number;
}

export function parseTaxonomyQuery(params: URLSearchParams): TaxonomyQuery {
  const page = Number(params.get("page") ?? "1");
  const standing = params.get("standing") ?? "any";
  const decided = params.get("decided") ?? "any";
  return {
    search: (params.get("q") ?? "").trim(),
    standing: (STANDING_FILTERS as readonly string[]).includes(standing) ? (standing as StandingFilter) : "any",
    decided: (DECIDED_FILTERS as readonly string[]).includes(decided) ? (decided as DecidedFilter) : "any",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** Whether the index answers with a list rather than with the top of the tree. */
export const isFiltering = (query: TaxonomyQuery): boolean =>
  query.search !== "" || query.standing !== "any" || query.decided !== "any";

export function taxonomyHref(query: TaxonomyQuery, overrides: Partial<TaxonomyQuery> = {}): string {
  const q = { ...query, ...overrides };
  const params = new URLSearchParams();
  if (q.search !== "") params.set("q", q.search);
  if (q.standing !== "any") params.set("standing", q.standing);
  if (q.decided !== "any") params.set("decided", q.decided);
  if (q.page > 1) params.set("page", String(q.page));
  const s = params.toString();
  return s === "" ? "/taxonomy" : `/taxonomy?${s}`;
}

export interface TaxonRef {
  rank: string;
  scientific_name: string;
}

/** One node's page. */
export const taxonHref = (taxon: TaxonRef): string =>
  `/taxonomy/${encodeURIComponent(taxon.rank)}/${encodeURIComponent(taxon.scientific_name)}`;

/**
 * The specimens under a node, on the specimen listing. It names every
 * record, as the count beside it does: left to itself the listing falls back
 * to the scope its reader last chose, so a link from a count of everyone's
 * specimens could land on "my records" and show a different number.
 */
export const taxonSpecimensHref = (taxon: TaxonRef): string =>
  `/specimens?${new URLSearchParams({ taxon: taxon.scientific_name, scope: ALL }).toString()}`;

/** Ecdysis's own page for a taxon id. */
export const ecdysisTaxonHref = (tid: bigint | number): string => `https://ecdysis.org/taxa/index.php?taxon=${String(tid)}`;

/** The accepted Ecdysis name a synonym is filed under. */
export interface AcceptedName extends TaxonRef {
  /** Whether the tree holds it too, so the page can link to it. */
  held: boolean;
}

export interface TaxonRow extends TaxonRef {
  entity_id: number;
  authorship: string | null;
  ecdysis_tid: bigint | null;
  standing: AnimalEcdysisStanding;
  /** The name Ecdysis files a synonym under; null unless the standing is `synonym`. */
  accepted: AcceptedName | null;
  /** Specimens whose determination of record is this node or anything filed below it. */
  specimens: number;
  /** Where it is filed; null at a root. */
  parent: TaxonRef | null;
  /** A taxonomist's decision about this name against Ecdysis, where there is one (animal_curation). */
  decision: { kind: CurationKind; taxonomist: string } | null;
}

/** The whole of a decision, for the name's own page. */
export interface TaxonDecision {
  kind: CurationKind;
  taxonomist: string;
  decided_on: Date;
  ecdysis_fetched_on: Date;
  reason: string;
  reference: string | null;
  /** For a homonym resolution, the author of the name chosen, which is what tells the two apart. */
  author: string | null;
}

export interface TaxonNode extends TaxonRow {
  /** Everything it is filed under, the root first. */
  lineage: TaxonRef[];
  /** Specimens determined to this node and no finer. */
  determinedHere: number;
  /** For a homonym: the accepted Ecdysis names that share its spelling, which nothing on the node can choose between. */
  homonyms: { tid: bigint; author: string | null }[];
  decision: TaxonDecision | null;
  /** How the thesaurus now loaded has moved from under the decision (animal_curation_stale), or null. */
  moved: string | null;
  children: TaxonRow[];
}

const rows = (db: Kysely<Database>) =>
  db
    .selectFrom("animal as a")
    .innerJoin("animal_ecdysis as i", "i.entity_id", "a.entity_id")
    .innerJoin("animal_rank as r", "r.rank", "a.rank")
    .leftJoin("animal as p", "p.entity_id", "a.parent_id")
    .leftJoin("animal_curation as c", "c.animal_id", "a.entity_id")
    .select([
      "a.entity_id",
      "a.rank",
      "a.scientific_name",
      "a.authorship",
      "a.ecdysis_tid",
      "i.standing",
      "p.rank as parent_rank",
      "p.scientific_name as parent_name",
      "c.kind as decision_kind",
      "c.taxonomist as decision_by",
    ]);

type BaseRow = Awaited<ReturnType<ReturnType<typeof rows>["execute"]>>[number];

/**
 * Specimens at or below each node, by determination of record. One closure
 * over the whole tree costs ~40 ms on the dev store, so it is computed per
 * request rather than kept.
 */
async function specimensUnder(db: Kysely<Database>, ids: readonly number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const result = await sql<{ entity_id: number; specimens: number | bigint }>`
    WITH RECURSIVE below(ancestor, descendant) AS (
      SELECT entity_id, entity_id FROM animal WHERE entity_id IN (${sql.join(ids)})
      UNION
      SELECT below.ancestor, a.entity_id FROM below JOIN animal a ON a.parent_id = below.descendant
    )
    SELECT below.ancestor AS entity_id, count(d.entity_id) AS specimens
    FROM below
    LEFT JOIN determination_of_record d ON d.animal_id = below.descendant
    GROUP BY below.ancestor
  `.execute(db);
  return new Map(result.rows.map((row) => [Number(row.entity_id), Number(row.specimens)]));
}

/** The accepted name each synonym's id is filed under, keyed by the id as a string. */
async function acceptedNames(db: Kysely<Database>, tids: readonly bigint[]): Promise<Map<string, AcceptedName>> {
  const byTid = new Map<string, AcceptedName>();
  if (tids.length === 0) return byTid;
  const result = await sql<{ tid: number | bigint; rank: string; name: string; held: boolean }>`
    SELECT t.tid, acc.rank, acc.name,
           EXISTS (SELECT 1 FROM animal a WHERE a.rank = acc.rank AND a.scientific_name = acc.name) AS held
    FROM ecdysis_taxon t
    JOIN ecdysis_taxon acc ON acc.tid = t.accepted_tid
    WHERE t.tid IN (${sql.join(tids.map(Number))}) AND t.status = 'synonym'
  `.execute(db);
  for (const row of result.rows) {
    byTid.set(String(row.tid), { rank: row.rank, scientific_name: row.name, held: Boolean(row.held) });
  }
  return byTid;
}

/** Base rows → rows with their counts and accepted names, in two queries however many rows there are. */
async function decorate(db: Kysely<Database>, base: readonly BaseRow[]): Promise<TaxonRow[]> {
  const counts = await specimensUnder(
    db,
    base.map((row) => row.entity_id),
  );
  const accepted = await acceptedNames(
    db,
    base.filter((row) => row.standing === "synonym" && row.ecdysis_tid !== null).map((row) => row.ecdysis_tid!),
  );
  return base.map((row) => ({
    entity_id: row.entity_id,
    rank: row.rank,
    scientific_name: row.scientific_name,
    authorship: row.authorship,
    ecdysis_tid: row.ecdysis_tid === null ? null : BigInt(row.ecdysis_tid),
    standing: row.standing,
    accepted: row.ecdysis_tid === null ? null : (accepted.get(String(row.ecdysis_tid)) ?? null),
    specimens: counts.get(row.entity_id) ?? 0,
    decision:
      row.decision_kind === null || row.decision_by === null ? null : { kind: row.decision_kind, taxonomist: row.decision_by },
    parent:
      row.parent_rank === null || row.parent_name === null
        ? null
        : { rank: row.parent_rank, scientific_name: row.parent_name },
  }));
}

/** The node with this rank and name, with everything its page shows; null when the tree has no such node. */
export async function loadTaxon(db: Kysely<Database>, rank: string, name: string): Promise<TaxonNode | null> {
  const found = await rows(db).where("a.rank", "=", rank).where("a.scientific_name", "=", name).executeTakeFirst();
  if (found === undefined) return null;
  const id = found.entity_id;

  const children = await rows(db)
    .where("a.parent_id", "=", id)
    .orderBy("r.ordinal")
    .orderBy("a.scientific_name")
    .execute();
  const [self, ...decorated] = await decorate(db, [found, ...children]);

  // Guarded by depth: the tree is not constrained against a cycle, and a
  // page that never returns is a worse answer than a truncated lineage.
  const lineage = await sql<TaxonRef & { depth: number }>`
    WITH RECURSIVE up(entity_id, parent_id, rank, scientific_name, depth) AS (
      SELECT entity_id, parent_id, rank, scientific_name, 0 FROM animal WHERE entity_id = ${id}
      UNION ALL
      SELECT a.entity_id, a.parent_id, a.rank, a.scientific_name, up.depth + 1
      FROM animal a JOIN up ON a.entity_id = up.parent_id
      WHERE up.depth < 32
    )
    SELECT rank, scientific_name, depth FROM up WHERE depth > 0 ORDER BY depth DESC
  `.execute(db);

  const here = await db
    .selectFrom("determination_of_record")
    .select((eb) => eb.fn.countAll<number | bigint>().as("n"))
    .where("animal_id", "=", id)
    .executeTakeFirst();

  const homonyms =
    found.standing === "homonym"
      ? await db
          .selectFrom("ecdysis_taxon")
          .select(["tid", "author"])
          .where("rank", "=", rank)
          .where("name", "=", name)
          .where("status", "=", "accepted")
          .orderBy("tid")
          .execute()
      : [];

  const curation = await db
    .selectFrom("animal_curation as c")
    .leftJoin("ecdysis_taxon as t", "t.tid", "c.ecdysis_tid")
    .select(["c.kind", "c.taxonomist", "c.decided_on", "c.ecdysis_fetched_on", "c.reason", "c.reference", "t.author"])
    .where("c.animal_id", "=", id)
    .executeTakeFirst();
  const moved =
    curation === undefined
      ? undefined
      : await db.selectFrom("animal_curation_stale").select("problem").where("animal_id", "=", id).executeTakeFirst();

  return {
    ...self!,
    lineage: lineage.rows.map(({ rank, scientific_name }) => ({ rank, scientific_name })),
    determinedHere: Number(here?.n ?? 0),
    homonyms: homonyms.map((h) => ({ tid: BigInt(h.tid), author: h.author })),
    decision:
      curation === undefined
        ? null
        : {
            kind: curation.kind,
            taxonomist: curation.taxonomist,
            decided_on: new Date(curation.decided_on),
            ecdysis_fetched_on: new Date(curation.ecdysis_fetched_on),
            reason: curation.reason,
            reference: curation.reference,
            author: curation.kind === "homonym" ? curation.author : null,
          },
    moved: moved?.problem ?? null,
    children: decorated,
  };
}

/**
 * Where browsing starts: the first node below the root with more than one
 * thing filed under it. The top of the tree is a chain — Animalia, Arthropoda,
 * Insecta — and three pages with one row each is not a way in. A tree with
 * several roots, or none, has no single place to start, so its roots are the
 * answer instead.
 */
export async function browseStart(db: Kysely<Database>): Promise<{ node: TaxonNode | null; roots: TaxonRow[] }> {
  const roots = await rows(db).where("a.parent_id", "is", null).orderBy("r.ordinal").orderBy("a.scientific_name").execute();
  if (roots.length !== 1) return { node: null, roots: await decorate(db, roots) };
  let current = roots[0]!;
  for (let depth = 0; depth < 32; depth++) {
    const below = await rows(db).where("a.parent_id", "=", current.entity_id).limit(2).execute();
    if (below.length !== 1) break;
    current = below[0]!;
  }
  return { node: await loadTaxon(db, current.rank, current.scientific_name), roots: [] };
}

export interface TaxonList {
  rows: TaxonRow[];
  total: number;
  page: number;
  pages: number;
}

/** The nodes matching a name and a standing, alphabetically. */
export async function searchTaxa(db: Kysely<Database>, query: TaxonomyQuery): Promise<TaxonList> {
  let matching = rows(db);
  if (query.search !== "") {
    // position() rather than LIKE, so a name is never read as a pattern.
    matching = matching.where(sql<boolean>`position(${query.search.toLowerCase()} IN lower(a.scientific_name)) > 0`);
  }
  if (query.standing !== "any") matching = matching.where("i.standing", "=", query.standing);
  if (query.decided === "decided") matching = matching.where("c.kind", "is not", null);
  if (query.decided === "moved") {
    matching = matching.where(sql<boolean>`EXISTS (SELECT 1 FROM animal_curation_stale st WHERE st.animal_id = a.entity_id)`);
  }

  const counted = await db
    .selectFrom(matching.as("m"))
    .select((eb) => eb.fn.countAll<number | bigint>().as("n"))
    .executeTakeFirst();
  const total = Number(counted?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(query.page, pages);
  const found = await matching
    .orderBy("a.scientific_name")
    .orderBy("r.ordinal")
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE)
    .execute();
  return { rows: await decorate(db, found), total, page, pages };
}

export interface TaxonomySummary {
  /** The day the loaded thesaurus was fetched from Ecdysis; null when none is loaded. */
  ecdysisFetchedOn: Date | null;
  /** How many nodes stand each way. */
  standings: Record<Exclude<AnimalEcdysisStanding, "not loaded">, number>;
  /** Names a taxonomist has decided about, and how many of those the loaded thesaurus has moved from under. */
  decided: number;
  moved: number;
}

export async function taxonomySummary(db: Kysely<Database>): Promise<TaxonomySummary> {
  const counted = await db
    .selectFrom("animal_ecdysis")
    .select((eb) => ["standing", eb.fn.countAll<number | bigint>().as("n")])
    .groupBy("standing")
    .execute();
  const standings = { accepted: 0, synonym: 0, homonym: 0, absent: 0 };
  for (const row of counted) {
    if (row.standing !== "not loaded") standings[row.standing] = Number(row.n);
  }
  const fetch = await db
    .selectFrom("ecdysis_taxon")
    .select((eb) => eb.fn.max("fetched_on").as("fetched_on"))
    .executeTakeFirst();
  const fetchedOn = fetch?.fetched_on ?? null;
  const decided = await db
    .selectFrom("animal_curation")
    .select((eb) => eb.fn.countAll<number | bigint>().as("n"))
    .executeTakeFirst();
  const moved = await db
    .selectFrom("animal_curation_stale")
    .select((eb) => eb.fn.countAll<number | bigint>().as("n"))
    .executeTakeFirst();
  return {
    ecdysisFetchedOn: fetchedOn === null ? null : new Date(fetchedOn),
    standings,
    decided: Number(decided?.n ?? 0),
    moved: Number(moved?.n ?? 0),
  };
}

/** The ranks a row of the CSV names its ancestor at, Darwin Core's higher classification. */
const CLASSIFICATION = ["kingdom", "phylum", "class", "order", "family", "genus"] as const;

/**
 * The whole tree as CSV (beeline-7dve), for reading in a spreadsheet: one row
 * per name, in the order the pages browse it — each name followed by what is
 * filed below it, ranks before names among siblings, as a name's page lists
 * its children. Darwin Core's Taxon terms where one fits, and the ancestors
 * at the main ranks spelled out, so a spreadsheet can sort or filter by
 * family without walking parents; Beeline's own columns follow. A name the
 * walk down from a root never reaches — only a cycle, which nothing
 * constrains against — is left out rather than looping.
 */
export async function taxonomyCsv(db: Kysely<Database>): Promise<string> {
  const placed = await sql<{ entity_id: number; path: string } & Record<(typeof CLASSIFICATION)[number], string | null>>`
    WITH RECURSIVE down(entity_id, path, depth, ${sql.join(CLASSIFICATION.map((rank) => sql.id(rank)))}) AS (
      SELECT a.entity_id, concat(lpad(CAST(r.ordinal AS TEXT), 3, '0'), ' ', a.scientific_name), 0,
             ${sql.join(CLASSIFICATION.map((rank) => sql`CASE WHEN a.rank = ${rank} THEN a.scientific_name END`))}
      FROM animal a JOIN animal_rank r ON r.rank = a.rank
      WHERE a.parent_id IS NULL
      UNION ALL
      -- chr(1) sorts below every character a name holds, so a name's children
      -- follow it before a sibling that merely starts with the same letters.
      SELECT a.entity_id, concat(down.path, chr(1), lpad(CAST(r.ordinal AS TEXT), 3, '0'), ' ', a.scientific_name), down.depth + 1,
             ${sql.join(CLASSIFICATION.map((rank) => sql`CASE WHEN a.rank = ${rank} THEN a.scientific_name ELSE down.${sql.id(rank)} END`))}
      FROM animal a JOIN animal_rank r ON r.rank = a.rank JOIN down ON a.parent_id = down.entity_id
      WHERE down.depth < 32
    )
    SELECT entity_id, path, ${sql.join(CLASSIFICATION.map((rank) => sql.id(rank)))} FROM down
  `.execute(db);
  const decorated = new Map((await decorate(db, await rows(db).execute())).map((row) => [row.entity_id, row]));
  const ordered = [...placed.rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return toCsv(
    [
      "taxonRank",
      "scientificName",
      "scientificNameAuthorship",
      "parentNameUsage",
      ...CLASSIFICATION,
      "acceptedNameUsage",
      "ecdysisTaxonID",
      "ecdysisStanding",
      "specimens",
      "decision",
      "decidedBy",
    ],
    ordered.flatMap((place) => {
      const row = decorated.get(place.entity_id);
      if (row === undefined) return [];
      return [
        [
          row.rank,
          row.scientific_name,
          row.authorship,
          row.parent?.scientific_name ?? null,
          ...CLASSIFICATION.map((rank) => place[rank]),
          row.accepted?.scientific_name ?? null,
          row.ecdysis_tid,
          row.standing,
          row.specimens,
          row.decision?.kind ?? null,
          row.decision?.taxonomist ?? null,
        ],
      ];
    }),
  );
}
