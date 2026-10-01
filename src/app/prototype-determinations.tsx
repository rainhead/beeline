/**
 * PROTOTYPE — throwaway. Three volunteer determination screens on one route,
 * `/prototype/determinations?variant=A|B|C`, for beeline-bcq: what should
 * entering determinations look like for a volunteer with two thousand pinned
 * bees? Real data in, nothing out — every variant keeps its state in the
 * browser and shows what it *would* record, and the store is never written.
 *
 *   A  Grid      — the August wireframe: every specimen a row, fill-down over
 *                  a selection, rows save as drafts and freeze later.
 *   B  Box       — taxon first: say what the box holds, then scan or type the
 *                  numbers in it. Each number is an assertion, undoable for
 *                  the session.
 *   C  One by one — a specimen at a time, the tree drilled by buttons, into a
 *                  tray that is submitted deliberately.
 *
 * Lives on the prototype/volunteer-determinations branch only; the route is
 * not registered in production.
 */
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";

const BEE_FAMILIES = ["Andrenidae", "Apidae", "Colletidae", "Halictidae", "Megachilidae", "Melittidae"];

export interface ProtoSpecimen {
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
  /** The newest volunteer determination already in the store, if any. Expert ones are withheld (anti-anchoring, beeline-bcq). */
  prior: { animalId: number; sex: string | null; caste: string | null; qualifier: string | null; recordedAt: string } | null;
}

export interface ProtoTaxon {
  id: number;
  rank: string;
  name: string;
  family: string | null;
  genus: string | null;
  parentId: number | null;
  bee: boolean;
  /** Specimens whose determination of record is this node: how common it is, for ordering. */
  uses: number;
}

export interface ProtoData {
  person: string;
  season: number;
  seasons: { season: number; specimens: number; outstanding: number }[];
  specimens: ProtoSpecimen[];
  taxa: ProtoTaxon[];
}

/** A season is the year it began; it begins 1 March (schema/160). */
const SEASON = sql`CAST(EXTRACT(YEAR FROM s.date_end - INTERVAL 2 MONTH) AS INTEGER)`;

export async function loadProtoData(db: Kysely<Database>, personId: number, requested: number | null): Promise<ProtoData> {
  const person = await sql<{ name: string }>`SELECT display_name AS name FROM person WHERE entity_id = ${personId}`.execute(db);

  const seasons = (
    await sql<{ season: number; specimens: number; outstanding: number }>`
      SELECT ${SEASON} AS season,
             CAST(count(*) AS INTEGER) AS specimens,
             CAST(count(*) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM determination d WHERE d.specimen_id = sp.entity_id AND NOT d.is_expert)) AS INTEGER) AS outstanding
      FROM sample_collector sc
      JOIN sample s ON s.entity_id = sc.sample_id
      JOIN specimen sp ON sp.sample_id = s.entity_id
      WHERE sc.person_id = ${personId}
      GROUP BY 1 ORDER BY 1 DESC`.execute(db)
  ).rows;

  const season =
    requested !== null && seasons.some((s) => s.season === requested)
      ? requested
      : (seasons.find((s) => s.outstanding > 0) ?? seasons[0])?.season ?? new Date().getFullYear();

  const specimens = (
    await sql<{
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
      prior_sex: string | null;
      prior_caste: string | null;
      prior_qualifier: string | null;
      prior_at: string | null;
    }>`
      WITH mine AS (
        SELECT DISTINCT s.* FROM sample_collector sc JOIN sample s ON s.entity_id = sc.sample_id
        WHERE sc.person_id = ${personId} AND ${SEASON} = ${season}
      ),
      vol AS (
        SELECT * FROM (
          SELECT d.*, row_number() OVER (PARTITION BY specimen_id ORDER BY recorded_at DESC, entity_id DESC) AS rn
          FROM determination d WHERE NOT d.is_expert
        ) WHERE rn = 1
      )
      SELECT sp.entity_id AS id, sp.field_number, sp.specimen_number,
             s.entity_id AS sample_id, s.sample_number,
             CAST(s.date_start AS TEXT) AS date_start, CAST(s.date_end AS TEXT) AS date_end,
             s.kind, s.locality, s.county, CAST(s.inat_observation_id AS TEXT) AS observation,
             s.host_name_as_observed AS host,
             vol.animal_id AS prior_animal, vol.sex AS prior_sex, vol.caste AS prior_caste,
             vol.qualifier AS prior_qualifier, CAST(vol.recorded_at AS TEXT) AS prior_at
      FROM mine s
      JOIN specimen sp ON sp.sample_id = s.entity_id
      LEFT JOIN vol ON vol.specimen_id = sp.entity_id
      ORDER BY s.date_start, s.sample_number, sp.specimen_number`.execute(db)
  ).rows.map(
    (r): ProtoSpecimen => ({
      id: r.id,
      fieldNumber: r.field_number,
      specimenNumber: r.specimen_number,
      sampleId: r.sample_id,
      sampleNumber: r.sample_number,
      dateStart: r.date_start,
      dateEnd: r.date_end,
      kind: r.kind,
      locality: r.locality,
      county: r.county,
      observation: r.observation === null ? null : Number(r.observation),
      host: r.host,
      prior:
        r.prior_animal === null
          ? null
          : { animalId: r.prior_animal, sex: r.prior_sex, caste: r.prior_caste, qualifier: r.prior_qualifier, recordedAt: r.prior_at ?? "" },
    }),
  );

  const nodes = (
    await sql<{ id: number; rank: string; name: string; parent_id: number | null; uses: number }>`
      SELECT a.entity_id AS id, a.rank, a.scientific_name AS name, a.parent_id,
             CAST(coalesce(u.n, 0) AS INTEGER) AS uses
      FROM animal a
      LEFT JOIN (SELECT animal_id, count(*) AS n FROM determination_of_record GROUP BY 1) u ON u.animal_id = a.entity_id`.execute(db)
  ).rows;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ancestor = (id: number | null, rank: string): string | null => {
    for (let n = id === null ? undefined : byId.get(id); n !== undefined; n = n.parent_id === null ? undefined : byId.get(n.parent_id)) {
      if (n.rank === rank) return n.name;
    }
    return null;
  };
  const taxa = nodes
    .filter((n) => !["kingdom", "phylum", "class"].includes(n.rank))
    .map((n): ProtoTaxon => {
      const family = ancestor(n.id, "family");
      return {
        id: n.id,
        rank: n.rank,
        name: n.name,
        family,
        genus: ancestor(n.id, "genus"),
        parentId: n.parent_id,
        bee: family !== null && BEE_FAMILIES.includes(family),
        uses: n.uses,
      };
    });

  return { person: person.rows[0]?.name ?? "unknown", season, seasons, specimens, taxa };
}

export const PROTO_VARIANTS = [
  { key: "A", name: "Grid" },
  { key: "B", name: "Box" },
  { key: "C", name: "One by one" },
] as const;

export function ProtoDeterminations({ data, variant }: { data: ProtoData; variant: string }) {
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  const current = data.seasons.find((s) => s.season === data.season);
  return (
    <>
      <div class="page-header">
        <div>
          <h1>Your determinations</h1>
          <p class="meta">
            {data.person} · {current?.specimens ?? 0} specimens from the {data.season} season,{" "}
            {current?.outstanding ?? 0} with no determination of yours yet
          </p>
        </div>
        <nav class="segmented proto-seasons" aria-label="Season">
          {data.seasons.slice(0, 6).map((s) => (
            <a href={`?variant=${variant}&season=${s.season}`} aria-current={s.season === data.season ? "page" : undefined}>
              {s.season}
            </a>
          ))}
        </nav>
      </div>
      <p class="callout warning proto-banner">
        Prototype {variant}. Nothing here is saved — the panel at the foot of the page shows what it would record. Switch
        variants with the bar at the bottom, or ← and →.
      </p>
      <script type="application/json" id="det-proto-data" dangerouslySetInnerHTML={{ __html: json }} />
      {variant === "B" ? <det-proto-box /> : variant === "C" ? <det-proto-tray /> : <det-proto-grid />}
      <det-proto-ledger variant={variant} />
      <proto-switcher variants={PROTO_VARIANTS.map((v) => `${v.key}:${v.name}`).join(",")} current={variant} />
    </>
  );
}
