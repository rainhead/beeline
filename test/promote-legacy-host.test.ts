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
  // Synthetic: a hyphenated epithet, which the pattern admits on purpose.
  { sid: "117", genus: "Arctostaphylos", species: "uva-ursi", name: "Arctostaphylos uva-ursi", rank: "species" },
];

let conn: DuckDBConnection;
let migration: string;
/** Every sample's host straight after promotion with the new rule. */
let promoted: unknown[][];

const hostOf = async (sid: string) =>
  (await rows(conn, `SELECT host_name_as_observed, host_rank FROM sample WHERE sample_number = '${sid}'`))[0];

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await loadLegacyStaging(conn, FIXTURE);
  const q = (v: string) => `'${v.replaceAll("'", "''")}'`;
  const insert = (id: string, fieldNumber: string, s: Pick<Shape, "sid" | "genus" | "species" | "family">, specimenId = "1") =>
    conn.run(`INSERT INTO legacy_occurrence
      SELECT * REPLACE (${q(id)} AS _id, ${q(fieldNumber)} AS "fieldNumber", ${q(s.sid)} AS "sampleId", '' AS url,
                        ${q(specimenId)} AS "specimenId",
                        ${q(s.genus)} AS "genusPlant", ${q(s.species)} AS "speciesPlant", ${q(s.family ?? "")} AS "familyPlant",
                        '' AS "orderPlant", '' AS "phylumPlant")
      FROM legacy_occurrence WHERE "fieldNumber" = '25000001'`);
  for (const s of SHAPES) await insert(`host-${s.sid}`, "9" + s.sid, s);
  // Synthetic: one sample of two records, the first (lower _id, so the one
  // the host is named from) already right and the second a bare epithet.
  // The host is the first record's, before and after the migration. Two
  // specimens, so promotion does not read the second as a reprint of the first.
  await insert("host-115a", "9115", { sid: "115", genus: "Salvia", species: "Salvia officinalis" });
  await insert("host-115b", "9215", { sid: "115", genus: "Solidago", species: "canadensis" }, "2");
  // The shape of production's sample 70084: a first record with no plant
  // column at all, which promotion passes over, and a second that names the
  // host as a genus and a bare epithet.
  await insert("host-116a", "9116", { sid: "116", genus: "", species: "" });
  await insert("host-116b", "9216", { sid: "116", genus: "Holodiscus", species: "discolor" }, "2");
  await promoteLegacy(conn, FIXTURE_INPUTS);
  promoted = await rows(conn, `SELECT sample_number, host_name_as_observed, host_rank FROM sample ORDER BY 1`);
  migration = await readFile(`${MIGRATIONS_DIR}0091-host-name-from-genus-and-epithet.sql`, "utf8");
});

describe("a promoted sample's host", () => {
  test.each(SHAPES)("$genus | $species is named $name at rank $rank", async (s) => {
    expect(await hostOf(s.sid)).toEqual([s.name, s.rank]);
  });

  test("is named from the sample's first record, not from a later one the new rule rewrites", async () => {
    expect(await rows(conn, `SELECT count(*) FROM legacy_specimen_number WHERE _id LIKE 'host-115%'`)).toEqual([[2n]]);
    expect(await hostOf("115")).toEqual(["Salvia officinalis", "species"]);
  });

  test("passes over a first record with no plant column", async () => {
    expect(await hostOf("116")).toEqual(["Holodiscus discolor", "species"]);
  });
});

describe("migration 0091, on a store promoted before the rule", () => {
  // Put the stored hosts back as the old rule wrote them: the first non-empty
  // plant column of the sample's first record, ranked by its column.
  const OLD = `
    UPDATE sample SET host_name_as_observed = o.old_name, host_rank = o.old_rank
    FROM (SELECT n.sample_id,
                 arg_min(coalesce(nullif(p."speciesPlant", ''), nullif(p."genusPlant", ''), nullif(p."familyPlant", '')), p._id) AS old_name,
                 arg_min(CASE WHEN nullif(p."speciesPlant", '') IS NOT NULL THEN 'species'
                              WHEN nullif(p."genusPlant", '') IS NOT NULL THEN 'genus'
                              WHEN nullif(p."familyPlant", '') IS NOT NULL THEN 'family' END, p._id) AS old_rank
          FROM legacy_specimen_number n JOIN legacy_occurrence p ON p._id = n._id
          WHERE p._id LIKE 'host-%'
          GROUP BY n.sample_id) o
    WHERE entity_id = o.sample_id`;

  test("changes nothing on a store promoted with the rule already in it", async () => {
    const before = await rows(conn, `SELECT sample_number, host_name_as_observed, host_rank FROM sample ORDER BY 1`);
    await conn.run(migration);
    expect(await rows(conn, `SELECT sample_number, host_name_as_observed, host_rank FROM sample ORDER BY 1`)).toEqual(before);
  });

  test("gives every sample what promotion with the rule gives it", async () => {
    await conn.run(OLD);
    expect(await hostOf("116")).toEqual(["discolor", "species"]);
    await conn.run(migration);
    expect(await rows(conn, `SELECT sample_number, host_name_as_observed, host_rank FROM sample ORDER BY 1`)).toEqual(promoted);
  });

  test("repairs the epithet and the binomial, and nothing else, and does so once", async () => {
    await conn.run(OLD);
    expect(await hostOf("101")).toEqual(["canadensis", "species"]);
    expect(await hostOf("105")).toEqual(["Gutierrezia sarothrae", "genus"]);
    expect(await hostOf("106")).toEqual(["Ericameria nauseosa", "genus"]);

    // A sample with a host taxon follows its observation, so this one is not
    // read from the legacy rows even though they would give it a new name.
    await conn.run(`UPDATE sample SET host_inat_taxon_id = 47605 WHERE sample_number = '102'`);
    // A host somebody has set since promotion is theirs.
    await conn.run(`UPDATE sample SET host_name_as_observed = 'Solidago altissima' WHERE sample_number = '103'`);
    // So is a rank somebody has set, even where the name is still the old one.
    await conn.run(`UPDATE sample SET host_rank = 'family' WHERE sample_number = '106'`);

    const before = await rows(conn, `SELECT sample_number, host_name_as_observed, host_rank FROM sample ORDER BY 1`);
    await conn.run(migration);
    expect(await hostOf("101")).toEqual(["Solidago canadensis", "species"]);
    expect(await hostOf("104")).toEqual(["Aster subspicatus", "species"]);
    expect(await hostOf("105")).toEqual(["Gutierrezia sarothrae", "species"]);
    expect(await hostOf("106")).toEqual(["Ericameria nauseosa", "family"]);
    expect(await hostOf("116")).toEqual(["Holodiscus discolor", "species"]);
    expect(await hostOf("117")).toEqual(["Arctostaphylos uva-ursi", "species"]);
    expect(await hostOf("102")).toEqual(["discolor", "species"]);
    expect(await hostOf("103")).toEqual(["Solidago altissima", "species"]);
    // Named from its first record, which needed no repair; its second record's
    // epithet must not be read in its place.
    expect(await hostOf("115")).toEqual(["Salvia officinalis", "species"]);

    // Every other sample, the ones the rule has no opinion on, is as it was.
    const after = await rows(conn, `SELECT sample_number, host_name_as_observed, host_rank FROM sample ORDER BY 1`);
    const changed = after.filter((r, i) => JSON.stringify(r) !== JSON.stringify(before[i])).map((r) => r[0]);
    expect(changed).toEqual(["101", "104", "105", "116", "117"]);

    // Running it again changes nothing.
    await conn.run(migration);
    expect(await rows(conn, `SELECT sample_number, host_name_as_observed, host_rank FROM sample ORDER BY 1`)).toEqual(after);
  });

});
