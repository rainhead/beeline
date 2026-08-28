import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, rows } from "./helpers.js";
import { isItalicRank } from "../src/app/views/components/taxon.js";

let conn: DuckDBConnection;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector'), ('Bea Printer')");
});

describe("schema application", () => {
  test("the global entity sequence assigns ids across tables", async () => {
    const [[a], [b]] = (await rows(conn, "SELECT entity_id FROM person ORDER BY entity_id")) as [[number], [number]];
    expect(b).toBe(a + 1);
    // The next entity, whatever its table, continues the same sequence.
    const [[c]] = (await rows(
      conn,
      "INSERT INTO atlas (code, name) VALUES ('XX', 'Test Atlas') RETURNING entity_id",
    )) as [[number]];
    expect(c).toBe(b + 1);
  });

  test("the six member atlases are seeded", async () => {
    const codes = await rows(conn, "SELECT code FROM atlas WHERE code <> 'XX' ORDER BY code");
    expect(codes.flat()).toEqual(["BC", "ID", "NM", "OBA", "OK", "WaBA"]);
  });

  test("atlas_region knows the regions no atlas covers, not only the six", async () => {
    // The point of the table: a NULL atlas on a real region is an answer.
    const [[covered]] = (await rows(conn, "SELECT count(*) FROM atlas_region WHERE atlas_id IS NOT NULL")) as [[bigint]];
    const [[outside]] = (await rows(conn, "SELECT count(*) FROM atlas_region WHERE atlas_id IS NULL")) as [[bigint]];
    expect(Number(covered)).toBe(6);
    expect(Number(outside)).toBeGreaterThan(50);
    // Nevada is known and uncovered; Waikato is not a region we recognise.
    expect(await rows(conn, "SELECT country, atlas_id FROM atlas_region WHERE state_province = 'NV'")).toEqual([
      ["USA", null],
    ]);
    expect(await rows(conn, "SELECT count(*) FROM atlas_region WHERE state_province = 'Waikato'")).toEqual([[0n]]);
  });

  test("membership cannot say 'atlas' without one, or name one while saying 'program'", async () => {
    const [[person]] = (await rows(
      conn,
      "INSERT INTO person (display_name) VALUES ('Eve Outsider') RETURNING entity_id",
    )) as [[number]];
    const oba = "(SELECT entity_id FROM atlas WHERE code = 'OBA')";
    await expect(
      conn.run(`INSERT INTO person_membership (person_id, kind, atlas_id) VALUES (${person}, 'atlas', NULL)`),
    ).rejects.toThrow(/CHECK/i);
    await expect(
      conn.run(`INSERT INTO person_membership (person_id, kind, atlas_id) VALUES (${person}, 'program', ${oba})`),
    ).rejects.toThrow(/CHECK/i);
    await conn.run(`INSERT INTO person_membership (person_id, kind, atlas_id) VALUES (${person}, 'program', NULL)`);
    expect(await rows(conn, `SELECT kind FROM person_membership WHERE person_id = ${person}`)).toEqual([["program"]]);
  });

  test("enum-ish CHECK constraints reject unknown values", async () => {
    await expect(
      conn.run(`INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end)
                VALUES ('bucket', (SELECT min(entity_id) FROM person), '1', DATE '2026-07-01', DATE '2026-07-01')`),
    ).rejects.toThrow(/CHECK/i);
  });

  test("date range must not run backwards", async () => {
    await expect(
      conn.run(`INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end)
                VALUES ('trap', (SELECT min(entity_id) FROM person), 'OBAS-00001', DATE '2026-07-14', DATE '2026-07-01')`),
    ).rejects.toThrow(/CHECK/i);
  });

  test("negative specimen counts are rejected at the boundary", async () => {
    await expect(
      conn.run(`INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end, specimen_count)
                VALUES ('net', (SELECT min(entity_id) FROM person), '1', DATE '2026-07-01', DATE '2026-07-01', -5)`),
    ).rejects.toThrow(/CHECK/i);
  });

  test("an elevation never arrives without provenance", async () => {
    await conn.run(`INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end)
                    VALUES ('net', (SELECT min(entity_id) FROM person), '9', DATE '2026-07-01', DATE '2026-07-01')`);
    await expect(
      conn.run(`INSERT INTO sample_location (sample_id, latitude, longitude, elevation_m, source)
                SELECT max(entity_id), 44.5, -123.2, 72, 'inat_public' FROM sample`),
    ).rejects.toThrow(/CHECK/i);
  });

  test("the rank table and the renderer agree about italics", async () => {
    // Two lists that must not drift, kept separate on purpose: animal_rank
    // holds the ranks this store admits, and TaxonName's set errs wider
    // because it has to do something sensible with a rank it has never heard
    // of. Where they overlap they have to say the same thing, or a name is
    // set one way in a listing and another on a label.
    const ranks = (await rows(conn, "SELECT rank, italic FROM animal_rank ORDER BY ordinal")) as [
      string,
      boolean,
    ][];
    expect(ranks.length).toBeGreaterThan(0);
    for (const [rank, italic] of ranks) {
      expect([rank, isItalicRank(rank)]).toEqual([rank, italic]);
    }
  });

  test("ranks order deeper-is-larger, with room to insert one", async () => {
    const [[genus], [species]] = (await rows(
      conn,
      "SELECT ordinal FROM animal_rank WHERE rank IN ('genus', 'species') ORDER BY ordinal",
    )) as [[number], [number]];
    expect(species).toBeGreaterThan(genus);
    // Gapped, so a rank between two others does not renumber the rest.
    expect(species - genus).toBeGreaterThan(1);
  });

  test("a rank the store does not admit is refused, and so is a duplicate name", async () => {
    await expect(
      conn.run("INSERT INTO animal (rank, scientific_name) VALUES ('cultivar', 'Whatever')"),
    ).rejects.toThrow();
    await conn.run("INSERT INTO animal (rank, scientific_name) VALUES ('genus', 'Bombus')");
    await expect(
      conn.run("INSERT INTO animal (rank, scientific_name) VALUES ('genus', 'Bombus')"),
    ).rejects.toThrow();
    // Same name at a different rank is not a duplicate: subgenus Bombus is a
    // real node inside genus Bombus.
    await conn.run("INSERT INTO animal (rank, scientific_name) VALUES ('subgenus', 'Bombus')");
  });

  test("a primary collector who is not the head of the list is caught the same way", async () => {
    // sample.collector_id and sample_collector position 1 are one fact
    // written twice, across two tables and depending on a row's position, so
    // no CHECK reaches it (schema/116, beeline-daa). An assertion view that
    // cannot be made to fire is worth nothing, so all three ways of being
    // wrong are exercised here. That it is *empty* on real data is asserted
    // where real data exists — after each promotion — rather than here, where
    // sibling tests leave samples with no collector list at all.
    const { conn } = await createMemoryDb();

    const person = async (name: string) => {
      const [[id]] = (await rows(
        conn,
        `INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`,
      )) as [[number]];
      return id;
    };
    const ada = await person("Ada Collector");
    const bo = await person("Bo Collector");
    const sample = async (number: string, collector: number) => {
      const [[id]] = (await rows(
        conn,
        `INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end)
         VALUES ('net', ${collector}, '${number}', DATE '2026-07-01', DATE '2026-07-01') RETURNING entity_id`,
      )) as [[number]];
      return id;
    };

    // 0 — collectors recorded, but none of them at the head of the list.
    const headless = await sample("c0", ada);
    await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${headless}, ${ada}, 2)`);
    // 1 — a head, naming somebody else. The drift that would show up as a
    // sample missing from its own collector's "mine".
    const wrongHead = await sample("c1", ada);
    await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${wrongHead}, ${bo}, 1)`);
    // 2+ — two collectors both at position 1, which the primary key
    // (sample_id, person_id) does nothing to stop.
    const twoHeads = await sample("c2", ada);
    await conn.run(
      `INSERT INTO sample_collector (sample_id, person_id, position)
       VALUES (${twoHeads}, ${ada}, 1), (${twoHeads}, ${bo}, 1)`,
    );
    // And one that is simply right, to prove the view is not just true.
    const correct = await sample("c3", ada);
    await conn.run(
      `INSERT INTO sample_collector (sample_id, person_id, position)
       VALUES (${correct}, ${ada}, 1), (${correct}, ${bo}, 2)`,
    );

    expect(
      await rows(conn, "SELECT sample_id, at_position_1 FROM sample_primary_collector_mismatch ORDER BY sample_id"),
    ).toEqual([
      [headless, 0],
      [wrongHead, 1],
      [twoHeads, 2],
    ]);
  });

  test("a qualifier below species rank is caught by the view a CHECK cannot be", async () => {
    // The rule spans two tables — "species or finer" is a fact about
    // animal_rank — so the engine cannot hold it and the view does
    // (schema/115). Nothing produces this today; the determination UI will be
    // the first writer that can (beeline-tgu).
    expect(await rows(conn, "SELECT entity_id FROM determination_misplaced_qualifier")).toEqual([]);

    await conn.run(`INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end)
                    VALUES ('net', (SELECT min(entity_id) FROM person), 'q1', DATE '2026-07-01', DATE '2026-07-01')`);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number)
                    SELECT max(entity_id), 1 FROM sample`);
    await conn.run(`INSERT INTO determination (specimen_id, animal_id, qualifier, is_expert, channel)
                    SELECT (SELECT max(entity_id) FROM specimen),
                           (SELECT entity_id FROM animal WHERE rank = 'genus' AND scientific_name = 'Bombus'),
                           'cf.', true, 'in_app'`);
    expect(
      await rows(conn, "SELECT rank, scientific_name, qualifier FROM determination_misplaced_qualifier"),
    ).toEqual([["genus", "Bombus", "cf."]]);
  });

  test("verbatim catalog numbers admit historical duplicates", async () => {
    // The historical duplicate 25051768 must be storable on two specimen rows.
    await conn.run(`INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end, specimen_count)
                    VALUES ('net', (SELECT min(entity_id) FROM person), '1', DATE '2025-08-17', DATE '2025-08-17', 2)`);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number)
                    SELECT max(entity_id), 1, '25051768' FROM sample`);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number)
                    SELECT max(entity_id), 2, '25051768' FROM sample`);
    const [[n]] = (await rows(conn, "SELECT count(*) FROM specimen WHERE field_number = '25051768'")) as [[bigint]];
    expect(Number(n)).toBe(2);
  });

  test("table and column comments are queryable in the database", async () => {
    const [[comment]] = (await rows(
      conn,
      "SELECT comment FROM duckdb_tables() WHERE table_name = 'animal'",
    )) as [[string]];
    expect(comment).toContain("curated taxonomy");
  });

  test("qc_rule metadata is seeded", async () => {
    const [[n]] = (await rows(conn, "SELECT count(*) FROM qc_rule")) as [[bigint]];
    expect(Number(n)).toBe(13);
  });
});
