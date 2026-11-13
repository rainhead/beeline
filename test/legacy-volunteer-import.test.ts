import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { configFromEnv } from "../src/app/config.js";
import { buildJobs } from "../src/app/jobs/registry.js";
import { legacyCopyId, type OldBeelineCredentials } from "../src/legacy-copy.js";
import {
  describeVolunteerImport,
  readOldVolunteerRecords,
  recordOldVolunteerDeterminations,
  volunteerTargetSql,
} from "../src/legacy-volunteer-import.js";
import { FakeOldBeeline } from "./fake-old-beeline.js";
import { insertCleanSample, rows } from "./helpers.js";
import { promotedStore } from "./promoted-store.js";

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;
/** Every distinct combination of the five volunteer columns in the old system's pull of 3 November 2026. */
const VOLUNTEER_COLUMNS = new URL("./fixtures/legacy-volunteer-columns.csv", import.meta.url).pathname;

let old: FakeOldBeeline;
let creds: OldBeelineCredentials;
let conn: DuckDBConnection;
/** The newest determination a test may leave behind: each test's own are removed after it. */
let baseline: number;

const newestDetermination = async () =>
  Number(((await rows(conn, `SELECT coalesce(max(entity_id), 0) FROM determination`)) as [[number]])[0][0]);

// One promotion for the file, since one takes seconds; each test's
// determinations and aliases are undone after it instead.
beforeAll(async () => {
  old = new FakeOldBeeline();
  creds = await old.start();
  ({ conn } = await promotedStore("occurrences"));
  baseline = await newestDetermination();
});

beforeEach(oldSystemAsStaged);

afterEach(async () => {
  await conn.run(`DELETE FROM determination WHERE entity_id > ${baseline}`);
  await conn.run(`DELETE FROM legacy_taxon_alias`);
});

afterAll(() => old.server.close());

/** The old system as promotion read it: every fixture record, as staged. */
async function oldSystemAsStaged(): Promise<void> {
  old.records.clear();
  for (const line of (await readFile(FIXTURE, "utf8")).split("\n").filter(Boolean)) {
    const r = JSON.parse(line) as Record<string, unknown> & { _id: string };
    old.records.set(r._id, r);
  }
  old.reads = [];
}

const tonight = async (opts: { dryRun?: boolean; clearedLimit?: number } = {}) =>
  recordOldVolunteerDeterminations(conn, await readOldVolunteerRecords(creds), opts);

const specimenOf = async (fieldNumber: string): Promise<number> =>
  ((await rows(conn, `SELECT entity_id FROM specimen WHERE field_number = '${fieldNumber}'`)) as [[number]])[0][0];

/** The volunteer determinations of a specimen, oldest first, as (taxon, sex, caste, channel, determiner). */
const volunteerDets = (specimenId: number) =>
  rows(
    conn,
    `SELECT a.scientific_name, d.sex, d.caste, d.channel, p.display_name
     FROM determination d JOIN animal a ON a.entity_id = d.animal_id LEFT JOIN person p ON p.entity_id = d.determiner_id
     WHERE d.specimen_id = ${specimenId} AND NOT d.is_expert ORDER BY d.recorded_at, d.entity_id`,
  );

const set = (id: string, fields: Record<string, string>) => Object.assign(old.records.get(id)!, fields);

describe("taking in the determinations volunteers enter in the old Beeline", () => {
  test("the records promotion read, read again unchanged, record nothing", async () => {
    const r = await tonight();
    expect(r).toMatchObject({ read: 2, recorded: 0, unchanged: 2, beelineOwn: 0, notInBeeline: [], unresolved: [], conflicting: [], cleared: [] });
  });

  test("reads only the records naming a taxon, in three selections that do not overlap", async () => {
    // A sex alone cannot be a determination, so a record naming only one is not read.
    old.records.set("sexonly1", { _id: "sexonly1", fieldNumber: "25000077", sexVolDet: "female" });
    set("bbbb2222", { familyVolDet: "", genusVolDet: "Bombus" });
    const records = await readOldVolunteerRecords(creds);
    expect(records.map((r) => r.id).sort()).toEqual(["bbbb2222", "eeee5555"]);
    expect(old.reads.map((q) => new URLSearchParams(q)).map((p) => [p.get("familyVolDet"), p.get("genusVolDet"), p.get("speciesVolDet")])).toEqual([
      ["(non-empty)", null, null],
      ["(empty)", "(non-empty)", null],
      ["(empty)", "(empty)", "(non-empty)"],
    ]);
  });

  test("a volunteer's change is recorded as the collector's, on the old system's channel, and only once", async () => {
    set("bbbb2222", { speciesVolDet: "vosnesenskii" });
    const dry = await tonight({ dryRun: true });
    expect(dry).toMatchObject({ recorded: 1, dryRun: true });
    expect(describeVolunteerImport(dry)).toContain("1 would be recorded as new");
    const specimen = await specimenOf("25000002");
    expect(await volunteerDets(specimen)).toHaveLength(1);

    expect(await tonight()).toMatchObject({ recorded: 1, unchanged: 1 });
    expect(await volunteerDets(specimen)).toEqual([
      ["Bombus", "female", null, "legacy_import", "Bea Trapper"],
      ["Bombus vosnesenskii", "female", null, "legacy_import", "Bea Trapper"],
    ]);
    expect(await tonight()).toMatchObject({ recorded: 0, unchanged: 2 });
  });

  test("a change of sex alone is a change, read by promotion's words", async () => {
    set("bbbb2222", { sexVolDet: "Male" });
    expect(await tonight()).toMatchObject({ recorded: 1 });
    expect((await volunteerDets(await specimenOf("25000002"))).at(-1)).toEqual(["Bombus", "male", null, "legacy_import", "Bea Trapper"]);
  });

  test("a misspelling is read through the curated aliases, and the spelling kept", async () => {
    // ingest/taxon-aliases.csv is not the fixture's, so the alias is added here.
    await conn.run(`INSERT INTO legacy_taxon_alias VALUES ('genus', 'Lassioglossum', 'Lasioglossum', 'spelling')`);
    set("bbbb2222", { familyVolDet: "Halictidae", genusVolDet: "Lassioglossum", speciesVolDet: "titusi", sexVolDet: "female" });
    expect(await tonight()).toMatchObject({ recorded: 1 });
    expect(
      await rows(
        conn,
        `SELECT a.scientific_name, d.verbatim_identification FROM determination d JOIN animal a ON a.entity_id = d.animal_id
         WHERE d.specimen_id = ${await specimenOf("25000002")} AND NOT d.is_expert ORDER BY d.recorded_at DESC, d.entity_id DESC LIMIT 1`,
      ),
    ).toEqual([["Lasioglossum titusi", "Lassioglossum titusi"]]);
  });

  test("a determination made since in this Beeline is not overruled by the old record, which still says what it said", async () => {
    const specimen = await specimenOf("25000002");
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, verbatim_identification, sex, determiner_id, is_expert, channel)
       SELECT ${specimen}, a.entity_id, 'Lasioglossum', 'female', (SELECT determiner_id FROM determination WHERE specimen_id = ${specimen} AND NOT is_expert), false, 'in_app'
       FROM animal a WHERE a.scientific_name = 'Lasioglossum' AND a.rank = 'genus'`,
    );
    expect(await tonight()).toMatchObject({ recorded: 0, unchanged: 2 });
    expect((await volunteerDets(specimen)).at(-1)?.[0]).toBe("Lasioglossum");
  });

  test("a name Beeline lacks is listed and not recorded", async () => {
    set("bbbb2222", { genusVolDet: "Xylocopa" });
    const r = await tonight();
    expect(r).toMatchObject({ recorded: 0, unresolved: [{ name: "Xylocopa", records: 1 }] });
    expect(describeVolunteerImport(r)).toContain("1 name a taxon Beeline lacks: Xylocopa (1)");
  });

  test("a record promotion did not take is listed by its field number", async () => {
    old.records.set("zzzz9999", { _id: "zzzz9999", fieldNumber: "25000099", familyVolDet: "Apidae" });
    expect(await tonight()).toMatchObject({ recorded: 0, notInBeeline: ["25000099"] });
  });

  test("a determination cleared there is listed, since no determination can say so", async () => {
    set("bbbb2222", { familyVolDet: "", genusVolDet: "", sexVolDet: "" });
    const r = await tonight();
    expect(r).toMatchObject({ recorded: 0, cleared: ["25000002"] });
    expect(describeVolunteerImport(r)).toContain("1 specimen(s) no longer have one there");
  });

  test("a night on which too many have vanished is taken for the old system answering wrongly: it records nothing and fails", async () => {
    set("bbbb2222", { familyVolDet: "", genusVolDet: "" });
    set("eeee5555", { speciesVolDet: "vosnesenskii" });
    await expect(tonight({ clearedLimit: 0 })).rejects.toThrow(/answering wrongly, so nothing was recorded/);
    expect(await volunteerDets(await specimenOf("25000005"))).toHaveLength(1);
    // The connection is left usable, with no transaction open.
    expect(await tonight()).toMatchObject({ recorded: 1, cleared: ["25000002"] });
  });

  test("two old records of one specimen that disagree are listed, and neither recorded", async () => {
    const specimen = await specimenOf("25000002");
    old.records.set(legacyCopyId(specimen), { _id: legacyCopyId(specimen), fieldNumber: "25000002", familyVolDet: "Halictidae", genusVolDet: "Lasioglossum" });
    expect(await tonight()).toMatchObject({ recorded: 0, conflicting: ["25000002"] });
  });
});

describe("a copy of a specimen printed here", () => {
  let specimen: number;
  let copy: string;

  beforeAll(async () => {
    const sample = await insertCleanSample(conn, { sample_number: "'41'" });
    [[specimen]] = (await rows(
      conn,
      `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, 1, '26090001') RETURNING entity_id`,
    )) as [[number]];
    copy = legacyCopyId(specimen);
    // Beeline's own volunteer determination, which the copy wrote into the old
    // record because it had none.
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, verbatim_identification, sex, determiner_id, is_expert, channel)
       SELECT ${specimen}, a.entity_id, 'Bombus', 'female', (SELECT person_id FROM sample_primary_collector WHERE sample_id = ${sample}), false, 'in_app'
       FROM animal a WHERE a.scientific_name = 'Bombus' AND a.rank = 'genus'`,
    );
    baseline = await newestDetermination();
  });

  beforeEach(() => {
    old.records.set(copy, { _id: copy, fieldNumber: "26090001", familyVolDet: "Apidae", genusVolDet: "Bombus", speciesVolDet: "", sexVolDet: "female", casteVolDet: "" });
  });

  test("holding Beeline's own determination, records nothing", async () => {
    expect(await tonight()).toMatchObject({ recorded: 0, beelineOwn: 1 });
    expect(await volunteerDets(specimen)).toHaveLength(1);
  });

  test("holding a volunteer's entry, records it as the collector's, matched by the specimen in its id", async () => {
    set(copy, { speciesVolDet: "caliginosus", sexVolDet: "male" });
    expect(await tonight()).toMatchObject({ recorded: 1, beelineOwn: 0, notInBeeline: [] });
    const [, last] = await volunteerDets(specimen);
    expect(last?.slice(0, 4)).toEqual(["Bombus caliginosus", "male", null, "legacy_import"]);
    const [[collector]] = (await rows(
      conn,
      `SELECT p.display_name FROM sample_primary_collector pc JOIN specimen sp ON sp.sample_id = pc.sample_id
       JOIN person p ON p.entity_id = pc.person_id WHERE sp.entity_id = ${specimen}`,
    )) as [[string]];
    expect(last?.[4]).toBe(collector);
  });

  test("a copy's key that is not exactly a specimen id matches nothing", async () => {
    old.records.delete(copy);
    old.records.set(`${copy}x`, { _id: `${copy}x`, fieldNumber: "26090001", familyVolDet: "Apidae" });
    old.records.set(`beeline-specimen-0${specimen}`, { _id: `beeline-specimen-0${specimen}`, fieldNumber: "26090001", familyVolDet: "Apidae" });
    expect(await tonight()).toMatchObject({ recorded: 0, notInBeeline: ["26090001", "26090001"] });
  });
});

describe("the rules a record's columns are read by", () => {
  test("are promotion's, on every combination of volunteer columns the old system holds", async () => {
    // The promoted fixture store carries promotion's macros; its
    // legacy_volunteer_target view reads legacy_promotable. Both are given
    // the same 372 combinations, with the real spelling aliases.
    await conn.run(`DELETE FROM legacy_taxon_alias`);
    await conn.run(
      `INSERT INTO legacy_taxon_alias
       SELECT rank, alias, name, basis FROM read_csv('ingest/taxon-aliases.csv', header = true, all_varchar = true)`,
    );
    await conn.run(
      `CREATE TEMP TABLE combination AS
       SELECT concat('c', row_number() OVER ()) AS _id, familyVolDet AS family, genusVolDet AS genus, speciesVolDet AS species,
              sexVolDet AS sex, casteVolDet AS caste
       FROM read_csv('${VOLUNTEER_COLUMNS}', header = true, all_varchar = true)`,
    );
    const [[n]] = (await rows(conn, `SELECT count(*) FROM temp.combination`)) as [[bigint]];
    expect(n).toBe(372n);
    const viewSql = ((await rows(conn, `SELECT sql FROM duckdb_views() WHERE view_name = 'legacy_vol_det_taxa'`)) as [[string]])[0][0];
    // The staged rows replaced by the combinations, under the staged names.
    await conn.run(
      `CREATE OR REPLACE TEMP VIEW staged_as_combination AS
       SELECT _id, family AS familyVolDet, genus AS genusVolDet, species AS speciesVolDet, sex AS sexVolDet, caste AS casteVolDet
       FROM temp.combination`,
    );
    expect(viewSql).toContain("FROM legacy_promotable");
    await conn.run(
      viewSql
        .replace(/CREATE VIEW (main\.)?legacy_vol_det_taxa/i, "CREATE TEMP VIEW combination_taxa")
        .replace("FROM legacy_promotable", "FROM temp.staged_as_combination"),
    );
    const targetSql = ((await rows(conn, `SELECT sql FROM duckdb_views() WHERE view_name = 'legacy_volunteer_target'`)) as [[string]])[0][0];
    await conn.run(
      targetSql
        .replace(/CREATE VIEW (main\.)?legacy_volunteer_target/i, "CREATE TEMP VIEW combination_target")
        .replace("FROM legacy_vol_det_taxa", "FROM temp.combination_taxa"),
    );
    const promotion = `SELECT t._id, legacy_sex_of(s.sexVolDet, s.casteVolDet) AS sex, legacy_caste_of(s.casteVolDet, s.sexVolDet) AS caste,
                              t.written, t.rank, t.name
                       FROM temp.combination_target t JOIN temp.staged_as_combination s USING (_id)`;
    const nightly = `SELECT _id, sex, caste, written, rank, name FROM (${volunteerTargetSql("temp.combination")})`;
    expect(await rows(conn, `(${promotion}) EXCEPT (${nightly})`)).toEqual([]);
    expect(await rows(conn, `(${nightly}) EXCEPT (${promotion})`)).toEqual([]);
    // And the comparison is not vacuous: every combination names something,
    // and the aliases moved at least one.
    expect(await rows(conn, `SELECT count(*) FILTER (WHERE rank IS NULL), count(*) FILTER (WHERE written IS DISTINCT FROM name AND written IS NOT NULL) > 0 FROM (${nightly})`)).toEqual([[0n, true]]);
  });
});

describe("the legacy-volunteer-import job", () => {
  const job = (env: Record<string, string>) =>
    buildJobs(configFromEnv({ BEELINE_ORIGIN: "https://melittologist.org", ...env })).find((j) => j.name === "legacy-volunteer-import")!;

  test("fails in production without a login, since reading nothing would read like a quiet night", async () => {
    await expect(job({ BEELINE_ENV: "production" }).run({} as never)).rejects.toThrow(/nothing was read from the old Beeline/);
  });

  test("stands down without a login anywhere else", async () => {
    expect(await job({ BEELINE_ENV: "development" }).run({} as never)).toMatch(/nothing read/);
  });

  test("reads the old Beeline and records what changed", async () => {
    set("bbbb2222", { speciesVolDet: "caliginosus" });
    const steps: string[] = [];
    const detail = await job({
      BEELINE_ENV: "development",
      OLD_BEELINE_USERNAME: creds.username,
      OLD_BEELINE_PASSWORD: creds.password,
      OLD_BEELINE_API_ORIGIN: creds.origin,
    }).run({
      conn,
      log: () => {},
      signal: new AbortController().signal,
      step: (label: string, fn: () => Promise<unknown>) => {
        steps.push(label);
        return fn();
      },
    } as never);
    expect(steps).toEqual(["read the old Beeline", "record what changed"]);
    expect(detail).toContain("1 were recorded as new");
  });
});
