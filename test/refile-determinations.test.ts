import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, test } from "vitest";
import { loadEcdysisTaxonomy } from "../src/load-ecdysis-taxonomy.js";
import { refileDeterminations, RefileRefused } from "../src/refile-determinations.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

/**
 * Filing determinations made under one name under another, as new events.
 * The real case is Protohalonia venusta, which Ecdysis files as Eucera
 * venusta; the fixture's thesaurus (test/fixtures/ecdysis-taxonomy/) has
 * neither, so the name here is a stand-in: an old-system name the tree holds
 * under Insecta with no family, as Protohalonia is, filed under Melecta
 * pacifica, a bee Ecdysis accepts and the tree lacks.
 */

const ECDYSIS_TAXONOMY = new URL("./fixtures/ecdysis-taxonomy/", import.meta.url).pathname;

let conn: DuckDBConnection;
const one = async (q: string) => Number((await rows(conn, q))[0]![0]);

async function node(rank: string, name: string, parent: string | null): Promise<void> {
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id)
     SELECT '${rank}', '${name}', ${parent === null ? "NULL" : `(SELECT entity_id FROM animal WHERE scientific_name = '${parent}')`}`,
  );
}

let specimens: number[];

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  await node("kingdom", "Animalia", null);
  await node("phylum", "Arthropoda", "Animalia");
  await node("class", "Insecta", "Arthropoda");
  await node("order", "Hymenoptera", "Insecta");
  await node("family", "Apidae", "Hymenoptera");
  await node("genus", "Oldname", "Insecta");
  await node("species", "Oldname venusta", "Oldname");
  await loadEcdysisTaxonomy(conn, ECDYSIS_TAXONOMY);
  const best = await one(`INSERT INTO person (display_name) VALUES ('Lincoln Best') RETURNING entity_id`);
  const sample = await insertCleanSample(conn, { collector_id: String(best), sample_number: "'1'" });
  specimens = [];
  for (const n of [1, 2, 3]) {
    specimens.push(await one(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, ${n}, '2200${n}') RETURNING entity_id`));
  }
  // Two specimens determined under the old name, as the old system's expert
  // records are (no verbatim name, a year's precision on one); a third named
  // something else, which must be left alone.
  await conn.run(`INSERT INTO determination (specimen_id, animal_id, sex, determiner_id, determiner_name, is_expert, channel, determined_on, determined_on_precision, recorded_at)
    VALUES (${specimens[0]}, (SELECT entity_id FROM animal WHERE scientific_name = 'Oldname venusta'), 'female', ${best}, 'L.R.Best', true, 'legacy_import', DATE '2022-01-01', 'year', TIMESTAMPTZ '2026-11-03 22:25:10Z'),
           (${specimens[1]}, (SELECT entity_id FROM animal WHERE scientific_name = 'Oldname venusta'), 'male', ${best}, 'L.R.Best', true, 'legacy_import', NULL, NULL, TIMESTAMPTZ '2026-11-03 22:25:10Z'),
           (${specimens[2]}, (SELECT entity_id FROM animal WHERE scientific_name = 'Apidae'), NULL, ${best}, 'L.R.Best', true, 'legacy_import', NULL, NULL, TIMESTAMPTZ '2026-11-03 22:25:10Z')`);
});

const REASON = "Filed under Melecta pacifica, Ecdysis's name for the species (test).";

describe("refiling determinations under another name", () => {
  test("records a new determination for each specimen, saying what the old one said, and leaves the old one in the history", async () => {
    const result = await refileDeterminations(conn, { from: "Oldname venusta", to: "Melecta pacifica", reason: REASON });
    expect(result).toEqual({ specimens: specimens.slice(0, 2), adopted: ["Melecta pacifica", "Melecta"] });
    expect(
      await rows(
        conn,
        `SELECT d.specimen_id, a.scientific_name, d.verbatim_identification, d.sex, d.determiner_name, d.is_expert, d.channel,
                CAST(d.determined_on AS TEXT), d.determined_on_precision, d.notes
         FROM determination_of_record d JOIN animal a ON a.entity_id = d.animal_id ORDER BY d.specimen_id`,
      ),
    ).toEqual([
      [specimens[0], "Melecta pacifica", "Oldname venusta", "female", "L.R.Best", true, "legacy_import", "2022-01-01", "year", REASON],
      [specimens[1], "Melecta pacifica", "Oldname venusta", "male", "L.R.Best", true, "legacy_import", null, null, REASON],
      [specimens[2], "Apidae", null, null, "L.R.Best", true, "legacy_import", null, null, null],
    ]);
    // Nothing edited: the old determinations are still there, now history.
    expect(await one("SELECT count(*) FROM determination")).toBe(5);
    expect(await one("SELECT count(*) FROM determination d JOIN animal a ON a.entity_id = d.animal_id WHERE a.scientific_name = 'Oldname venusta'")).toBe(2);
  });

  test("files under a name the tree already holds without adding anything, and a second run finds nothing to do", async () => {
    await refileDeterminations(conn, { from: "Oldname venusta", to: "Melecta pacifica", reason: REASON });
    const nodes = await one("SELECT count(*) FROM animal");
    expect(await refileDeterminations(conn, { from: "Oldname venusta", to: "Melecta pacifica", reason: REASON })).toEqual({ specimens: [], adopted: [] });
    expect(await one("SELECT count(*) FROM animal")).toBe(nodes);
    expect(await one("SELECT count(*) FROM determination")).toBe(5);
  });

  test("changes nothing on a dry run", async () => {
    const result = await refileDeterminations(conn, { from: "Oldname venusta", to: "Melecta pacifica", reason: REASON, dryRun: true });
    expect(result.specimens).toEqual(specimens.slice(0, 2));
    expect(await one("SELECT count(*) FROM determination")).toBe(3);
    expect(await one("SELECT count(*) FROM animal WHERE scientific_name LIKE 'Melecta%'")).toBe(0);
  });

  test("refuses a name Ecdysis cannot supply, a name the tree lacks, and no reason", async () => {
    // Rileya is two accepted genera in Ecdysis: which is meant is a taxonomist's choice.
    await expect(refileDeterminations(conn, { from: "Oldname venusta", to: "Rileya", reason: REASON })).rejects.toBeInstanceOf(RefileRefused);
    await expect(refileDeterminations(conn, { from: "Nosuchname", to: "Melecta pacifica", reason: REASON })).rejects.toBeInstanceOf(RefileRefused);
    await expect(refileDeterminations(conn, { from: "Oldname venusta", to: "Melecta pacifica", reason: " " })).rejects.toBeInstanceOf(RefileRefused);
    expect(await one("SELECT count(*) FROM determination")).toBe(3);
  });
});
