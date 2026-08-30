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
      conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end)
                VALUES ('bucket', '1', DATE '2026-07-01', DATE '2026-07-01')`),
    ).rejects.toThrow(/CHECK/i);
  });

  test("date range must not run backwards", async () => {
    await expect(
      conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end)
                VALUES ('trap', 'OBAS-00001', DATE '2026-07-14', DATE '2026-07-01')`),
    ).rejects.toThrow(/CHECK/i);
  });

  test("negative specimen counts are rejected at the boundary", async () => {
    await expect(
      conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end, specimen_count)
                VALUES ('net', '1', DATE '2026-07-01', DATE '2026-07-01', -5)`),
    ).rejects.toThrow(/CHECK/i);
  });

  test("an elevation never arrives without provenance", async () => {
    await conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end)
                    VALUES ('net', '9', DATE '2026-07-01', DATE '2026-07-01')`);
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

  test("a collector list with no head, or two, is caught by the view the primary key cannot be", async () => {
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
    const sample = async (number: string) => {
      const [[id]] = (await rows(
        conn,
        `INSERT INTO sample (kind, sample_number, date_start, date_end)
         VALUES ('net', '${number}', DATE '2026-07-01', DATE '2026-07-01') RETURNING entity_id`,
      )) as [[number]];
      return id;
    };

    // 0 — collectors recorded, but none of them at the head of the list.
    // Such a sample is invisible to "my samples" and attribution, and since
    // beeline-6e9 dropped sample.collector_id there is no second copy to
    // answer from.
    const headless = await sample("c0");
    await conn.run(`INSERT INTO sample_collector (sample_id, person_id, position) VALUES (${headless}, ${ada}, 2)`);
    // 0 in a worse way — no collector rows at all, which NOT NULL used to
    // forbid at the sample and now nothing but this view can see.
    const bare = await sample("c1");
    // 2+ — two collectors both at position 1, which the primary key
    // (sample_id, person_id) does nothing to stop, and which fans every
    // primary-collector join out.
    const twoHeads = await sample("c2");
    await conn.run(
      `INSERT INTO sample_collector (sample_id, person_id, position)
       VALUES (${twoHeads}, ${ada}, 1), (${twoHeads}, ${bo}, 1)`,
    );
    // And one that is simply right, to prove the view is not just true.
    const correct = await sample("c3");
    await conn.run(
      `INSERT INTO sample_collector (sample_id, person_id, position)
       VALUES (${correct}, ${ada}, 1), (${correct}, ${bo}, 2)`,
    );

    expect(
      await rows(conn, "SELECT sample_id, at_position_1 FROM sample_primary_collector_invalid ORDER BY sample_id"),
    ).toEqual([
      [headless, 0],
      [bare, 0],
      [twoHeads, 2],
    ]);
    // The head view is the flip side: exactly the well-formed samples.
    expect(
      await rows(conn, `SELECT person_id FROM sample_primary_collector WHERE sample_id = ${correct}`),
    ).toEqual([[ada]]);
  });

  test("a qualifier below species rank is caught by the view a CHECK cannot be", async () => {
    // The rule spans two tables — "species or finer" is a fact about
    // animal_rank — so the engine cannot hold it and the view does
    // (schema/115). Nothing produces this today; the determination UI will be
    // the first writer that can (beeline-tgu).
    expect(await rows(conn, "SELECT entity_id FROM determination_misplaced_qualifier")).toEqual([]);

    await conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end)
                    VALUES ('net', 'q1', DATE '2026-07-01', DATE '2026-07-01')`);
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
    await conn.run(`INSERT INTO sample (kind, sample_number, date_start, date_end, specimen_count)
                    VALUES ('net', '1', DATE '2025-08-17', DATE '2025-08-17', 2)`);
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
    expect(Number(n)).toBe(14);
  });
});

/**
 * What DuckDB 1.5.5 will and will not let an UPDATE write, pinned so that the
 * day it changes is a day something tells us (beeline-6e9, upstream
 * duckdb/duckdb#20246).
 *
 * The rule as measured: DuckDB refuses an UPDATE that writes an INDEXED
 * column of a row an incoming foreign key currently references. The update is
 * a delete-and-insert, and the delete trips the inbound check. Both halves
 * are necessary and neither alone is sufficient, which is what these tests
 * separate.
 *
 * This used to be the reason a sample's atlas and collector could not be
 * changed. The fix was to stop keeping either as an indexed column on a
 * referenced row — the atlas moved to the sample_atlas satellite and the
 * collector is sample_collector position 1, neither of which anything
 * references — so the pin now runs on a scratch pair shaped like the old
 * problem. It still matters live in one place: atlas.inat_place_id is UNIQUE
 * and atlas_region references every atlas row, which the last test keeps
 * honest.
 */
describe("updating a row an incoming foreign key references", () => {
  let db: DuckDBConnection;

  beforeAll(async () => {
    ({ conn: db } = await createMemoryDb());
    // The shape sample used to have: an indexed column (the FK to person
    // makes owner_id indexed), an unindexed one, and a child table pointing
    // at every row a promotion would produce.
    await db.run(`
      CREATE TABLE pin_parent (
        id       INTEGER PRIMARY KEY,
        owner_id INTEGER REFERENCES person(entity_id),
        note     TEXT
      );
      CREATE TABLE pin_child (
        parent_id INTEGER NOT NULL REFERENCES pin_parent(id)
      );
    `);
    await db.run(
      `INSERT INTO person (display_name) VALUES ('Ada Collector'), ('Bo Collector')`,
    );
  });

  const ada = "(SELECT min(entity_id) FROM person)";
  const bo = "(SELECT max(entity_id) FROM person)";
  let nextId = 0;
  /** A parent row with a child pointing at it — every sample in a real store. */
  const referenced = async () => {
    const id = ++nextId;
    await db.run(`INSERT INTO pin_parent (id, owner_id) VALUES (${id}, ${bo})`);
    await db.run(`INSERT INTO pin_child (parent_id) VALUES (${id})`);
    return id;
  };
  /** A parent row nothing points at. Bo owns it, so writing Ada onto it is a
   *  real change: a no-op update cannot tell "refused" from "wrote what was
   *  already there" (CodeRabbit on PR #26). */
  const unreferenced = async () => {
    const id = ++nextId;
    await db.run(`INSERT INTO pin_parent (id, owner_id) VALUES (${id}, ${bo})`);
    return id;
  };
  const ownerOf = (id: number) =>
    rows(db, `SELECT p.display_name FROM pin_parent t JOIN person p ON p.entity_id = t.owner_id WHERE t.id = ${id}`);
  const violation = /still referenced by a foreign key/;

  test("an unindexed column is writable — which is what the descriptive refresh rides on", async () => {
    const id = await referenced();
    await db.run(`UPDATE pin_parent SET note = 'Alsea' WHERE id = ${id}`);
    expect(await rows(db, `SELECT note FROM pin_parent WHERE id = ${id}`)).toEqual([["Alsea"]]);
  });

  test("an indexed column is not — the shape that froze a sample's atlas and collector", async () => {
    const id = await referenced();
    await expect(db.run(`UPDATE pin_parent SET owner_id = ${ada} WHERE id = ${id}`)).rejects.toThrow(violation);
  });

  test("writing the value the column already holds fails too", async () => {
    // So it is the statement that is refused, not the change: an UPDATE that
    // would be a no-op cannot be used to prove the row is already correct.
    const id = await referenced();
    await expect(
      db.run(`UPDATE pin_parent SET owner_id = owner_id WHERE id = ${id}`),
    ).rejects.toThrow(violation);
  });

  test("the same write succeeds on a row nothing references", async () => {
    // The index alone is not the problem — which is why a mutable indexed
    // column is safe on a satellite table nothing points at, and is the whole
    // licence for sample_atlas and for updating sample_collector.person_id.
    const id = await unreferenced();
    await db.run(`UPDATE pin_parent SET owner_id = ${ada} WHERE id = ${id}`);
    expect(await ownerOf(id)).toEqual([["Ada Collector"]]);
  });

  test("one referenced row poisons a bulk update of rows that are not", async () => {
    const free = await unreferenced();
    const held = await referenced();
    await expect(
      db.run(`UPDATE pin_parent SET owner_id = ${ada} WHERE id IN (${free}, ${held})`),
    ).rejects.toThrow(violation);
    // The statement wrote NOTHING — not even the row it was allowed to write.
    // That is the half worth pinning: a partial write would leave a caller
    // that catches the error believing it had changed nothing.
    expect(await ownerOf(free)).toEqual([["Bo Collector"]]);
    // So the escape is to exclude the referenced row and run it again.
    await db.run(`UPDATE pin_parent SET owner_id = ${ada} WHERE id = ${free}`);
    expect(await ownerOf(free)).toEqual([["Ada Collector"]]);
  });

  test("atlas is the live pair this still constrains", async () => {
    // atlas_region.atlas_id references every atlas row, and inat_place_id is
    // BIGINT UNIQUE where name is not — so the name is writable and the place
    // id is frozen, which is why schema/010 leaves it null.
    await db.run("UPDATE atlas SET name = 'Oregon Bee Atlas (renamed)' WHERE code = 'OBA'");
    expect(await rows(db, "SELECT name FROM atlas WHERE code = 'OBA'")).toEqual([["Oregon Bee Atlas (renamed)"]]);
    await expect(db.run("UPDATE atlas SET inat_place_id = 10 WHERE code = 'OBA'")).rejects.toThrow(violation);
  });

  test("deleting the child rows first does not help inside a transaction", async () => {
    // The obvious workaround, and it does not work: the foreign key check
    // reads committed state, so a child row deleted in this transaction still
    // counts as referencing. It succeeds only as separate autocommit
    // statements, which means a crash between them leaves orphaned state —
    // so this is not a workaround the store can adopt, and satellites are.
    const id = await referenced();
    await db.run("BEGIN");
    await db.run(`DELETE FROM pin_child WHERE parent_id = ${id}`);
    await expect(db.run(`UPDATE pin_parent SET owner_id = ${ada} WHERE id = ${id}`)).rejects.toThrow(violation);
    await db.run("ROLLBACK");
    expect(await rows(db, `SELECT count(*) FROM pin_child WHERE parent_id = ${id}`)).toEqual([[1n]]);
  });
});
