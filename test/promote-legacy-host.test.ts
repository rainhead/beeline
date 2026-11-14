import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, FIXTURE_INPUTS, rows } from "./helpers.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy } from "../src/promote-legacy.js";
import { MIGRATIONS_DIR } from "../src/migrate.js";

/**
 * How a sample's host is named from the old Beeline's five plant columns
 * (beeline-32ow). Every (genusPlant, speciesPlant) pair below is a pair the
 * 2026-11-13 production store holds, except those marked synthetic; each is
 * given a sample of its own on the shared fixture by copying Ada's first
 * record under a new field number and sample number.
 */
const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;

interface Shape {
  sid: string;
  genus: string;
  species: string;
  family?: string;
  name: string | null;
  rank: string | null;
}

const SHAPES: Shape[] = [
  // The old Beeline's hand-typed records: the genus in one column, the epithet in the other.
  { sid: "101", genus: "Solidago", species: "canadensis", name: "Solidago canadensis", rank: "species" },
  { sid: "102", genus: "Holodiscus", species: "discolor", name: "Holodiscus discolor", rank: "species" },
  { sid: "103", genus: "Helianthus", species: "maximilani", name: "Helianthus maximilani", rank: "species" },
  { sid: "104", genus: "Aster", species: "subspicatus", name: "Aster subspicatus", rank: "species" },
  // The whole binomial in the genus column and nothing in the species column.
  { sid: "105", genus: "Gutierrezia sarothrae", species: "", name: "Gutierrezia sarothrae", rank: "species" },
  { sid: "106", genus: "Ericameria nauseosa", species: "", name: "Ericameria nauseosa", rank: "species" },
  // Already right, and left alone: the whole binomial in the species column,
  // which is how iNaturalist's names arrive.
  { sid: "107", genus: "Salvia", species: "Salvia officinalis", name: "Salvia officinalis", rank: "species" },
  // A trinomial, a hybrid with its sign mangled in transit, and a name with a
  // newline in it are written whole, so none is rebuilt.
  { sid: "108", genus: "Eriophyllum", species: "Eriophyllum lanatum integrifolium", name: "Eriophyllum lanatum integrifolium", rank: "species" },
  { sid: "109", genus: "Reynoutria", species: "Reynoutria Ã— bohemica", name: "Reynoutria Ã— bohemica", rank: "species" },
  { sid: "110", genus: "", species: "Agastache \nurticifolia", name: "Agastache \nurticifolia", rank: "species" },
  // Higher ranks keep the rank of the column that named them.
  { sid: "111", genus: "Salvia", species: "", name: "Salvia", rank: "genus" },
  { sid: "112", genus: "", species: "", family: "Lamiaceae", name: "Lamiaceae", rank: "family" },
  // Synthetic: nothing in the corpus has an epithet beside a lower-case or
  // multi-word genus, so those stay as typed rather than be guessed at.
  { sid: "113", genus: "salvia", species: "officinalis", name: "officinalis", rank: "species" },
  { sid: "114", genus: "Salvia officinalis", species: "var. alba", name: "var. alba", rank: "species" },
];

let conn: DuckDBConnection;
let migration: string;

const hostOf = async (sid: string) =>
  (await rows(conn, `SELECT host_name_as_observed, host_rank FROM sample WHERE sample_number = '${sid}'`))[0];

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await loadLegacyStaging(conn, FIXTURE);
  for (const s of SHAPES) {
    const q = (v: string) => `'${v.replaceAll("'", "''")}'`;
    await conn.run(`INSERT INTO legacy_occurrence
      SELECT * REPLACE ('host-${s.sid}' AS _id, ${q("9" + s.sid)} AS "fieldNumber", ${q(s.sid)} AS "sampleId", '' AS url,
                        ${q(s.genus)} AS "genusPlant", ${q(s.species)} AS "speciesPlant", ${q(s.family ?? "")} AS "familyPlant",
                        '' AS "orderPlant", '' AS "phylumPlant")
      FROM legacy_occurrence WHERE "fieldNumber" = '25000001'`);
  }
  await promoteLegacy(conn, FIXTURE_INPUTS);
  migration = await readFile(`${MIGRATIONS_DIR}0089-host-name-from-genus-and-epithet.sql`, "utf8");
});

describe("a promoted sample's host", () => {
  test.each(SHAPES)("$genus | $species is named $name at rank $rank", async (s) => {
    expect(await hostOf(s.sid)).toEqual([s.name, s.rank]);
  });
});

describe("migration 0089, on a store promoted before the rule", () => {
  // Put the stored hosts back as the old rule wrote them: the first non-empty
  // plant column, ranked by its column.
  const OLD = `
    UPDATE sample SET host_name_as_observed = o.old_name, host_rank = o.old_rank
    FROM (SELECT n.sample_id,
                 coalesce(nullif(p."speciesPlant", ''), nullif(p."genusPlant", ''), nullif(p."familyPlant", '')) AS old_name,
                 CASE WHEN nullif(p."speciesPlant", '') IS NOT NULL THEN 'species'
                      WHEN nullif(p."genusPlant", '') IS NOT NULL THEN 'genus' ELSE 'family' END AS old_rank
          FROM legacy_specimen_number n JOIN legacy_occurrence p ON p._id = n._id
          WHERE p._id LIKE 'host-%') o
    WHERE entity_id = o.sample_id`;

  test("changes nothing on a store promoted with the rule already in it", async () => {
    const before = await rows(conn, `SELECT sample_number, host_name_as_observed, host_rank FROM sample ORDER BY 1`);
    await conn.run(migration);
    expect(await rows(conn, `SELECT sample_number, host_name_as_observed, host_rank FROM sample ORDER BY 1`)).toEqual(before);
  });

  test("repairs the epithet and the binomial, and nothing else, and does so once", async () => {
    await conn.run(OLD);
    expect(await hostOf("101")).toEqual(["canadensis", "species"]);
    expect(await hostOf("105")).toEqual(["Gutierrezia sarothrae", "genus"]);

    // A sample with a host taxon follows its observation, so this one is not
    // read from the legacy rows even though they would give it a new name.
    await conn.run(`UPDATE sample SET host_inat_taxon_id = 47605 WHERE sample_number = '102'`);
    // A host somebody has set since promotion is theirs.
    await conn.run(`UPDATE sample SET host_name_as_observed = 'Solidago altissima' WHERE sample_number = '103'`);

    const before = await rows(conn, `SELECT sample_number, host_name_as_observed, host_rank FROM sample ORDER BY 1`);
    await conn.run(migration);
    expect(await hostOf("101")).toEqual(["Solidago canadensis", "species"]);
    expect(await hostOf("104")).toEqual(["Aster subspicatus", "species"]);
    expect(await hostOf("105")).toEqual(["Gutierrezia sarothrae", "species"]);
    expect(await hostOf("106")).toEqual(["Ericameria nauseosa", "species"]);
    expect(await hostOf("102")).toEqual(["discolor", "species"]);
    expect(await hostOf("103")).toEqual(["Solidago altissima", "species"]);

    // Every other sample, the ones the rule has no opinion on, is as it was.
    const after = await rows(conn, `SELECT sample_number, host_name_as_observed, host_rank FROM sample ORDER BY 1`);
    const changed = after.filter((r, i) => JSON.stringify(r) !== JSON.stringify(before[i])).map((r) => r[0]);
    expect(changed).toEqual(["101", "104", "105", "106"]);

    // Running it again changes nothing.
    await conn.run(migration);
    expect(await rows(conn, `SELECT sample_number, host_name_as_observed, host_rank FROM sample ORDER BY 1`)).toEqual(after);
  });

});
