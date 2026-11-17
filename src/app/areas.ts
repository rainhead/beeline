import { sql, type Kysely } from "kysely";
import { areaDisplayName } from "../area-name.js";
import type { AreaKind, Database } from "../model.js";
import { areaKey } from "./listings.js";

/**
 * The areas, as three pages (beeline-9jd4; the three are Peter's,
 * 2026-11-17): administrative districts, properties and ecoregions. Each
 * lists every such area that at least one sample's point lies inside
 * (schema/038), and how many samples lie inside it.
 *
 * - **Administrative districts** are the counties and BC's regional
 *   districts, under the state or province each is in, because a county's
 *   name is not unique: Oregon and Washington each have a Benton County.
 * - **Properties** are land somebody holds and names: national wildlife
 *   refuges, WDFW wildlife area units, National Park Service units, state and
 *   provincial parks, and the other parks and reserves OpenStreetMap
 *   outlines, where land trust preserves are.
 * - **Ecoregions** are the EPA's Level III ecoregions.
 *
 * Two kinds the store holds are on none of them. A federal wilderness is
 * where collecting needs a permit, which is not a thing to advertise as a
 * place to browse (Peter, 2026-11-17); a sample inside one still says so on
 * its own page. An island is none of the three.
 *
 * **Staff only.** The counts are of every sample, whoever may see where it
 * is: a count of one in a small park would tell a volunteer that somebody
 * collected there, which is what withholding a location is meant to keep
 * from them (`withheld`, src/app/listings.ts). Staff see every location, so
 * for them a count and the listing it links to agree. Showing these pages to
 * anyone else needs the counts taken through that rule first.
 *
 * Counts are split by season, the active seasons against the settled ones
 * (settled_sample, schema/102), as every check count is.
 */

export const AREA_TABS = ["districts", "properties", "ecoregions"] as const;
export type AreaTab = (typeof AREA_TABS)[number];

export const isAreaTab = (value: string): value is AreaTab => (AREA_TABS as readonly string[]).includes(value);

/** The kinds of area each page lists. */
export const TAB_KINDS: Record<AreaTab, readonly AreaKind[]> = {
  districts: ["county"],
  properties: ["refuge", "wildlife_area", "nps_unit", "state_park", "park"],
  ecoregions: ["ecoregion"],
};

export interface AreaSummary {
  /** The `area` filter's value for this area (areaKey). */
  key: string;
  /** As a page shows it (areaDisplayName). */
  name: string;
  /** Samples inside it from the active seasons. */
  active: number;
  /** Samples inside it from settled seasons. */
  settled: number;
}

/**
 * What a page's section gathers: the areas of one kind, or, for the
 * districts, those of one state or province. `state` is null for a district
 * no sample's point could be given a state from.
 */
export type AreaGrouping = { by: "kind"; kind: AreaKind } | { by: "state"; state: string | null; country: string | null };

export interface AreaGroup {
  grouping: AreaGrouping;
  areas: AreaSummary[];
}

interface AreaRow {
  kind: AreaKind;
  source: string;
  source_id: string;
  name: string;
  state: string | null;
  country: string | null;
  active: number;
  settled: number;
}

/**
 * One page's areas, in sections: the districts by state or province, the
 * properties by kind, the ecoregions as one. The view orders the sections;
 * each section's areas are by name.
 */
export async function listAreas(db: Kysely<Database>, tab: AreaTab): Promise<AreaGroup[]> {
  // A district's state is what its samples' points say (sample_area_derivation,
  // beeline-rax1), not a fact stored about the district: nothing records that
  // a county lies inside a state (Peter, 2026-10-26). Every sample in a
  // county agrees, since the point's state is read from that county.
  const { rows } = await sql<AreaRow>`
    SELECT sac.kind, sac.source, sac.source_id, sac.name,
           CASE WHEN sac.kind = 'county' THEN min(d.state_province) END AS state,
           CASE WHEN sac.kind = 'county' THEN min(d.country) END AS country,
           count(*) FILTER (WHERE ss.sample_id IS NULL)::INTEGER AS active,
           count(ss.sample_id)::INTEGER AS settled
    FROM sample_area_current sac
    JOIN sample_area_derivation d ON d.sample_id = sac.sample_id
    LEFT JOIN settled_sample ss ON ss.sample_id = sac.sample_id
    WHERE sac.kind IN (${sql.join(TAB_KINDS[tab])})
    GROUP BY sac.kind, sac.source, sac.source_id, sac.name`.execute(db);
  const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  const groups = new Map<string, AreaGroup>();
  for (const r of rows) {
    const grouping: AreaGrouping =
      tab === "districts" ? { by: "state", state: r.state, country: r.country } : { by: "kind", kind: r.kind };
    const id = grouping.by === "state" ? `${grouping.country ?? ""}/${grouping.state ?? ""}` : grouping.kind;
    const group = groups.get(id) ?? { grouping, areas: [] };
    groups.set(id, group);
    group.areas.push({
      key: areaKey(r.source, r.source_id),
      name: areaDisplayName(r.name),
      active: Number(r.active),
      settled: Number(r.settled),
    });
  }
  for (const group of groups.values()) {
    // Two parks can share a name (OpenStreetMap has several a Riverside
    // Park): the key settles their order, so a reload does not swap them.
    group.areas.sort((a, b) => collator.compare(a.name, b.name) || a.key.localeCompare(b.key));
  }
  return [...groups.values()];
}
