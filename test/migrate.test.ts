import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { appliedMigrations, baseline, migrate, MIGRATIONS_DIR, migrationFiles, pendingMigrations, runCli, schemaDrift } from "../src/migrate.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

let conn: DuckDBConnection;
let dir: string;

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  dir = await mkdtemp(join(tmpdir(), "beeline-migrations-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (name: string, sql: string) => writeFile(join(dir, name), sql);

describe("the migration ledger", () => {
  test("the real migrations directory is what a fresh build stamps", async () => {
    // createMemoryDb applies schema/*.sql only; the CLI's build stamps after.
    expect(await pendingMigrations(conn)).toEqual(await migrationFiles());
    const stamped = await baseline(conn);
    expect(stamped).toEqual(await migrationFiles());
    expect(await pendingMigrations(conn)).toEqual([]);
  });

  test("stamping records a migration without running it", async () => {
    await write("0001-would-fail.sql", "SELECT this_would_not_parse FROM nowhere;");
    await baseline(conn, dir);
    expect([...(await appliedMigrations(conn))]).toContain("0001-would-fail.sql");
  });

  test("a store with no ledger gets one, and migrations run in filename order", async () => {
    await conn.run("DROP TABLE schema_migration");
    await write("0002-second.sql", "CREATE TABLE second (id INTEGER);");
    await write("0001-first.sql", "CREATE TABLE first (id INTEGER);");
    expect(await migrate(conn, { dir })).toEqual(["0001-first.sql", "0002-second.sql"]);
    const order = await rows(conn, "SELECT name FROM schema_migration ORDER BY applied_at, name");
    expect(order.flat()).toEqual(["0001-first.sql", "0002-second.sql"]);
  });

  test("a second run is a no-op", async () => {
    await write("0001-once.sql", "CREATE TABLE once (id INTEGER);");
    expect(await migrate(conn, { dir })).toEqual(["0001-once.sql"]);
    // Re-running the CREATE would throw; it must not be attempted.
    expect(await migrate(conn, { dir })).toEqual([]);
  });

  test("a failing migration rolls back whole, and does not block a fix", async () => {
    await write("0001-broken.sql", "CREATE TABLE half (id INTEGER); CREATE TABLE half (id INTEGER);");
    await expect(migrate(conn, { dir })).rejects.toThrow(/0001-broken\.sql/);
    expect(await rows(conn, `SELECT 1 FROM information_schema.tables WHERE table_name = 'half'`)).toHaveLength(0);
    expect([...(await appliedMigrations(conn))]).not.toContain("0001-broken.sql");

    await write("0001-broken.sql", "CREATE TABLE half (id INTEGER);");
    expect(await migrate(conn, { dir })).toEqual(["0001-broken.sql"]);
  });

  test("a later migration does not run when an earlier one fails", async () => {
    await write("0001-broken.sql", "SELECT this_would_not_parse FROM nowhere;");
    await write("0002-fine.sql", "CREATE TABLE fine (id INTEGER);");
    await expect(migrate(conn, { dir })).rejects.toThrow();
    expect(await rows(conn, `SELECT 1 FROM information_schema.tables WHERE table_name = 'fine'`)).toHaveLength(0);
  });
});

describe("drift against the schema", () => {
  test("a database built from the schema has none", async () => {
    expect(await schemaDrift(conn)).toEqual([]);
  });

  test("a missing view — the forgotten-migration case — is named", async () => {
    await conn.run("DROP VIEW pending_print_sample");
    expect(await schemaDrift(conn)).toEqual(["missing: pending_print_sample"]);
  });

  test("a missing column on a table the schema declares is named", async () => {
    await conn.run("ALTER TABLE job_run DROP COLUMN detail");
    expect(await schemaDrift(conn)).toEqual(["missing: job_run.detail"]);
  });

  test("an extra column on a table the schema declares is named", async () => {
    await conn.run("ALTER TABLE sample ADD COLUMN hand_added TEXT");
    expect(await schemaDrift(conn)).toEqual(["not in the schema: sample.hand_added"]);
  });

  test("a changed comment on a view, a table or a column is named", async () => {
    await conn.run("COMMENT ON VIEW season IS 'stale'");
    await conn.run("COMMENT ON TABLE atlas_region IS 'stale'");
    await conn.run("COMMENT ON COLUMN atlas_region.inat_place_id IS 'stale'");
    expect(await schemaDrift(conn)).toEqual([
      "comment differs: atlas_region",
      "comment differs: atlas_region.inat_place_id",
      "comment differs: season",
    ]);
  });

  test("a view recreated with the same text, or with other text, is not drift: definitions are the test suite's to compare", async () => {
    const [[sql, comment]] = (await rows(conn, "SELECT sql, comment FROM duckdb_views() WHERE view_name = 'season' AND NOT internal")) as [[string, string]];
    const restate = () => conn.run(`COMMENT ON VIEW season IS '${comment.replaceAll("'", "''")}'`);
    await conn.run(String(sql).replace(/^CREATE VIEW/, "CREATE OR REPLACE VIEW"));
    // CREATE OR REPLACE VIEW drops the view's comment, so a migration that replaces a view must restate it.
    expect(await schemaDrift(conn)).toEqual(["comment differs: season"]);
    await restate();
    await conn.run("CREATE OR REPLACE VIEW season AS SELECT 1 AS current_season, DATE '2000-01-01' AS active_since");
    await restate();
    // Same columns, different text: production's stored text depends on the DuckDB that wrote it, so --check leaves it to the suite.
    expect(await schemaDrift(conn)).toEqual([]);
  });

  test("tables the schema never declared are not drift — the pipeline makes those", async () => {
    // A real store also holds the legacy load's staging tables (ingest/*.sql).
    await conn.run("CREATE TABLE legacy_staging_whatever (id INTEGER)");
    expect(await schemaDrift(conn)).toEqual([]);
  });
});


describe("the CLI's flags (beeline-736)", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { log: (l: string) => out.push(l), warn: (l: string) => err.push(l) } };
  };

  test("--check reads: it names what is pending and where the shape drifts, and applies nothing", async () => {
    // A store whose schema drifts AND has a migration pending that would fix
    // it: the old --check would have applied the migration and then reported
    // no drift, answering a question by changing the answer.
    const [[sql, comment]] = (await rows(conn, "SELECT sql, comment FROM duckdb_views() WHERE view_name = 'settled_sample' AND NOT internal")) as [[string, string]];
    await conn.run("DROP VIEW settled_sample");
    await write("0001-restore-view.sql", `${sql}\nCOMMENT ON VIEW settled_sample IS '${String(comment).replaceAll("'", "''")}';`);
    const { out, err, io: t } = io();
    expect(await runCli(conn, new Set(["--check"]), "x.duckdb", t, dir)).toBe(0);
    expect(out).toEqual(["PENDING  0001-restore-view.sql"]);
    expect(err.join("\n")).toMatch(/differs from schema[\s\S]*missing: settled_sample/);
    expect(await pendingMigrations(conn, dir)).toEqual(["0001-restore-view.sql"]);
    expect(await rows(conn, `SELECT 1 FROM information_schema.tables WHERE table_name = 'settled_sample'`)).toHaveLength(0);
  });

  test("--status reads and says nothing about drift", async () => {
    const [[sql, comment]] = (await rows(conn, "SELECT sql, comment FROM duckdb_views() WHERE view_name = 'settled_sample' AND NOT internal")) as [[string, string]];
    await conn.run("DROP VIEW settled_sample");
    await write("0001-restore-view.sql", `${sql}\nCOMMENT ON VIEW settled_sample IS '${String(comment).replaceAll("'", "''")}';`);
    const { out, err, io: t } = io();
    expect(await runCli(conn, new Set(["--status"]), "x.duckdb", t, dir)).toBe(0);
    expect(out).toEqual(["PENDING  0001-restore-view.sql"]);
    expect(err).toEqual([]);
    expect(await pendingMigrations(conn, dir)).toEqual(["0001-restore-view.sql"]);
  });

  test("--status beside --check does not take the drift report away", async () => {
    await conn.run("DROP VIEW settled_sample");
    const { out, err, io: t } = io();
    expect(await runCli(conn, new Set(["--status", "--check"]), "x.duckdb", t, dir)).toBe(0);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/missing: settled_sample/);
  });

  test("migrating applies, then reports; --check afterwards is clean", async () => {
    const [[sql, comment]] = (await rows(conn, "SELECT sql, comment FROM duckdb_views() WHERE view_name = 'settled_sample' AND NOT internal")) as [[string, string]];
    await conn.run("DROP VIEW settled_sample");
    await write("0001-restore-view.sql", `${sql}\nCOMMENT ON VIEW settled_sample IS '${String(comment).replaceAll("'", "''")}';`);
    const first = io();
    expect(await runCli(conn, new Set(), "x.duckdb", first.io, dir)).toBe(0);
    expect(first.out).toEqual(["applied 0001-restore-view.sql"]);
    expect(first.err).toEqual([]);
    const second = io();
    expect(await runCli(conn, new Set(["--check"]), "x.duckdb", second.io, dir)).toBe(0);
    expect(second.out).toEqual(["applied  0001-restore-view.sql", "x.duckdb matches schema/*.sql"]);
  });

  test("--baseline cannot hide behind a read-only flag, and an unknown flag is refused", async () => {
    await write("0001-anything.sql", "SELECT 1;");
    const a = io();
    expect(await runCli(conn, new Set(["--check", "--baseline"]), "x.duckdb", a.io, dir)).toBe(2);
    expect(a.err[0]).toMatch(/--baseline writes the ledger/);
    expect(await pendingMigrations(conn, dir)).toEqual(["0001-anything.sql"]);
    const b = io();
    expect(await runCli(conn, new Set(["--chekc"]), "x.duckdb", b.io, dir)).toBe(2);
    expect(b.err[0]).toMatch(/unknown flag/);
  });
});

// Migrations that touch a referenced table, run against the shape they were
// written for rather than trusted to it. DuckDB will not update an indexed
// column on a row a foreign key references, and until a DROP INDEX commits it
// still treats the column as indexed (duckdb/duckdb#20246), so 0060 and 0061
// are two migrations; as one, this failed on every printed specimen.
describe("emptying specimen.occurrence_id (0060, 0061)", () => {
  test("runs on a store whose minted specimens determinations reference", async () => {
    await conn.run("ALTER TABLE specimen ADD COLUMN occurrence_id TEXT");
    await conn.run("CREATE UNIQUE INDEX specimen_occurrence_id_idx ON specimen (occurrence_id)");
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    const sampleId = await insertCleanSample(conn);
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number, occurrence_id)
                    VALUES (${sampleId}, 1, '26000001', '0192f2a0-0000-7000-8000-000000000001')`);
    await conn.run(`INSERT INTO animal (rank, scientific_name) VALUES ('genus', 'Bombus')`);
    await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, verbatim_identification)
                    SELECT sp.entity_id, a.entity_id, false, 'in_app', 'Bombus' FROM specimen sp, animal a WHERE a.scientific_name = 'Bombus'`);
    for (const name of ["0060-no-minted-occurrence-id.sql", "0061-empty-occurrence-id.sql"]) {
      await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
    }
    expect(await migrate(conn, { dir })).toEqual(["0060-no-minted-occurrence-id.sql", "0061-empty-occurrence-id.sql"]);
    expect(await rows(conn, "SELECT occurrence_id FROM specimen")).toEqual([[null]]);
    expect(await schemaDrift(conn)).toEqual(["not in the schema: specimen.occurrence_id"]);
  });
});

describe("removing the Oklahoma Bee Atlas (0071)", () => {
  test("runs on a store whose samples, members and leads name it", async () => {
    // The shape the migration was written for: the program row, Oklahoma's
    // region pointing at it, and every kind of row that references it.
    // 0113 dropped this table, so the store built from today's schema lacks
    // it; put it back, as 0071 found it.
    await conn.run(`CREATE TABLE atlas_taxon_obscured_printing (
      atlas_id INTEGER PRIMARY KEY REFERENCES program(entity_id),
      decided_by TEXT NOT NULL, decided_on DATE NOT NULL, source TEXT NOT NULL)`);
    await conn.run("INSERT INTO program (code, name) VALUES ('OK', 'Oklahoma Bee Atlas')");
    await conn.run(
      "UPDATE atlas_region SET atlas_id = (SELECT entity_id FROM program WHERE code = 'OK') WHERE state_province = 'OK'",
    );
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    const sampleId = await insertCleanSample(conn, {
      state_province: "'OK'",
      atlas_id: "(SELECT entity_id FROM program WHERE code = 'OK')",
    });
    await conn.run(`INSERT INTO person_membership (person_id, program_id)
                    SELECT min(p.entity_id), (SELECT entity_id FROM program WHERE code = 'OK') FROM person p`);
    await conn.run(`INSERT INTO program_lead (program_id, person_id)
                    SELECT (SELECT entity_id FROM program WHERE code = 'OK'), min(p.entity_id) FROM person p`);

    // Two migrations, because DuckDB will not delete the program row in the
    // transaction that removed the rows referencing it.
    const names = ["0071-nothing-names-the-oklahoma-bee-atlas.sql", "0072-there-is-no-oklahoma-bee-atlas.sql"];
    for (const name of names) await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
    expect(await migrate(conn, { dir })).toEqual(names);

    expect(await rows(conn, "SELECT count(*) FROM program WHERE code = 'OK'")).toEqual([[0n]]);
    expect(await rows(conn, "SELECT atlas_id FROM atlas_region WHERE state_province = 'OK'")).toEqual([[null]]);
    expect(await rows(conn, `SELECT count(*) FROM sample_atlas WHERE sample_id = ${sampleId}`)).toEqual([[0n]]);
    expect(
      await rows(conn, "SELECT p.code FROM person_membership m JOIN program p ON p.entity_id = m.program_id"),
    ).toEqual([["MM"]]);
    expect(await rows(conn, "SELECT count(*) FROM program_lead")).toEqual([[0n]]);
    expect(await schemaDrift(conn)).toEqual([]);
  });
});

describe("removing the rare host plant rule (0113, 0114)", () => {
  const RULE = "taxon_obscured_awaiting_atlas";
  const viewSql = async (c: DuckDBConnection, name: string) =>
    rows(c, `SELECT sql FROM duckdb_views() WHERE view_name = '${name}' AND NOT internal`);
  const comments = async (c: DuckDBConnection) => [
    await rows(c, "SELECT comment FROM duckdb_columns() WHERE table_name = 'sample' AND column_name = 'taxon_geoprivacy'"),
    await rows(c, "SELECT comment FROM duckdb_tables() WHERE table_name = 'sample_location'"),
    await rows(c, "SELECT comment FROM duckdb_views() WHERE view_name = 'printable_reprint'"),
  ];

  test("takes the rule, its table, its stored rows and its comments out of a store that has them", async () => {
    const { conn: fresh } = await createMemoryDb();

    // Put back what the schema no longer has: the table of atlases' answers
    // (Oregon's row only), the rule's rows, its view as schema/120 had it, the
    // union that reads the view, and the comments 0113 rewrites.
    await conn.run(`CREATE TABLE atlas_taxon_obscured_printing (
      atlas_id INTEGER PRIMARY KEY REFERENCES program(entity_id),
      decided_by TEXT NOT NULL, decided_on DATE NOT NULL, source TEXT NOT NULL)`);
    await conn.run(`INSERT INTO atlas_taxon_obscured_printing
                    SELECT entity_id, 'Arthur Schrenk', DATE '2026-10-21', 'https://example.org' FROM program WHERE code = 'OBA'`);
    await conn.run(`INSERT INTO qc_rule (name, severity) VALUES ('${RULE}', 'blocking')`);
    await conn.run(`INSERT INTO qc_rule_unwaivable (name) VALUES ('${RULE}')`);
    await conn.run(`CREATE VIEW qc_rule_taxon_obscured_awaiting_atlas AS
      SELECT s.entity_id AS sample_id,
             CAST(NULL AS INTEGER) AS specimen_id,
             'taxon_obscured_awaiting_atlas' AS rule_name,
             concat('taxon_geoprivacy=', s.taxon_geoprivacy, ', atlas=', coalesce(a.code, 'none')) AS details
      FROM sample s
      JOIN sample_location loc ON loc.sample_id = s.entity_id
      LEFT JOIN sample_atlas sa ON sa.sample_id = s.entity_id
      LEFT JOIN program a ON a.entity_id = sa.atlas_id
      WHERE s.taxon_geoprivacy IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM atlas_taxon_obscured_printing ok WHERE ok.atlas_id = sa.atlas_id)`);
    await conn.run(`CREATE OR REPLACE VIEW qc_finding AS
SELECT sample_id, specimen_id, rule_name, details,
       CAST(NULL AS TEXT) AS detail_taxon_name,
       CAST(NULL AS TEXT) AS detail_taxon_rank
FROM (
  SELECT * FROM qc_rule_missing_required_field
  UNION ALL SELECT * FROM qc_rule_missing_recommended_field
  UNION ALL SELECT * FROM qc_rule_obscured_no_true_coordinates
  UNION ALL SELECT * FROM qc_rule_taxon_obscured_awaiting_atlas
  UNION ALL SELECT * FROM qc_rule_locality_format
  UNION ALL SELECT * FROM qc_rule_place_unabbreviated
  UNION ALL SELECT * FROM qc_rule_place_unrecognised
  UNION ALL SELECT * FROM qc_rule_coordinate_uncertainty
  UNION ALL SELECT * FROM qc_rule_coordinate_out_of_region
  UNION ALL SELECT * FROM qc_rule_sample_number
  UNION ALL SELECT * FROM qc_rule_count_mismatch
  UNION ALL SELECT * FROM qc_rule_count_below_printed
  UNION ALL SELECT * FROM qc_rule_observation_missing_upstream
  UNION ALL SELECT * FROM qc_rule_staff_hold
  -- Stored ingestion-time findings join the derived ones (schema/050).
  UNION ALL SELECT sample_id, CAST(NULL AS INTEGER) AS specimen_id, rule_name, details
  FROM sample_promotion_finding
) prose
UNION ALL SELECT * FROM qc_rule_non_tracheophyte_host;`);
    await conn.run("COMMENT ON COLUMN sample.taxon_geoprivacy IS 'old'");
    await conn.run("COMMENT ON TABLE sample_location IS 'old'");
    await conn.run("COMMENT ON VIEW printable_reprint IS 'old'");

    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    // A taxon-obscured sample with a true point, in no atlas: the old view finds it.
    const sampleId = await insertCleanSample(conn, { taxon_geoprivacy: "'obscured'" });
    await conn.run(`INSERT INTO sample_promotion_finding (sample_id, rule_name, details) VALUES (${sampleId}, '${RULE}', 'x')`);
    await conn.run(`INSERT INTO sample_qc_waiver (sample_id, rule_name, finding, reason, in_force)
                    VALUES (${sampleId}, '${RULE}', 'x', 'because', true)`);
    expect(await rows(conn, `SELECT count(*) FROM qc_finding WHERE rule_name = '${RULE}'`)).toEqual([[2n]]);
    expect(await rows(conn, "SELECT count(*) FROM sample_qc_waiver")).toEqual([[1n]]);
    expect(await rows(conn, "SELECT count(*) FROM sample_promotion_finding")).toEqual([[1n]]);

    const names = ["0113-a-rare-host-plant-does-not-stop-printing.sql", "0114-the-rare-host-plant-rule-is-gone.sql"];
    for (const name of names) await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
    expect(await migrate(conn, { dir })).toEqual(names);

    expect(
      await rows(conn, `SELECT table_name FROM information_schema.tables
                        WHERE table_name IN ('atlas_taxon_obscured_printing', 'qc_rule_taxon_obscured_awaiting_atlas')`),
    ).toEqual([]);
    for (const table of ["qc_rule", "qc_rule_unwaivable", "sample_qc_waiver", "sample_promotion_finding"]) {
      const column = table === "qc_rule" || table === "qc_rule_unwaivable" ? "name" : "rule_name";
      expect(await rows(conn, `SELECT count(*) FROM ${table} WHERE ${column} = '${RULE}'`)).toEqual([[0n]]);
    }
    // The union as 0113 leaves it: without the rule 0129 adds later (observation_date_differs), which this store has not had.
    const withoutLaterRule = (await viewSql(fresh, "qc_finding")).map(([sql]) => [String(sql).replace(/\s*UNION ALL \(SELECT \* FROM qc_rule_observation_date_differs\)/, "")]);
    expect(await viewSql(conn, "qc_finding")).toEqual(withoutLaterRule);
    expect(await comments(conn)).toEqual(await comments(fresh));
    expect(await schemaDrift(conn)).toEqual([]);
  });
});

describe("a floral host staff set (0115)", () => {
  const NEW_VIEWS = ["sample_host_override_stale", "sample_host_override_diverged"];
  const viewSql = (c: DuckDBConnection, name: string) =>
    rows(c, `SELECT sql, comment FROM duckdb_views() WHERE view_name = '${name}' AND NOT internal`);
  const tableShape = async (c: DuckDBConnection) => [
    await rows(c, `SELECT column_name, data_type, is_nullable, comment FROM duckdb_columns() WHERE table_name = 'sample_host_override' ORDER BY column_index`),
    await rows(c, `SELECT comment FROM duckdb_tables() WHERE table_name = 'sample_host_override'`),
    await rows(c, `SELECT constraint_type, constraint_text FROM duckdb_constraints() WHERE table_name = 'sample_host_override' ORDER BY constraint_type, constraint_text`),
  ];
  const comments = async (c: DuckDBConnection) => [
    await rows(c, "SELECT comment FROM duckdb_columns() WHERE table_name = 'sample' AND column_name = 'host_inat_taxon_id'"),
    await rows(c, "SELECT comment FROM duckdb_columns() WHERE table_name = 'sample_host' AND column_name = 'resolved_by'"),
  ];

  test("adds the table, the two views and the rule's new reading to a store that lacks them, and the comments say what the schema's do", async () => {
    const { conn: fresh } = await createMemoryDb();

    // Put the store back as it stood before: no table, no views, the rule reading the observation alone and the two old comments.
    for (const view of NEW_VIEWS) await conn.run(`DROP VIEW ${view}`);
    await conn.run("DROP TABLE sample_host_override");
    await conn.run(`CREATE OR REPLACE VIEW qc_rule_non_tracheophyte_host AS
SELECT s.entity_id AS sample_id,
       CAST(NULL AS INTEGER) AS specimen_id,
       'non_tracheophyte_host' AS rule_name,
       CASE WHEN f.host_taxon_name IS NULL
            THEN concat('observation taxon ', CAST(f.host_taxon_id AS TEXT), ' is not a vascular plant')
       END AS details,
       f.host_taxon_name AS detail_taxon_name,
       f.host_taxon_rank AS detail_taxon_rank
FROM sample s
JOIN observation_host f ON f.inat_id = s.inat_observation_id
WHERE f.host_is_tracheophyte IS FALSE`);
    await conn.run("COMMENT ON COLUMN sample.host_inat_taxon_id IS 'old'");
    await conn.run("COMMENT ON COLUMN sample_host.resolved_by IS 'old'");
    expect(await schemaDrift(conn)).toContain("missing: sample_host_override");

    // The rule as it stood still finds a bee, and a row of the old store is not disturbed.
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    const sampleId = await insertCleanSample(conn, { inat_observation_id: "7", host_inat_taxon_id: "47219", host_name_as_observed: "'Apis mellifera'", host_rank: "'species'" });
    await conn.run(`INSERT INTO observation_field (inat_id, user_id, host_taxon_id, host_taxon_name, host_taxon_rank, host_is_tracheophyte)
                    VALUES (7, 1, 47219, 'Apis mellifera', 'species', false)`);
    expect(await rows(conn, `SELECT count(*) FROM qc_finding WHERE rule_name = 'non_tracheophyte_host' AND sample_id = ${sampleId}`)).toEqual([[1n]]);

    const name = "0115-a-floral-host-staff-set.sql";
    await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
    expect(await migrate(conn, { dir })).toEqual([name]);

    // The migrated store equals one built from schema/, comments and constraints included, not only by name.
    expect(await tableShape(conn)).toEqual(await tableShape(fresh));
    for (const view of [...NEW_VIEWS, "qc_rule_non_tracheophyte_host", "qc_finding"]) {
      expect(await viewSql(conn, view), view).toEqual(await viewSql(fresh, view));
    }
    expect(await comments(conn)).toEqual(await comments(fresh));
    expect(await schemaDrift(conn)).toEqual([]);

    // And it works: the rule still finds the bee until staff name a host, and the table refuses a blank reason.
    expect(await rows(conn, `SELECT count(*) FROM qc_finding WHERE rule_name = 'non_tracheophyte_host' AND sample_id = ${sampleId}`)).toEqual([[1n]]);
    await conn.run(`INSERT INTO sample_host_override (sample_id, reason) VALUES (${sampleId}, 'a bee off the road')`);
    expect(await rows(conn, `SELECT count(*) FROM qc_finding WHERE rule_name = 'non_tracheophyte_host' AND sample_id = ${sampleId}`)).toEqual([[0n]]);
    const second = await insertCleanSample(conn, { sample_number: "'2'" });
    await expect(conn.run(`INSERT INTO sample_host_override (sample_id, reason) VALUES (${second}, '')`)).rejects.toThrow(/CHECK/i);
  });
});

describe("abbreviating each program (0089)", () => {
  test("gives every program its code as its abbreviation, and Washington WABA, on a store whose Washington row is referenced", async () => {
    // The table arrives with the schema; take it away to stand for a store
    // from before the migration. Nothing refers to it, so it can go.
    await conn.run("DROP TABLE program_abbreviation");
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    await insertCleanSample(conn, { state_province: "'WA'", atlas_id: "(SELECT entity_id FROM program WHERE code = 'WaBA')" });

    const name = "0089-program-abbreviation.sql";
    await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
    expect(await migrate(conn, { dir })).toEqual([name]);

    expect(
      await rows(conn, "SELECT p.code, a.abbreviation FROM program p JOIN program_abbreviation a ON a.program_id = p.entity_id WHERE p.code IN ('OBA', 'WaBA', 'MM') ORDER BY p.code"),
    ).toEqual([
      ["MM", "MM"],
      ["OBA", "OBA"],
      ["WaBA", "WABA"],
    ]);
    expect(await rows(conn, "SELECT count(*) FROM program p LEFT JOIN program_abbreviation a ON a.program_id = p.entity_id WHERE a.program_id IS NULL")).toEqual([[0n]]);
    // 0118 restated these two comments for British Columbia, and 0089 alone
    // predates it: they are the only drift.
    expect(await schemaDrift(conn)).toEqual(["comment differs: program_abbreviation", "comment differs: program_abbreviation.abbreviation"]);
    // The point of the satellite: unlike the code, it can be changed on a referenced program.
    await conn.run("UPDATE program_abbreviation SET abbreviation = 'WA' WHERE abbreviation = 'WABA'");
  });
});

describe("British Columbia's abbreviation (0118)", () => {
  test("changes BC to BCBA on a store that has samples of the program, and nothing else", async () => {
    // A store from before the migration says BC; a sample refers to the program.
    await conn.run("UPDATE program_abbreviation SET abbreviation = 'BC' WHERE abbreviation = 'BCBA'");
    await conn.run("INSERT INTO person (display_name) VALUES ('Ada Collector')");
    await insertCleanSample(conn, { state_province: "'BC'", atlas_id: "(SELECT entity_id FROM program WHERE code = 'BC')" });

    const name = "0118-british-columbia-abbreviation.sql";
    await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
    expect(await migrate(conn, { dir })).toEqual([name]);

    expect(await rows(conn, "SELECT p.code, a.abbreviation FROM program p JOIN program_abbreviation a ON a.program_id = p.entity_id WHERE a.abbreviation <> p.code ORDER BY p.code")).toEqual([
      ["BC", "BCBA"],
      ["WaBA", "WABA"],
    ]);
    expect(await rows(conn, "SELECT code FROM program WHERE code = 'BC'")).toEqual([["BC"]]);
    expect(await schemaDrift(conn)).toEqual([]);
  });
});

describe("the atlas_region comments (0121)", () => {
  test("restates the table's and inat_place_id's comments as the schema has them, and nothing else", async () => {
    const { conn: fresh } = await createMemoryDb();
    const comments = (c: DuckDBConnection) => rows(c, `SELECT comment FROM duckdb_tables() WHERE table_name = 'atlas_region'
      UNION ALL SELECT comment FROM duckdb_columns() WHERE table_name = 'atlas_region' AND column_name = 'inat_place_id'`);
    // Production's wording, from before the atlases grew past six.
    await conn.run("COMMENT ON TABLE atlas_region IS 'listing only the six would make every other real place look like a typo.'");
    await conn.run("COMMENT ON COLUMN atlas_region.inat_place_id IS 'the six atlases'' included.'");
    expect(await comments(conn)).not.toEqual(await comments(fresh));
    expect(await schemaDrift(conn)).toContain("comment differs: atlas_region");

    const name = "0121-atlas-region-comments.sql";
    await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
    expect(await migrate(conn, { dir })).toEqual([name]);

    expect(await comments(conn)).toEqual(await comments(fresh));
    expect(await schemaDrift(conn)).toEqual([]);
  });
});
