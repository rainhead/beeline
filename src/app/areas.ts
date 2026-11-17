import { sql, type Kysely } from "kysely";
import { areaDisplayName } from "../area-name.js";
import { AREA_KINDS, type AreaKind, type Database } from "../model.js";
import { areaKey } from "./listings.js";

/**
 * The areas, listed by kind (beeline-9jd4): every named place with an
 * outline that at least one sample's point lies inside (schema/038), and how
 * many samples lie inside each.
 *
 * **Staff only.** The counts are of every sample, whoever may see where it
 * is: a count of one in a small park would tell a volunteer that somebody
 * collected there, which is what withholding a location is meant to keep
 * from them (`withheld`, src/app/listings.ts). Staff see every location, so
 * for them a count and the listing it links to agree. Showing this page to
 * anyone else needs the counts taken through that rule first.
 *
 * Counts are split by season, the active seasons against the settled ones
 * (settled_sample, schema/102), as every check count is.
 */

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

export interface AreaGroup {
  kind: AreaKind;
  areas: AreaSummary[];
}

/** Every kind that has an area with a sample inside, each kind's areas by name. The page orders the kinds, by their headings. */
export async function listAreas(db: Kysely<Database>): Promise<AreaGroup[]> {
  const { rows } = await sql<{ kind: AreaKind; source: string; source_id: string; name: string; active: number; settled: number }>`
    SELECT sac.kind, sac.source, sac.source_id, sac.name,
           count(*) FILTER (WHERE ss.sample_id IS NULL)::INTEGER AS active,
           count(ss.sample_id)::INTEGER AS settled
    FROM sample_area_current sac
    LEFT JOIN settled_sample ss ON ss.sample_id = sac.sample_id
    GROUP BY sac.kind, sac.source, sac.source_id, sac.name`.execute(db);
  const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  return AREA_KINDS.map((kind) => ({
    kind,
    areas: rows
      .filter((r) => r.kind === kind)
      .map((r) => ({
        key: areaKey(r.source, r.source_id),
        name: areaDisplayName(r.name),
        active: Number(r.active),
        settled: Number(r.settled),
      }))
      // Two parks can share a name (OpenStreetMap has several a Riverside
      // Park): the key settles their order, so a reload does not swap them.
      .sort((a, b) => collator.compare(a.name, b.name) || a.key.localeCompare(b.key)),
  })).filter((group) => group.areas.length > 0);
}
