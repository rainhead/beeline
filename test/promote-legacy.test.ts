import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { createMemoryDb, FIXTURE_INPUTS, rows } from "./helpers.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy, type PromotionCounts } from "../src/promote-legacy.js";

const FIXTURE = new URL("./fixtures/legacy-occurrences.jsonl", import.meta.url).pathname;
const REGISTER = new URL("./fixtures/usernames.csv", import.meta.url).pathname;

let conn: DuckDBConnection;
let counts: PromotionCounts;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  await loadLegacyStaging(conn, FIXTURE);
  counts = await promoteLegacy(conn, { ...FIXTURE_INPUTS, usernameRegister: REGISTER });
});

describe("legacy promotion", () => {
  test("promotes the valid rows and blocks the junk row", () => {
    expect(counts).toEqual({
      staged: 6,
      people: 3, // two collectors + the determiner Lincoln Best — the joint row adds nobody
      samples: 3, // dddd4444 merges into Ada's sample 1; the joint trap sample is its own
      specimens: 5,
      locations: 3,
      // Spine (3) + Hymenoptera + 2 families + 2 genera + 3 species.
      animals: 12,
      determinations: 4,
      blockedRows: 1,
      unresolvedDeterminations: 0,
      unresolvedDeterminerNames: 0,
      unusedCollectorAliases: 0,
      collectorDuplicateLogins: 0,
      correctionsApplied: 0,
      correctionsRetired: 0,
      correctionConflicts: 0,
      registerStaged: 4,
      registerNameConflicts: 3, // Bea's family name and full name, Ada's label initial
      personOverlayApplied: 2,
      personOverlayUnresolved: [],
    });
  });

  test("the animal tree links species to genus to family to order", async () => {
    const chain = await rows(
      conn,
      `SELECT sp.scientific_name, g.scientific_name, f.scientific_name, o.scientific_name, sp.authorship
       FROM animal sp
       JOIN animal g ON g.entity_id = sp.parent_id
       JOIN animal f ON f.entity_id = g.parent_id
       JOIN animal o ON o.entity_id = f.parent_id
       WHERE sp.scientific_name = 'Bombus vosnesenskii'`,
    );
    expect(chain).toEqual([["Bombus vosnesenskii", "Bombus", "Apidae", "Hymenoptera", null]]);
  });

  test("expert and volunteer determinations both land, correctly attributed", async () => {
    const dets = await rows(
      conn,
      `SELECT a.scientific_name, d.is_expert, d.determiner_name, p.display_name, d.sex
       FROM determination d
       JOIN animal a ON a.entity_id = d.animal_id
       LEFT JOIN person p ON p.entity_id = d.determiner_id
       ORDER BY d.is_expert, a.scientific_name`,
    );
    expect(dets).toEqual([
      ["Bombus", false, null, "Bea Trapper", "female"],
      ["Bombus", false, null, "Bea Trapper", "female"], // the joint sample's specimen
      // Verbatim name retained AND resolved to a single person record.
      ["Bombus vosnesenskii", true, "Lincoln Best", "Lincoln Best", "female"],
      ["Lasioglossum tenax", true, "Lincoln Best", "Lincoln Best", "female"],
    ]);
  });

  test("a qualified determination keeps its qualifier and the words it was written in", async () => {
    // 'Lasioglossum nr. tenax' has an empty specificEpithet, so before
    // beeline-tgu the string was the only witness to what the determiner
    // meant and nothing read it: the determination landed on the bare genus.
    // It now points at the species and says how far short of asserting it
    // the determiner stopped.
    expect(
      await rows(
        conn,
        `SELECT a.rank, a.scientific_name, d.qualifier, d.verbatim_identification
         FROM determination d JOIN animal a ON a.entity_id = d.animal_id
         WHERE d.qualifier IS NOT NULL`,
      ),
    ).toEqual([["species", "Lasioglossum tenax", "nr.", "Lasioglossum nr. tenax"]]);

    // Volunteer determinations arrive already parted, so there is no verbatim
    // string to keep and none is invented.
    expect(
      await rows(
        conn,
        "SELECT is_expert, count(verbatim_identification) FROM determination GROUP BY 1 ORDER BY 1",
      ),
    ).toEqual([[false, 0n], [true, 2n]]);
  });

  test("the junk row's problems are named findings", async () => {
    const found = await rows(
      conn,
      `SELECT rule FROM legacy_promotion_finding WHERE _id = 'cccc3333' ORDER BY rule`,
    );
    expect(found.flat()).toEqual(["bad_elevation", "bad_specimen_number", "missing_person"]);
  });

  test("net and trap samples are distinguished by date range", async () => {
    const kinds = await rows(
      conn,
      `SELECT kind, sample_number, CAST(date_start AS VARCHAR), CAST(date_end AS VARCHAR)
       FROM sample ORDER BY kind, sample_number`,
    );
    expect(kinds).toEqual([
      ["net", "1", "2025-07-14", "2025-07-14"],
      ["trap", "OBAS-00657", "2025-07-01", "2025-07-14"],
      ["trap", "OBAS-00658", "2025-07-01", "2025-07-14"],
    ]);
  });

  test("people, accounts, and atlases resolve", async () => {
    const people = await rows(
      conn,
      `SELECT p.display_name, i.login, a.code
       FROM person p
       LEFT JOIN inat_account i ON i.person_id = p.entity_id
       LEFT JOIN sample s ON s.collector_id = p.entity_id
       LEFT JOIN atlas a ON a.entity_id = s.atlas_id
       ORDER BY p.display_name`,
    );
    expect(people).toEqual([
      ["Ada Collector", "adacollects", "OBA"],
      ["Bea Trapper", "trapline", "WaBA"],
      ["Bea Trapper", "trapline", "WaBA"], // the joint sample, also hers
      ["Lincoln Best", null, null], // determiner-only person: no samples, no account yet
    ]);
  });

  test("a joint recordedBy becomes two collectors, not a third person", async () => {
    // "Bea and Ada" / "Trapper/Collector" is how the entry form let a pair be
    // written; recordedBy holds the real list (beeline-77j).
    const collectors = await rows(
      conn,
      `SELECT s.sample_number, c.position, p.display_name
       FROM sample_collector c
       JOIN sample s ON s.entity_id = c.sample_id
       JOIN person p ON p.entity_id = c.person_id
       ORDER BY s.sample_number, c.position`,
    );
    expect(collectors).toEqual([
      ["1", 1, "Ada Collector"],
      ["OBAS-00657", 1, "Bea Trapper"],
      ["OBAS-00658", 1, "Bea Trapper"],
      ["OBAS-00658", 2, "Ada Collector"],
    ]);
    // No "Bea and Ada Trapper/Collector" person was invented.
    expect(await rows(conn, `SELECT display_name FROM person ORDER BY display_name`)).toEqual([
      ["Ada Collector"],
      ["Bea Trapper"],
      ["Lincoln Best"],
    ]);
  });

  test("position 1 is the sample's own collector — the invariant the app reads", async () => {
    // Read through the view rather than spelled again here (schema/116,
    // beeline-daa): this test used to be a third statement of the invariant,
    // beside the COMMENT and the writer, and it missed two of the three ways
    // to break it — a sample with collectors but none at position 1, and two
    // collectors both claiming it.
    expect(await rows(conn, "SELECT sample_id, at_position_1 FROM sample_primary_collector_mismatch")).toEqual([]);
    // And every sample has a list at all, which the view does not ask.
    const missing = await rows(
      conn,
      `SELECT s.entity_id FROM sample s
       WHERE NOT EXISTS (SELECT 1 FROM sample_collector c WHERE c.sample_id = s.entity_id)`,
    );
    expect(missing).toEqual([]);
  });

  test("collectors keep their name parts, so a label can abbreviate them", async () => {
    // display_name alone cannot yield "A. Collector" (beeline-77j).
    const parts = await rows(
      conn,
      `SELECT display_name, given_name, family_name FROM person
       WHERE given_name IS NOT NULL ORDER BY display_name`,
    );
    expect(parts).toEqual([
      ["Ada Collector", "Ada", "Collector"],
      ["Bea Trapper", "Bea", "Trapper"],
    ]);
  });

  test("locations carry elevation with legacy provenance", async () => {
    const locs = await rows(
      conn,
      `SELECT l.elevation_m, l.source, e.description LIKE 'legacy verbatimElevation%'
       FROM sample_location l JOIN elevation_source e ON e.entity_id = l.elevation_source_id
       ORDER BY l.elevation_m`,
    );
    expect(locs).toEqual([
      [72, "legacy_import", true],
      [120, "legacy_import", true],
      [120, "legacy_import", true], // the joint trap sample, same trap site
    ]);
  });

  test("specimens keep verbatim catalog numbers, and are numbered per sample", async () => {
    const specimens = await rows(
      conn,
      `SELECT s.sample_number, sp.field_number, sp.specimen_number
       FROM specimen sp JOIN sample s ON s.entity_id = sp.sample_id
       ORDER BY sp.field_number`,
    );
    // The catalog number is the physical identity, kept verbatim. The
    // specimen number is 1..N within the sample (schema/030), assigned at
    // promotion rather than copied from the legacy specimenId — Bea's row
    // arrived as specimen 2 and is the only one in its sample. Merging
    // series make the legacy number unusable as a key anyway
    // (test/promote-legacy-merges.test.ts).
    expect(specimens).toEqual([
      ["1", "25000001", 1],
      ["OBAS-00657", "25000002", 1],
      ["1", "25000003", 2],
      ["OBAS-00658", "25000005", 1],
      ["1", "25000009", 3],
    ]);
  });

  test("within-sample disagreement becomes a sample-keyed warning finding", async () => {
    // Ada's two rows disagree on locality; the earliest (_id-min) value won.
    const [[locality]] = (await rows(
      conn,
      `SELECT locality FROM sample WHERE sample_number = '1'`,
    )) as [[unknown]];
    expect(locality).toBe("Corvallis");
    const findings = await rows(
      conn,
      `SELECT f.details FROM qc_finding f
       JOIN sample s ON s.entity_id = f.sample_id
       WHERE s.sample_number = '1' AND f.rule_name = 'within_sample_disagreement'`,
    );
    expect(findings).toEqual([["locality: Corvallis | Philomath"]]);
    // Empty county on one row is "no opinion", not a disagreement; and the
    // warning does not block printing (the net sample stays printable).
    const printable = await rows(
      conn,
      `SELECT 1 FROM printable_sample p JOIN sample s ON s.entity_id = p.sample_id
       WHERE s.sample_number = '1'`,
    );
    expect(printable).toHaveLength(1);
  });

  test("model-level QC now runs over the promoted samples", async () => {
    // The trap sample's street-address locality and 300 m uncertainty block;
    // the net sample prints.
    const printable = await rows(
      conn,
      `SELECT s.kind FROM printable_sample p JOIN sample s ON s.entity_id = p.sample_id`,
    );
    expect(printable).toEqual([["net"]]);
    const flagged = await rows(
      conn,
      `SELECT DISTINCT rule_name FROM qc_finding f JOIN sample s ON s.entity_id = f.sample_id
       WHERE s.kind = 'trap' ORDER BY rule_name`,
    );
    expect(flagged.flat()).toEqual([
      "coordinate_uncertainty",
      "locality_format",
      "missing_recommended_field",
    ]);
  });

  test("promotion refuses a non-empty model", async () => {
    await expect(promoteLegacy(conn, FIXTURE_INPUTS)).rejects.toThrow(/freshly built/);
  });
});

// beeline-8t8. The register is a second opinion about names, not an authority
// over them: nothing here writes to person. What it produces is a worklist a
// human graduates into ingest/person-overlay.csv.
describe("the legacy name register", () => {
  test("stages the name columns and not the mailing address", async () => {
    const columns = await rows(
      conn,
      `SELECT column_name FROM duckdb_columns()
       WHERE table_name = 'legacy_username_register' ORDER BY column_name`,
    );
    expect(columns.flat()).toEqual(["family_name", "full_name", "given_name", "label_initial", "login"]);
  });

  test("reports what the register spells differently, field by field", async () => {
    const conflicts = await rows(
      conn,
      `SELECT login, field, store_value, register_value
       FROM legacy_register_name_conflict ORDER BY login, field`,
    );
    expect(conflicts).toEqual([
      // Ada's parts agree; her initial does not derive from them, so it is a
      // genuine label override the way 'J.M.' is for Juan Manuel Benitez
      // Alvarez — src/person-name.ts would render 'A. Collector'.
      ["adacollects", "label_name", null, "A.M. Collector"],
      ["trapline", "display_name", "Bea Trapper", "Bea Trapperson"],
      ["trapline", "family_name", "Trapper", "Trapperson"],
    ]);
  });

  test("reaches nobody who has no iNat login, which is where the missing parts are", async () => {
    const unreached = await rows(
      conn,
      `SELECT display_name, reason, parts_missing FROM legacy_register_unreached
       ORDER BY display_name`,
    );
    // Lincoln Best is the determiner: a person the legacy rows name but who
    // never collected under a login, so the register cannot see him at all.
    expect(unreached).toEqual([["Lincoln Best", "no iNat account", true]]);
  });

  // The register is fetched, not checked in, so this is the fresh-clone path
  // and the `pnpm db:reseed` path both: staging comes across, the fetched CSV
  // does not. It must not be fatal, and it must not look like agreement —
  // registerStaged is what tells the two apart (beeline-8t8).
  test("promotes with no register at all, and says so rather than reporting agreement", async () => {
    const { conn: bare } = await createMemoryDb();
    await loadLegacyStaging(bare, FIXTURE);
    const bareCounts = await promoteLegacy(bare, {
      ...FIXTURE_INPUTS,
      usernameRegister: "data/legacy/no-such-register.csv",
    });
    expect(bareCounts.registerStaged).toBe(0);
    expect(bareCounts.registerNameConflicts).toBe(0);
    // The curation surfaces still exist; they simply have nothing to say.
    const empty = await rows(bare, `SELECT count(*) FROM legacy_register_ambiguous_login`);
    expect(empty).toEqual([[0n]]);
    // And everyone is unreached, which is the honest answer for no register.
    const unreached = await rows(bare, `SELECT count(*) FROM legacy_register_unreached`);
    expect(unreached).toEqual([[3n]]);
  });

  test("a login naming two people is reported, never picked between", async () => {
    const ambiguous = await rows(
      conn,
      `SELECT login, register_rows, names FROM legacy_register_ambiguous_login`,
    );
    expect(ambiguous).toEqual([["sharedlog", 2n, "Nan Flower | Pat Ellery"]]);
    const claimed = await rows(
      conn,
      `SELECT count(*) FROM legacy_register_name_conflict WHERE login = 'sharedlog'`,
    );
    expect(claimed).toEqual([[0n]]);
  });
});
