import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { classificationsByAnimal, metaXml, specimenArchiveStream, type ArchivePage, type Classification } from "../src/app/dwc-archive.js";
import { createKysely } from "../src/db.js";
import { SAMPLE_CSV_HEADER, SPECIMEN_CSV_HEADER, sampleCsvRow, specimenCsvRow, type SampleRow, type SpecimenRow } from "../src/app/listings.js";
import { createMemoryDb, insertCleanSample } from "./helpers.js";

/** A specimen row with every cell a column function reads, nothing determined and nothing located. */
const specimen = (over: Partial<SpecimenRow> = {}): SpecimenRow =>
  ({
    specimen_id: 7,
    specimen_number: 2,
    field_number: "OBA00007",
    sample_id: 1,
    sample_number: "A-1",
    date_start: new Date("2026-07-14"),
    date_end: new Date("2026-07-14"),
    locality: null,
    county: null,
    state_province: null,
    country: null,
    protocol: null,
    catalog_number: null,
    disposition: null,
    occurrence_remarks: null,
    atlas_abbreviation: null,
    host_name: null,
    host_rank: null,
    host_inat_taxon_id: null,
    host_current_name: null,
    host_family: null,
    host_common_name: null,
    taxon_rank: null,
    scientific_name: null,
    authorship: null,
    qualifier: null,
    verbatim_identification: null,
    sex: null,
    caste: null,
    determination_id: null,
    animal_id: null,
    is_expert: null,
    determiner: null,
    determiner_orcid: null,
    determined_on: null,
    determined_on_precision: null,
    latitude: null,
    longitude: null,
    coordinate_uncertainty_m: null,
    elevation_m: null,
    location_source: null,
    geoprivacy: null,
    taxon_geoprivacy: null,
    ...over,
  }) as unknown as SpecimenRow;

const page = (rows: SpecimenRow[]): ArchivePage => ({
  rows,
  total: rows.length,
  collectors: new Map(),
  identifications: [],
});

/** The archive's core and extension as a table of cells, from rows handed to the stream as one page. */
async function archiveOf(rows: SpecimenRow[], opts: { catalogPrefix?: string | null; classifications?: Map<number, Classification> } = {}) {
  const stream = specimenArchiveStream(async () => page(rows), {
    catalogPrefix: opts.catalogPrefix ?? null,
    classifications: opts.classifications,
  });
  const files = Object.fromEntries(
    Object.entries(unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()))).map(([n, d]) => [n, strFromU8(d)]),
  );
  const [header, ...body] = files["occurrence.txt"]!.split("\n").filter((l) => l !== "").map((l) => l.split("\t"));
  return { files, header: header!, body, cell: (r: number, name: string) => body[r]![header!.indexOf(name)] };
}

describe("the staff specimens download keeps its columns", () => {
  it("has the header an edited copy is loaded back by, in this order", () => {
    // Pinned in full: the loader finds these by position and name, so a column added to, moved in or renamed
    // in the Darwin Core archive must never show up here (beeline-8dx9.8).
    expect([...SPECIMEN_CSV_HEADER]).toEqual([
      "occurrenceID", "basisOfRecord", "catalogNumber", "fieldNumber", "disposition", "occurrenceRemarks",
      "eventDate", "samplingProtocol", "recordedBy", "recordedByID", "countryCode", "stateProvince", "county",
      "locality", "decimalLatitude", "decimalLongitude", "geodeticDatum", "coordinateUncertaintyInMeters",
      "minimumElevationInMeters", "maximumElevationInMeters", "associatedTaxa", "scientificName",
      "scientificNameAuthorship", "taxonRank", "identificationQualifier", "verbatimIdentification", "sex",
      "identifiedBy", "identifiedByID", "dateIdentified",
      "sampleNumber", "specimenNumber", "atlas", "hostRank", "locationSource", "geoprivacy", "taxonGeoprivacy",
      "identifiedByExpert", "hostInatTaxonId", "hostCurrentName", "hostFamily", "hostCommonName",
      "caste", "specimenId", "specimenVersion", "sampleVersion",
    ]);
  });

  it("still writes the label number as fieldNumber and the museum's catalog number alone", () => {
    const row = specimenCsvRow(specimen({ catalog_number: "WSDA_1" }), page([]));
    const at = (name: string) => row[SPECIMEN_CSV_HEADER.indexOf(name as never)];
    expect(at("fieldNumber")).toBe("OBA00007");
    expect(at("catalogNumber")).toBe("WSDA_1");
    expect(SPECIMEN_CSV_HEADER).not.toContain("recordNumber");
  });
});

describe("dwc:geodeticDatum", () => {
  const sources = ["inat_trusted", "inat_public", "legacy_import", "staff_entry"];
  it("is WGS84 for every point, whoever recorded it, in the download and the samples file", () => {
    for (const source of sources) {
      const row = specimenCsvRow(specimen({ latitude: 44.5, longitude: -123.2, location_source: source }), page([]));
      expect(row[SPECIMEN_CSV_HEADER.indexOf("geodeticDatum")], source).toBe("WGS84");
      const sample = sampleCsvRow(
        { sample_id: 1, sample_number: "A-1", date_start: new Date("2026-07-14"), date_end: new Date("2026-07-14"), latitude: 44.5, longitude: -123.2, location_source: source, host_name: null } as unknown as SampleRow,
        { rows: [], total: 0, collectors: new Map() } as never,
      );
      expect(sample[SAMPLE_CSV_HEADER.indexOf("geodeticDatum")], source).toBe("WGS84");
    }
  });

  it("is empty where there is no point", () => {
    expect(specimenCsvRow(specimen({ location_source: null }), page([]))[SPECIMEN_CSV_HEADER.indexOf("geodeticDatum")]).toBeNull();
  });
});

describe("the archive's numbers", () => {
  it("writes the sample's number as fieldNumber and sample.specimen as recordNumber", async () => {
    const a = await archiveOf([specimen()]);
    expect(a.cell(0, "fieldNumber")).toBe("A-1");
    expect(a.cell(0, "recordNumber")).toBe("A-1.2");
    // Beeline's own columns keep saying the parts.
    expect([a.cell(0, "sampleNumber"), a.cell(0, "specimenNumber")]).toEqual(["A-1", "2"]);
  });

  it("writes the museum's catalog number where Ecdysis reported one, whatever the prefix", async () => {
    const a = await archiveOf([specimen({ catalog_number: "WSDA_5000001" })], { catalogPrefix: "WSDA_" });
    expect(a.cell(0, "catalogNumber")).toBe("WSDA_5000001");
  });

  it("falls back to the program's prefix and the label number, and to nothing without a prefix", async () => {
    const withPrefix = await archiveOf([specimen()], { catalogPrefix: "WSDA_" });
    expect(withPrefix.cell(0, "catalogNumber")).toBe("WSDA_OBA00007");
    const without = await archiveOf([specimen()], { catalogPrefix: null });
    expect(without.cell(0, "catalogNumber")).toBe("");
  });

  it("makes up no catalog number for a specimen with no label number", async () => {
    const a = await archiveOf([specimen({ field_number: null })], { catalogPrefix: "WSDA_" });
    expect(a.cell(0, "catalogNumber")).toBe("");
    expect(a.cell(0, "recordNumber")).toBe("A-1.2");
  });
});

describe("sex and caste in the archive", () => {
  it("declares both on the identification, and caste on the occurrence beside sex", async () => {
    const a = await archiveOf([specimen({ sex: "female", caste: "worker" })]);
    const meta = a.files["meta.xml"]!;
    const [identHeader] = a.files["identification.txt"]!.split("\n").map((l) => l.split("\t"));
    for (const term of ["sex", "caste"]) {
      expect(meta).toContain(`<field index="${identHeader!.indexOf(term)}" term="http://rs.tdwg.org/dwc/terms/${term}"/>`);
      expect(meta).toContain(`<field index="${a.header.indexOf(term)}" term="http://rs.tdwg.org/dwc/terms/${term}"/>`);
    }
    expect([a.cell(0, "sex"), a.cell(0, "caste")]).toEqual(["female", "worker"]);
    // Whether an expert made it stays Beeline's own, in the identification and in the core.
    expect(meta).not.toContain("identifiedByExpert\"");
    expect(meta).not.toContain("terms/identifiedByExpert");
    // Caste appears once in the core: as a declared column, not again among the undeclared ones.
    expect(a.header.filter((h) => h === "caste")).toHaveLength(1);
  });

  it("says in meta.xml that only the remaining own columns are undeclared", async () => {
    const meta = metaXml();
    expect(meta).toMatch(/Beeline's own and have no term: identifiedByExpert\./);
    expect(meta).not.toMatch(/have no Darwin Core term:[^>]*caste/);
  });
});

describe("the higher classification", () => {
  async function tree() {
    const { instance, conn } = await createMemoryDb();
    const db = createKysely(instance);
    const node = async (rank: string, name: string, parent: string | null) =>
      conn.run(
        `INSERT INTO animal (rank, scientific_name, parent_id)
         VALUES ('${rank}', '${name}', ${parent === null ? "NULL" : `(SELECT entity_id FROM animal WHERE scientific_name = '${parent}')`})`,
      );
    await node("kingdom", "Animalia", null);
    await node("phylum", "Arthropoda", "Animalia");
    await node("class", "Insecta", "Arthropoda");
    await node("order", "Hymenoptera", "Insecta");
    await node("family", "Megachilidae", "Hymenoptera");
    await node("genus", "Osmia", "Megachilidae");
    await node("subgenus", "Osmia (Acanthosmioides)", "Osmia");
    await node("species", "Osmia integra", "Osmia (Acanthosmioides)");
    await node("species", "Osmia lignaria", "Osmia");
    await node("genus", "Bembix", "Hymenoptera");
    await conn.run(`INSERT INTO person (display_name) VALUES ('P')`);
    return { db, conn };
  }

  it("is built for every animal from the tree alone, subgenus included where the tree has one", async () => {
    const { db, conn } = await tree();
    const map = await classificationsByAnimal(db);
    const idOf = async (name: string) =>
      Number((await conn.runAndReadAll(`SELECT entity_id FROM animal WHERE scientific_name = '${name}'`)).getRows()[0]![0]);
    const of = async (name: string) => map.get(await idOf(name));
    const top = { kingdom: "Animalia", phylum: "Arthropoda", class: "Insecta", order: "Hymenoptera" };

    expect(await of("Osmia integra")).toEqual({ ...top, family: "Megachilidae", genus: "Osmia", subgenus: "Osmia (Acanthosmioides)" });
    // No subgenus in this species' ancestry, so none is written.
    expect(await of("Osmia lignaria")).toEqual({ ...top, family: "Megachilidae", genus: "Osmia" });
    // A name at genus rank is its own genus, and sits under the order with no family.
    expect(await of("Bembix")).toEqual({ ...top, genus: "Bembix" });
    // A node is its own rank, and the root has only itself.
    expect(await of("Megachilidae")).toEqual({ ...top, family: "Megachilidae" });
    expect(await of("Animalia")).toEqual({ kingdom: "Animalia" });
    expect(map.size).toBe(10);
  });

  it("is written on the occurrence row under Darwin Core's terms, and empty where there is none", async () => {
    const classifications = new Map([[99, { kingdom: "Animalia", order: "Hymenoptera", family: "Apidae", genus: "Bombus" }]]);
    const a = await archiveOf([specimen({ animal_id: 99 }), specimen({ specimen_id: 8 })], { classifications });
    for (const term of ["kingdom", "phylum", "class", "order", "family", "genus", "subgenus"]) {
      expect(a.files["meta.xml"]).toContain(`<field index="${a.header.indexOf(term)}" term="http://rs.tdwg.org/dwc/terms/${term}"/>`);
    }
    expect([a.cell(0, "kingdom"), a.cell(0, "order"), a.cell(0, "family"), a.cell(0, "genus"), a.cell(0, "phylum")]).toEqual([
      "Animalia", "Hymenoptera", "Apidae", "Bombus", "",
    ]);
    expect(a.header.every((h, i) => a.body[1]![i] !== undefined)).toBe(true);
    expect(["kingdom", "genus"].map((t) => a.cell(1, t))).toEqual(["", ""]);
  });
});
