import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";
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

/**
 * What DuckDB 1.5.5 will and will not let an UPDATE write, pinned so that the
 * day it changes is a day something tells us (beeline-6e9).
 *
 * The store is built around this limitation in several places — the atlas is
 * set at INSERT or never (ingest/mint-samples.sql, sample_atlas_unfilled),
 * atlas.inat_place_id is left null (schema/010), the staff override screen
 * cannot reassign a collector — and every one of those is a comment claiming
 * an engine behaviour that nothing checked. A claim about the engine, made in
 * prose, in five files, is exactly the kind that quietly stops being true.
 *
 * The rule as measured: DuckDB refuses an UPDATE that writes an INDEXED
 * column of a row an incoming foreign key currently references. The update is
 * a delete-and-insert, and the delete trips the inbound check. Both halves are
 * necessary and neither alone is sufficient, which is what these tests
 * separate — the repo used to state only the second half, and that version
 * says locality cannot be written either, which is false and load-bearing.
 */
describe("updating a row an incoming foreign key references", () => {
  let db: DuckDBConnection;
  let ada: number;
  let bo: number;

  beforeAll(async () => {
    ({ conn: db } = await createMemoryDb());
    [[ada], [bo]] = (await rows(
      db,
      `INSERT INTO person (display_name)
       VALUES ('Ada Collector'), ('Bo Collector') RETURNING entity_id`,
    )) as [[number], [number]];
  });

  /**
   * A sample with a sample_collector row — every sample in a real store. Ada
   * collects it: insertCleanSample takes the lowest person id, and she is it.
   */
  const referenced = () => insertCleanSample(db, {}, null);
  /**
   * A sample nothing points at, which no promotion produces and this needs.
   * Bo collects it, so that writing Ada onto it is a real change: a test whose
   * update is a no-op in value cannot tell "refused" from "wrote what was
   * already there" (CodeRabbit on PR #26).
   */
  const unreferenced = async () => {
    const [[id]] = (await rows(
      db,
      `INSERT INTO sample (kind, collector_id, sample_number, date_start, date_end)
       VALUES ('net', ${bo}, 'u1', DATE '2026-07-01', DATE '2026-07-01') RETURNING entity_id`,
    )) as [[number]];
    return id;
  };
  const collectorOf = (id: number) => rows(db, `SELECT collector_id FROM sample WHERE entity_id = ${id}`);
  const violation = /still referenced by a foreign key/;

  test("an unindexed column is writable — which is what the descriptive refresh rides on", async () => {
    const id = await referenced();
    await db.run(`UPDATE sample SET locality = 'Alsea', county = 'BentonCo' WHERE entity_id = ${id}`);
    expect(await rows(db, `SELECT locality FROM sample WHERE entity_id = ${id}`)).toEqual([["Alsea"]]);
  });

  test("an indexed column is not: a sample's atlas and collector cannot be changed", async () => {
    const id = await referenced();
    const oba = "(SELECT entity_id FROM atlas WHERE code = 'OBA')";
    await expect(db.run(`UPDATE sample SET atlas_id = ${oba} WHERE entity_id = ${id}`)).rejects.toThrow(violation);
    await expect(db.run(`UPDATE sample SET collector_id = ${ada} WHERE entity_id = ${id}`)).rejects.toThrow(violation);
  });

  test("writing the value the column already holds fails too", async () => {
    // So it is the statement that is refused, not the change: an UPDATE that
    // would be a no-op cannot be used to prove the row is already correct.
    const id = await referenced();
    await expect(
      db.run(`UPDATE sample SET collector_id = collector_id WHERE entity_id = ${id}`),
    ).rejects.toThrow(violation);
  });

  test("the same write succeeds on a row nothing references", async () => {
    // The index alone is not the problem — which is why a mutable indexed
    // column is safe on a satellite table nothing points at.
    const id = await unreferenced();
    await db.run(`UPDATE sample SET atlas_id = (SELECT entity_id FROM atlas WHERE code = 'OBA') WHERE entity_id = ${id}`);
    expect(await rows(db, `SELECT atlas_id IS NOT NULL FROM sample WHERE entity_id = ${id}`)).toEqual([[true]]);
  });

  test("one referenced row poisons a bulk update of rows that are not", async () => {
    const free = await unreferenced();
    const held = await referenced();
    await expect(
      db.run(`UPDATE sample SET collector_id = ${ada} WHERE entity_id IN (${free}, ${held})`),
    ).rejects.toThrow(violation);
    // The statement wrote NOTHING — not even the row it was allowed to write.
    // That is the half worth pinning: a partial write would leave a caller
    // that catches the error believing it had changed nothing.
    expect(await collectorOf(free)).toEqual([[bo]]);
    // So the escape is to exclude the referenced row and run it again.
    await db.run(`UPDATE sample SET collector_id = ${ada} WHERE entity_id = ${free}`);
    expect(await collectorOf(free)).toEqual([[ada]]);
  });

  test("atlas is the pair the repo used to describe wrongly", async () => {
    // atlas_region.atlas_id references every atlas row, so the old statement
    // of the rule ("cannot update a row an incoming foreign key references")
    // predicts both of these fail. Only the indexed one does; inat_place_id is
    // BIGINT UNIQUE, name is not — which is the whole correction (schema/010).
    await db.run("UPDATE atlas SET name = 'Oregon Bee Atlas (renamed)' WHERE code = 'OBA'");
    expect(await rows(db, "SELECT name FROM atlas WHERE code = 'OBA'")).toEqual([["Oregon Bee Atlas (renamed)"]]);
    await expect(db.run("UPDATE atlas SET inat_place_id = 10 WHERE code = 'OBA'")).rejects.toThrow(violation);
  });

  test("deleting the child rows first does not help inside a transaction", async () => {
    // The obvious workaround, and it does not work: the foreign key check
    // reads committed state, so a child row deleted in this transaction still
    // counts as referencing. It succeeds only as separate autocommit
    // statements, which means a crash between them leaves a sample with no
    // collectors — so this is not a workaround the store can adopt.
    const id = await referenced();
    await db.run("BEGIN");
    await db.run(`DELETE FROM sample_collector WHERE sample_id = ${id}`);
    await expect(db.run(`UPDATE sample SET collector_id = ${ada} WHERE entity_id = ${id}`)).rejects.toThrow(violation);
    await db.run("ROLLBACK");
    expect(await rows(db, `SELECT count(*) FROM sample_collector WHERE sample_id = ${id}`)).toEqual([[1n]]);
  });
});
