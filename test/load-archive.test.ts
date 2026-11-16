import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { en } from "../src/app/messages/en.js";
import { archiveNotes, determinationHistory } from "../src/app/record.js";
import { Determinations, PublishedNotes } from "../src/app/views/record.js";
import { createKysely } from "../src/db.js";
import { HELD_COLUMNS, loadArchive, readEml, versionAfter } from "../src/load-archive.js";
import { CURRENT_SEASON, createMemoryDb, currentSeasonDate, insertCleanSample, rows } from "./helpers.js";

/**
 * A museum's published Darwin Core archive onto the specimens it names
 * (beeline-muke). The columns, their order and the values' shapes are OSAC's
 * Oregon Bee Atlas archive, version 1.9: tab-separated with no quoting, an
 * occurrenceID that is the field number or the catalog number under one of
 * two paths, with `http:` on some and `https:` on others, `dateIdentified` a
 * bare year, determiners spelt in full ("Lincoln R. Best"), `sex` in lower
 * case, and eml.xml stating the dataset and version in `packageId`. The
 * people, numbers and samples are made up.
 */

const DATASET = "1fa69ff3-3e40-465f-927f-12b1484d3731";
const COLUMNS = [
  "id", "occurrenceID", "catalogNumber", "recordedBy", "sex", "fieldNumber", "year", "month", "day",
  "identifiedBy", "dateIdentified", "identificationQualifier", "scientificName", "family", "genus", "subgenus", "specificEpithet", "taxonRank",
] as const;
type Row = Partial<Record<(typeof COLUMNS)[number], string>>;

let conn: DuckDBConnection;
let db: ReturnType<typeof createKysely>;
let base: string;

const [YEAR, MONTH, DAY] = currentSeasonDate(7, 14).split("-").map((p) => String(Number(p))) as [string, string, string];

const row = (fieldNumber: string, more: Row = {}): Row => ({
  occurrenceID: `https://osac.oregonstate.edu/OBS/OBA_${fieldNumber}`,
  recordedBy: "Ada Collector",
  sex: "female",
  fieldNumber,
  year: YEAR,
  month: MONTH,
  day: DAY,
  identifiedBy: "Lincoln R. Best",
  dateIdentified: String(CURRENT_SEASON),
  scientificName: "Lasioglossum sisymbrii (Cockerell, 1895)",
  family: "Halictidae",
  genus: "Lasioglossum",
  specificEpithet: "sisymbrii",
  taxonRank: "species",
  ...more,
});

/** An unpacked archive of one version: occurrence.txt as an IPT writes it, and eml.xml. */
async function archive(version: string, publishedOn: string, rs: Row[]): Promise<string> {
  const dir = await mkdtemp(join(base, `v${version}-`));
  const lines = [COLUMNS.join("\t"), ...rs.map((r) => COLUMNS.map((c) => (c === "id" ? (r.occurrenceID ?? "") : (r[c] ?? ""))).join("\t"))];
  await writeFile(join(dir, "occurrence.txt"), `${lines.join("\n")}\n`);
  await writeFile(
    join(dir, "eml.xml"),
    `<eml:eml xmlns:eml="eml://ecoinformatics.org/eml-2.1.1" packageId="${DATASET}/v${version}" system="http://gbif.org">
       <dataset><pubDate>\n      ${publishedOn}\n  </pubDate></dataset></eml:eml>`,
  );
  return dir;
}

// In the fixtures' own season, so a determination dated this season is not after today.
const NOW = new Date(`${CURRENT_SEASON}-11-10T12:00:00Z`);
const LATER = new Date(`${CURRENT_SEASON}-11-20T12:00:00Z`);
const load = (dir: string, now = NOW, dryRun = false) => loadArchive(conn, { dir, now, dryRun });

/** Every determination a load recorded, with the record and version it came from. */
const recorded = () =>
  rows(
    conn,
    `SELECT sp.field_number, an.scientific_name, d.verbatim_identification, d.sex, d.caste, p.display_name, d.determiner_name,
            d.is_expert, d.channel, CAST(d.determined_on AS VARCHAR), d.determined_on_precision, ad.occurrence_id, ad.version
     FROM archive_determination ad JOIN determination d ON d.entity_id = ad.determination_id
     JOIN specimen sp ON sp.entity_id = d.specimen_id JOIN animal an ON an.entity_id = d.animal_id
     LEFT JOIN person p ON p.entity_id = d.determiner_id
     ORDER BY sp.field_number, d.recorded_at`,
  );

const recordOf = async (fieldNumber: string) =>
  (
    await rows(
      conn,
      `SELECT an.scientific_name, r.is_expert, r.channel FROM determination_of_record r
       JOIN specimen sp ON sp.entity_id = r.specimen_id JOIN animal an ON an.entity_id = r.animal_id
       WHERE sp.field_number = '${fieldNumber}'`,
    )
  )[0];

const specimenId = async (fieldNumber: string) =>
  Number((await rows(conn, `SELECT entity_id FROM specimen WHERE field_number = '${fieldNumber}'`))[0]![0]);

const heldRows = async (dir: string) => {
  const [header, ...lines] = (await readFile(join(dir, "held.csv"), "utf8")).trim().split("\n");
  expect(header).toBe(HELD_COLUMNS.join(","));
  return lines.map((l) => l.split(",").slice(1, 3));
};

async function node(rank: string, name: string, parent: string | null): Promise<void> {
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id)
     SELECT '${rank}', '${name}', ${parent === null ? "NULL" : `(SELECT entity_id FROM animal WHERE scientific_name = '${parent}')`}`,
  );
}

/** A determination already in Beeline: an expert's from the old Beeline unless said otherwise. */
async function determined(fieldNumber: string, name: string, more: { expert?: boolean; channel?: string; at?: string } = {}): Promise<void> {
  const channel = more.channel ?? "legacy_import";
  await conn.run(
    `INSERT INTO determination (specimen_id, animal_id, verbatim_identification, is_expert, channel, recorded_at)
     SELECT sp.entity_id, an.entity_id, ${channel === "legacy_import" ? "NULL" : `'${name}'`}, ${more.expert ?? true}, '${channel}',
            TIMESTAMPTZ '${more.at ?? `${CURRENT_SEASON}-09-01T00:00:00Z`}'
     FROM specimen sp, animal an WHERE sp.field_number = '${fieldNumber}' AND an.scientific_name = '${name}'`,
  );
}

beforeEach(async () => {
  const made = await createMemoryDb();
  conn = made.conn;
  db = createKysely(made.instance);
  base = await mkdtemp(join(tmpdir(), "archive-"));
  await conn.run(`INSERT INTO person (display_name, given_name, family_name) VALUES ('Ada Collector', 'Ada', 'Collector')`);
  await node("family", "Halictidae", null);
  await node("genus", "Lasioglossum", "Halictidae");
  await node("species", "Lasioglossum sisymbrii", "Lasioglossum");
  await node("species", "Lasioglossum incompletum", "Lasioglossum");
  await node("family", "Andrenidae", null);
  await node("genus", "Andrena", "Andrenidae");
  const sample = await insertCleanSample(conn);
  for (let n = 1; n <= 9; n++) {
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, ${n}, '2600000${n}')`);
  }
});

describe("a specimen no expert has named", () => {
  test("gets the archive's name as an expert determination, as stated and no further", async () => {
    const dir = await archive("1.9", "2026-11-04", [row("26000001")]);
    const result = await load(dir);
    expect(result).toMatchObject({
      datasetKey: DATASET, publisher: "OSAC", version: "1.9", publishedOn: "2026-11-04", newVersion: true, records: 1,
      statements: { added: 1, changed: 0, withdrawn: 0 }, matched: 1,
      backfilled: { active: 1, settled: 0 }, revised: [], createdPeople: ["Lincoln Best"],
    });
    expect(await recorded()).toEqual([
      ["26000001", "Lasioglossum sisymbrii", "Lasioglossum sisymbrii (Cockerell, 1895)", "female", null, "Lincoln Best", "Lincoln R. Best",
        true, "worksheet_import", `${CURRENT_SEASON}-01-01`, "year", "https://osac.oregonstate.edu/OBS/OBA_26000001", "1.9"],
    ]);
    expect(await recordOf("26000001")).toEqual(["Lasioglossum sisymbrii", true, "worksheet_import"]);
  });

  test("a volunteer's name does not stand in the way, and stays in the history", async () => {
    await determined("26000001", "Lasioglossum", { expert: false });
    await load(await archive("1.9", "2026-11-04", [row("26000001")]));
    expect(await recordOf("26000001")).toEqual(["Lasioglossum sisymbrii", true, "worksheet_import"]);
    const events = await determinationHistory(db, await specimenId("26000001"));
    expect(events.map((e) => [e.scientific_name, e.of_record, e.archive_publisher, e.archive_version])).toEqual([
      ["Lasioglossum sisymbrii", true, "OSAC", "1.9"],
      ["Lasioglossum", false, null, null],
    ]);
    // The record is the archive's statement, so the page does not say it twice.
    expect(await archiveNotes(db, await specimenId("26000001"))).toEqual([]);
  });

  test("a misspelt epithet resolves through the spelling aliases, and the name is kept as published", async () => {
    await load(await archive("1.9", "2026-11-04", [
      row("26000001", { specificEpithet: "sisymbri", scientificName: "Lasioglossum sisymbri (Cockerell, 1895)" }),
      row("26000002", { family: "Andrenidae", genus: "Andrena", specificEpithet: undefined, taxonRank: "genus", scientificName: "Andrena Fabricius, 1775" }),
    ]));
    expect((await recorded()).map((r) => r.slice(0, 3))).toEqual([
      ["26000001", "Lasioglossum sisymbrii", "Lasioglossum sisymbri (Cockerell, 1895)"],
      ["26000002", "Andrena", "Andrena Fabricius, 1775"],
    ]);
  });

  test("is not announced as identified on the night of the load: a year is not a day", async () => {
    await load(await archive("1.9", "2026-11-04", [row("26000001")]));
    expect(await rows(conn, "SELECT identified_at, is_latest FROM expert_identification")).toEqual([[null, true]]);
  });

  test("a dry run records nothing and still reports", async () => {
    const dir = await archive("1.9", "2026-11-04", [row("26000001")]);
    expect((await load(dir, NOW, true)).backfilled).toEqual({ active: 1, settled: 0 });
    expect(await rows(conn, "SELECT count(*) FROM archive_statement")).toEqual([[0n]]);
    expect(await rows(conn, "SELECT count(*) FROM determination")).toEqual([[0n]]);
  });
});

describe("a specimen an expert has already named in Beeline", () => {
  test("is left as it is, whether the archive agrees or not, and the statement is shown", async () => {
    await determined("26000001", "Lasioglossum sisymbrii");
    await determined("26000002", "Lasioglossum incompletum");
    const result = await load(await archive("1.9", "2026-11-04", [
      row("26000001"),
      row("26000002", { genus: "Lasioglossum", specificEpithet: undefined, taxonRank: "genus", scientificName: "Lasioglossum Curtis, 1833" }),
    ]));
    expect(result).toMatchObject({
      backfilled: { active: 0, settled: 0 }, agrees: { active: 1, settled: 0 }, disagrees: { active: 1, settled: 0 }, matched: 2,
    });
    expect(await recorded()).toEqual([]);
    expect(await recordOf("26000001")).toEqual(["Lasioglossum sisymbrii", true, "legacy_import"]);
    expect(await recordOf("26000002")).toEqual(["Lasioglossum incompletum", true, "legacy_import"]);

    expect(await archiveNotes(db, await specimenId("26000001"))).toEqual([
      { publisher: "OSAC", version: "1.9", scientific_name: "Lasioglossum sisymbrii (Cockerell, 1895)", rank: "species",
        name: "Lasioglossum sisymbrii", identified_by: "Lincoln R. Best", date_identified: String(CURRENT_SEASON), sex: "female", agrees: true },
    ]);
    expect(await archiveNotes(db, await specimenId("26000002"))).toMatchObject([
      { scientific_name: "Lasioglossum Curtis, 1833", rank: "genus", name: "Lasioglossum", agrees: false },
    ]);
    expect(await rows(conn, "SELECT field_number, published_name, published_year, channel, settled FROM archive_disagreement")).toEqual([
      ["26000002", "Lasioglossum Curtis, 1833", String(CURRENT_SEASON), "legacy_import", false],
    ]);
  });

  test("the same name under a qualifier is a difference", async () => {
    await determined("26000001", "Lasioglossum sisymbrii");
    await conn.run("UPDATE determination SET qualifier = 'cf.'");
    const result = await load(await archive("1.9", "2026-11-04", [row("26000001")]));
    expect(result).toMatchObject({ agrees: { active: 0 }, disagrees: { active: 1 } });
  });

  test("a published name the tree lacks is not adopted for a statement that is only shown", async () => {
    await determined("26000001", "Lasioglossum sisymbrii");
    const dir = await archive("1.9", "2026-11-04", [
      row("26000001", { specificEpithet: "imbrex", scientificName: "Lasioglossum imbrex Gibbs, 2010" }),
    ]);
    const result = await load(dir);
    expect(result).toMatchObject({ adopted: [], held: { name_unknown: 1 }, disagrees: { active: 1 } });
    expect(await rows(conn, "SELECT count(*) FROM animal WHERE scientific_name = 'Lasioglossum imbrex'")).toEqual([[0n]]);
    // Still shown on the specimen, as published.
    expect(await archiveNotes(db, await specimenId("26000001"))).toMatchObject([
      { scientific_name: "Lasioglossum imbrex Gibbs, 2010", rank: null, name: null, agrees: false },
    ]);
  });
});

describe("the specimen page", () => {
  test("labels a determination from an archive by its publisher, not as a worksheet's, and shows what else is published", async () => {
    await determined("26000002", "Lasioglossum incompletum");
    await load(await archive("1.9", "2026-11-04", [
      row("26000001"),
      row("26000002", { specificEpithet: undefined, taxonRank: "genus", scientificName: "Lasioglossum Curtis, 1833" }),
    ]));
    const recordedPage = String(Determinations({ m: en, events: await determinationHistory(db, await specimenId("26000001")) }));
    expect(recordedPage).toContain("from the dataset OSAC publishes, version 1.9");
    expect(recordedPage).not.toContain("worksheet");

    const notes = String(PublishedNotes({ m: en, notes: await archiveNotes(db, await specimenId("26000002")) }));
    expect(notes).toContain("OSAC publishes this specimen as");
    expect(notes).toContain("<i>Lasioglossum</i>");
    expect(notes).toContain(`(female), identified by Lincoln R. Best in ${CURRENT_SEASON}.`);
    expect(notes).toContain("nothing shows which is newer");
    // Nothing to say where the record is the archive's own statement.
    expect(PublishedNotes({ m: en, notes: await archiveNotes(db, await specimenId("26000001")) })).toBeNull();
  });
});

describe("loading again, and the next version", () => {
  test("the same version again records nothing; another file under its number is refused", async () => {
    const dir = await archive("1.9", "2026-11-04", [row("26000001")]);
    await load(dir);
    const again = await load(dir, LATER);
    expect(again).toMatchObject({ newVersion: false, statements: { added: 0, changed: 0, withdrawn: 0 }, backfilled: { active: 0, settled: 0 }, revised: [] });
    expect(await recorded()).toHaveLength(1);
    expect(await rows(conn, "SELECT count(*) FROM archive_statement")).toEqual([[1n]]);
    await expect(load(await archive("1.9", "2026-11-04", [row("26000002")]))).rejects.toThrow(/loaded from another file/);
  });

  test("a record held for its determiner is recorded by a later load of the same version, once the alias exists", async () => {
    const dir = await archive("1.9", "2026-11-04", [row("26000001", { identifiedBy: "L. R. B." })]);
    expect(await load(dir)).toMatchObject({ held: { determiner_unknown: 1 }, backfilled: { active: 0 } });
    const aliases = join(base, "determiner-aliases.csv");
    await writeFile(aliases, "alias,person\nL. R. B.,Lincoln Best\n");
    const again = await loadArchive(conn, { dir, now: LATER, determinerAliases: aliases });
    expect(again).toMatchObject({ newVersion: false, backfilled: { active: 1 }, held: { determiner_unknown: 0 } });
  });

  test("a version that repeats a statement stores nothing; one that changes it stores the change", async () => {
    await load(await archive("1.8", "2026-11-04", [row("26000001"), row("26000002")]));
    const result = await load(await archive("1.9", "2026-11-04", [row("26000001"), row("26000002", { sex: "male" })]), LATER);
    expect(result.statements).toEqual({ added: 0, changed: 1, withdrawn: 0 });
    expect(await rows(conn, "SELECT occurrence_id, version, sex FROM archive_statement ORDER BY occurrence_id, version")).toEqual([
      ["https://osac.oregonstate.edu/OBS/OBA_26000001", "1.8", "female"],
      ["https://osac.oregonstate.edu/OBS/OBA_26000002", "1.8", "female"],
      ["https://osac.oregonstate.edu/OBS/OBA_26000002", "1.9", "male"],
    ]);
  });

  test("the publisher's revision of a name a load recorded is recorded, when nothing in Beeline has spoken since", async () => {
    await load(await archive("1.8", "2026-11-04", [row("26000001")]));
    const result = await load(
      await archive("1.9", "2026-11-04", [
        row("26000001", { specificEpithet: "incompletum", scientificName: "Lasioglossum incompletum (Crawford, 1907)" }),
      ]),
      LATER,
    );
    expect(result.revised).toEqual([{ fieldNumber: "26000001", was: "Lasioglossum sisymbrii", now: "Lasioglossum incompletum (Crawford, 1907)" }]);
    expect((await recorded()).map((r) => [r[1], r[12]])).toEqual([["Lasioglossum sisymbrii", "1.8"], ["Lasioglossum incompletum", "1.9"]]);
    expect(await recordOf("26000001")).toEqual(["Lasioglossum incompletum", true, "worksheet_import"]);
    // And again changes nothing.
    expect((await load(await archive("1.10", "2026-12-01", [
      row("26000001", { specificEpithet: "incompletum", scientificName: "Lasioglossum incompletum (Crawford, 1907)" }),
    ]), LATER)).revised).toEqual([]);
  });

  test("the publisher's revision does not replace what an expert has said in Beeline since, even the same name", async () => {
    await load(await archive("1.8", "2026-11-04", [row("26000001")]));
    // An expert confirms the archive's name in Beeline, after the load.
    await determined("26000001", "Lasioglossum sisymbrii", { channel: "in_app", at: `${CURRENT_SEASON}-11-15T00:00:00Z` });
    const result = await load(
      await archive("1.9", "2026-11-04", [
        row("26000001", { specificEpithet: "incompletum", scientificName: "Lasioglossum incompletum (Crawford, 1907)" }),
      ]),
      LATER,
    );
    expect(result).toMatchObject({ revised: [], backfilled: { active: 0 }, disagrees: { active: 1 } });
    expect(await recordOf("26000001")).toEqual(["Lasioglossum sisymbrii", true, "in_app"]);
  });

  test("a record the next version drops is marked withdrawn and no longer shown", async () => {
    await determined("26000002", "Lasioglossum incompletum");
    await load(await archive("1.8", "2026-11-04", [row("26000001"), row("26000002")]));
    expect(await archiveNotes(db, await specimenId("26000002"))).toHaveLength(1);
    const result = await load(await archive("1.9", "2026-11-04", [row("26000001")]), LATER);
    expect(result.statements).toEqual({ added: 0, changed: 0, withdrawn: 1 });
    expect(await archiveNotes(db, await specimenId("26000002"))).toEqual([]);
    expect(await rows(conn, "SELECT count(*) FROM archive_reading")).toEqual([[1n]]);
    // It returns as a new statement.
    expect((await load(await archive("1.10", "2026-12-01", [row("26000001"), row("26000002")]), LATER)).statements).toEqual({ added: 0, changed: 1, withdrawn: 0 });
  });

  test("the publisher's revision that cannot be recorded is still shown", async () => {
    await load(await archive("1.8", "2026-11-04", [row("26000001")]));
    expect(await archiveNotes(db, await specimenId("26000001"))).toEqual([]);
    const result = await load(
      await archive("1.9", "2026-11-04", [row("26000001", { specificEpithet: "nonesuch", scientificName: "Lasioglossum nonesuch" })]),
      LATER,
    );
    expect(result).toMatchObject({ revised: [], held: { name_unknown: 1 }, disagrees: { active: 1 } });
    // The record is still version 1.8's name, and the page says what is published now.
    expect(await recordOf("26000001")).toEqual(["Lasioglossum sisymbrii", true, "worksheet_import"]);
    expect(await archiveNotes(db, await specimenId("26000001"))).toMatchObject([
      { version: "1.9", scientific_name: "Lasioglossum nonesuch", name: null, agrees: false },
    ]);
  });

  test("a record the publisher re-issues under another occurrenceID still revises the publisher's own name", async () => {
    await load(await archive("1.8", "2026-11-04", [row("26000001")]));
    const result = await load(
      await archive("1.9", "2026-11-04", [
        row("26000001", {
          occurrenceID: "https://osac.oregonstate.edu/SP/OSAC_0001224490", catalogNumber: "OSAC_0001224490",
          specificEpithet: "incompletum", scientificName: "Lasioglossum incompletum (Crawford, 1907)",
        }),
      ]),
      LATER,
    );
    expect(result).toMatchObject({ statements: { added: 1, changed: 0, withdrawn: 1 }, revised: [{ fieldNumber: "26000001" }] });
    expect(await recordOf("26000001")).toEqual(["Lasioglossum incompletum", true, "worksheet_import"]);
    expect(await archiveNotes(db, await specimenId("26000001"))).toEqual([]);
  });

  test("a version published before the newest loaded is refused, by date and by number; 1.10 follows 1.9", async () => {
    await load(await archive("1.9", "2026-11-04", [row("26000001")]));
    await expect(load(await archive("1.6", "2026-07-28", [row("26000001")]))).rejects.toThrow(/order they were published/);
    // OSAC published 1.8 and 1.9 on one day: the date alone would let 1.8 in as the newer.
    await expect(load(await archive("1.8", "2026-11-04", [row("26000001")]))).rejects.toThrow(/order they were published/);
    expect(versionAfter("1.10", "1.9")).toBe(true);
    expect(versionAfter("1.9", "1.10")).toBe(false);
    expect(versionAfter("1.9", "1.9")).toBe(false);
    expect(versionAfter("2.0", "1.10")).toBe(true);
    expect((await load(await archive("1.10", "2026-12-01", [row("26000001")]), LATER)).newVersion).toBe(true);
    expect(await rows(conn, "SELECT version, sequence FROM archive_version ORDER BY sequence")).toEqual([["1.9", 1], ["1.10", 2]]);
  });
});

describe("what cannot be read is held", () => {
  test("a number no specimen carries, a number two records give, another collector, another day", async () => {
    const dir = await archive("1.9", "2026-11-04", [
      row("26000001"),
      row("99999999"),
      row("26000002"),
      row("26000002", { occurrenceID: "http://osac.oregonstate.edu/SP/OSAC_0001224490", catalogNumber: "OSAC_0001224490" }),
      row("26000003", { recordedBy: "Someone Else" }),
      row("26000004", { day: String(Number(DAY) + 1) }),
      row("26000005", { recordedBy: "Someone Else | Ada Collector" }),
    ]);
    const result = await load(dir);
    expect(result.held).toMatchObject({ no_specimen: 1, repeated_number: 2, collector_disagrees: 1, date_disagrees: 1 });
    expect(result.backfilled).toEqual({ active: 2, settled: 0 });
    expect((await recorded()).map((r) => r[0])).toEqual(["26000001", "26000005"]);
    expect(await heldRows(dir)).toEqual([
      ["26000003", "collector_disagrees"],
      ["26000004", "date_disagrees"],
      ["99999999", "no_specimen"],
      ["26000002", "repeated_number"],
      ["26000002", "repeated_number"],
    ]);
    // A record whose number is in doubt is tied to no specimen, so no page shows it.
    expect(await rows(conn, "SELECT count(*) FROM archive_reading WHERE held IS NOT NULL AND specimen_id IS NOT NULL")).toEqual([[0n]]);
    // The identifier is kept exactly as published.
    expect(await rows(conn, "SELECT occurrence_id, catalog_number FROM archive_statement WHERE catalog_number IS NOT NULL")).toEqual([
      ["http://osac.oregonstate.edu/SP/OSAC_0001224490", "OSAC_0001224490"],
    ]);
  });

  test("a record with no collector, no day or no determiner is held: nothing confirms its number, nobody vouches for its name", async () => {
    const dir = await archive("1.9", "2026-11-04", [
      row("26000001", { recordedBy: undefined }),
      row("26000002", { day: undefined }),
      row("26000003", { identifiedBy: undefined }),
    ]);
    const result = await load(dir);
    expect(result.held).toMatchObject({ number_unconfirmed: 2, determiner_unknown: 1 });
    expect(await recorded()).toEqual([]);
  });

  test("a record held for its determiner still says whether its name is the one Beeline has", async () => {
    await determined("26000001", "Lasioglossum sisymbrii");
    const result = await load(await archive("1.9", "2026-11-04", [row("26000001", { identifiedBy: "Somebody New" })]));
    expect(result).toMatchObject({ held: { determiner_unknown: 1 }, agrees: { active: 1 }, disagrees: { active: 0 } });
    expect(await archiveNotes(db, await specimenId("26000001"))).toMatchObject([{ name: "Lasioglossum sisymbrii", agrees: true }]);
  });

  test("a qualifier, which the loader does not read, refuses the archive", async () => {
    const dir = await archive("1.9", "2026-11-04", [row("26000001", { identificationQualifier: "cf." })]);
    await expect(load(dir)).rejects.toThrow(/identificationQualifier has values/);
    expect(await rows(conn, "SELECT count(*) FROM archive_version")).toEqual([[0n]]);
  });

  test("a name the tree and Ecdysis lack, a family the tree files the name elsewhere under, a year before the sample", async () => {
    const dir = await archive("1.9", "2026-11-04", [
      row("26000001", { specificEpithet: "nonesuch", scientificName: "Lasioglossum nonesuch" }),
      row("26000002", { family: "Andrenidae" }),
      row("26000003", { dateIdentified: String(CURRENT_SEASON - 1) }),
      row("26000004", { dateIdentified: "2024-05" }),
      row("26000005", { sex: "queen" }),
    ]);
    const result = await load(dir);
    expect(result.held).toMatchObject({ name_unknown: 1, family_disagrees: 1, identified_disagrees: 1, identified_unreadable: 1, sex_unreadable: 1 });
    expect(await recorded()).toEqual([]);
  });

  test("a record whose number now names another specimen is held, not recorded a second time", async () => {
    await load(await archive("1.8", "2026-11-04", [row("26000001")]));
    // The field number is corrected: it was the next specimen's all along.
    await conn.run("UPDATE specimen SET field_number = 'x' WHERE field_number = '26000001'");
    await conn.run("UPDATE specimen SET field_number = '26000001' WHERE field_number = '26000002'");
    const result = await load(await archive("1.9", "2026-11-04", [row("26000001", { sex: "male" })]), LATER);
    expect(result.held).toMatchObject({ specimen_changed: 1 });
    expect(await recorded()).toHaveLength(1);
  });
});

describe("the archive itself", () => {
  test("eml.xml states the dataset, the version and the day published", () => {
    expect(readEml(`<eml packageId="${DATASET}/v1.10"><pubDate>\n 2026-12-01\n </pubDate></eml>`)).toEqual({
      datasetKey: DATASET, version: "1.10", publishedOn: "2026-12-01",
    });
    expect(() => readEml("<eml packageId=\"something\"/>")).toThrow(/packageId/);
  });

  test("a dataset nobody has described is refused", async () => {
    const dir = await archive("1.0", "2026-01-01", [row("26000001")]);
    const other = "00000000-0000-0000-0000-000000000000";
    await writeFile(join(dir, "eml.xml"), (await readFile(join(dir, "eml.xml"), "utf8")).replace(DATASET, other));
    await expect(load(dir)).rejects.toThrow(/not in archive_dataset/);
  });

  test("an occurrenceID on two records is refused", async () => {
    await expect(load(await archive("1.9", "2026-11-04", [row("26000001"), row("26000001")]))).rejects.toThrow(/more than one record/);
  });
});
