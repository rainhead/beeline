import { beforeAll, describe, expect, test } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { createMemoryDb, rows } from "./helpers.js";

/**
 * ingest/parse-names.sql, run over verbatim strings lifted from production
 * staging (beeline-qcd).
 *
 * These are not invented cases. Every string below is one somebody actually
 * typed into the legacy system, chosen because it is the whole of a category
 * the survey found: the ordinary binomial, the authored one, the parenthesised
 * subgenus, the five trinomials — two of which the source's own taxonRank
 * calls a species — the sp.N morphospecies, the one near-qualified name, and
 * the one string that is not a name at all. The corpus is small (727 distinct
 * names over 383,032 records), so this is close to exhaustive by category.
 *
 * The two bugs it pins: a trinomial's third epithet was landing in
 * `authorship`, which prints on labels, and a subspecies whose taxonRank lied
 * was landing on its species node.
 */

interface Row {
  sci: string;
  genus?: string;
  subgenus?: string;
  epithet?: string;
  rank?: string;
  recordedBy?: string;
  month?: string;
  url?: string;
}

/** Verbatim, from production staging. Counts are that corpus's, 2026-08-27. */
const CORPUS: Row[] = [
  { sci: "Bombus vosnesenskii", genus: "Bombus", epithet: "vosnesenskii" },
  { sci: "Bombus vosnesenskii Radoszkowski, 1862", genus: "Bombus", epithet: "vosnesenskii" },
  { sci: "Halictus rubicundus (Christ, 1791)", genus: "Halictus", epithet: "rubicundus" },
  { sci: "Ceratina pacifica H.S.Smith, 1907", genus: "Ceratina", epithet: "pacifica" },
  { sci: "Lasioglossum sandhousiellum Gibbs, 2010", genus: "Lasioglossum", epithet: "sandhousiellum" },
  // The genus column carries the subgenus in brackets; subgenus is its own column too.
  { sci: "Lasioglossum (Dialictus)", genus: "Lasioglossum (Dialictus)", rank: "Subgenus" },
  { sci: "Andrena (Andrena)", genus: "Andrena", subgenus: "Andrena", rank: "Subgenus" },
  // Trinomials. taxonRank is right about three of these and wrong about two.
  { sci: "Colletes consors pascoensis", genus: "Colletes", epithet: "consors", rank: "Subspecies" },
  { sci: "Bembix americana comata", genus: "Bembix", epithet: "americana", rank: "Subspecies" },
  { sci: "Eucera frater frater", genus: "Eucera", epithet: "frater", rank: "Subspecies" },
  { sci: "Osmia montana montana", genus: "Osmia", epithet: "montana", rank: "Species" },
  { sci: "Bembix americana spinolae", genus: "Bembix", epithet: "americana", rank: "Species" },
  // Distinguishable undescribed entities, and one with a doubled space.
  { sci: "Melissodes sp.1", genus: "Melissodes" },
  { sci: "Lasioglossum  sp.1", genus: "Lasioglossum" },
  { sci: "Stelis sp.7", genus: "Stelis" },
  // "near tenax": resembles it, is probably not it.
  { sci: "Lasioglossum nr. tenax", genus: "Lasioglossum" },
  // Uninomial, and a string that is not a name.
  { sci: "Andrenidae" },
  { sci: "Not a bee" },
];

/**
 * The qualifier branches the corpus does not attest. Only `nr.` appears in
 * production staging; `cf.`, `cfr.` and `aff.` are the same construction and
 * the glossary teaches two of them, so the parser takes them — which means
 * they need cover here, being the one part of this file not held down by a
 * real string. Marked synthetic so nobody reads them as evidence.
 */
const SYNTHETIC_QUALIFIERS: Row[] = [
  { sci: "Bombus cf. occidentalis", genus: "Bombus" },
  { sci: "Bombus cfr. griseocollis", genus: "Bombus" },
  { sci: "Andrena aff. nivalis", genus: "Andrena" },
  // A qualifier needs a genus to hang on: with the genus column empty there
  // is no species to attach it to, and it must not ride along on whatever
  // coarser rank the row does resolve to.
  { sci: "Bombus nr. mixtus" },
];

/** The other verbatim fields, in the shapes the corpus actually holds. */
const OTHER_FIELDS: Row[] = [
  { sci: "Apis mellifera", genus: "Apis", epithet: "mellifera", recordedBy: "Bea Trapper | Ada Collector",
    month: "VII", url: "https://www.inaturalist.org/observations/41624031" },
  { sci: "Apis mellifera", genus: "Apis", epithet: "mellifera",
    month: "6", url: "http://www.inaturalist.org/observations/41624032" },
  { sci: "Apis mellifera", genus: "Apis", epithet: "mellifera",
    url: "https://www.inaturalist.org/taxa/52821-Achillea-millefolium" },
];

let conn: DuckDBConnection;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  // parse-names.sql reads legacy_promotable; these are the columns it touches.
  await conn.run(`CREATE TABLE legacy_promotable (
    _id TEXT, "order" TEXT, family TEXT, genus TEXT, subgenus TEXT,
    specificEpithet TEXT, scientificName TEXT, taxonRank TEXT,
    recordedBy TEXT, month TEXT, url TEXT,
    identifiedBy TEXT, verbatimEventDate TEXT)`);
  // legacy_verbatim_shape also sizes the two fields that answer through a
  // worklist rather than a rule; the findings view is promote-legacy's.
  await conn.run(`CREATE VIEW legacy_promotion_finding AS SELECT '' AS _id, '' AS rule WHERE false`);
  for (const [i, r] of [...CORPUS, ...SYNTHETIC_QUALIFIERS, ...OTHER_FIELDS].entries()) {
    await conn.run(
      `INSERT INTO legacy_promotable (_id, "order", family, genus, subgenus,
         specificEpithet, scientificName, taxonRank, recordedBy, month, url,
         identifiedBy, verbatimEventDate)
       VALUES ($1, '', '', $2, $3, $4, $5, $6, $7, $8, $9, 'Lincoln Best', '')`,
      [
        String(i), r.genus ?? "", r.subgenus ?? "", r.epithet ?? "", r.sci, r.rank ?? "",
        r.recordedBy ?? "Ada Collector", r.month ?? "7", r.url ?? "",
      ] as never,
    );
  }
  await conn.run(await readFile("ingest/parse-names.sql", "utf8"));
});

const parse = (sci: string) =>
  rows(conn, `SELECT parse FROM legacy_name_parse WHERE sci = '${sci.replaceAll("'", "''")}'`);

const parsed = (sci: string) =>
  rows(
    conn,
    `SELECT base_genus, sub, epithet, authorship, trinomial, qualifier, qualified_epithet
       FROM legacy_det_taxa WHERE sci = '${sci.replaceAll("'", "''")}'`,
  );

describe("taking a verbatim scientific name apart", () => {
  test("every string lands in exactly one category, and nothing is a surprise", async () => {
    expect(await rows(conn, "SELECT parse, count(*) FROM legacy_name_parse GROUP BY 1 ORDER BY 1")).toEqual([
      ["binomial", 2n], // Bombus vosnesenskii, plus Apis mellifera from OTHER_FIELDS
      ["binomial with authorship", 4n],
      ["morphospecies", 3n],
      ["qualified", 4n],
      ["subgenus", 2n],
      ["trinomial", 5n],
      ["uninomial", 1n],
      ["unparsed", 2n], // "Not a bee", and the qualifier with no genus
    ]);
  });

  test("authorship is a name, never the third epithet of a trinomial", async () => {
    // The bug: Osmia montana carried authorship "montana", Bembix americana
    // "spinolae", Colletes consors "pascoensis" — and authorship prints on a
    // label, which is permanent once printed.
    expect(await parsed("Osmia montana montana")).toEqual([["Osmia", null, "montana", null, "Osmia montana montana", null, null]]);
    expect(await parsed("Colletes consors pascoensis")).toEqual([
      ["Colletes", null, "consors", null, "Colletes consors pascoensis", null, null],
    ]);
    expect(
      await rows(conn, "SELECT count(*) FROM legacy_det_taxa WHERE authorship ~ '^[a-z]'"),
    ).toEqual([[0n]]);
  });

  test("authorship survives in all the shapes it really takes", async () => {
    const authorships = await rows(
      conn,
      "SELECT authorship FROM legacy_det_taxa WHERE authorship IS NOT NULL ORDER BY 1",
    );
    expect(authorships).toEqual([
      ["(Christ, 1791)"], // parenthesised: the species moved genus
      ["Gibbs, 2010"],
      ["H.S.Smith, 1907"], // initials with no spaces
      ["Radoszkowski, 1862"],
    ]);
  });

  test("a trinomial is recognised from the name, not from taxonRank", async () => {
    // taxonRank calls two of the five trinomials 'Species'. Believing it sent
    // those determinations to the species node and dropped an epithet a
    // determiner wrote on purpose.
    expect(
      await rows(conn, "SELECT sci FROM legacy_det_taxa WHERE trinomial IS NOT NULL ORDER BY 1"),
    ).toEqual([
      ["Bembix americana comata"],
      ["Bembix americana spinolae"],
      ["Colletes consors pascoensis"],
      ["Eucera frater frater"],
      ["Osmia montana montana"],
    ]);
  });

  test("'Not a bee' is not a subspecies of Not a", async () => {
    // A shape-only rule (capitalised word, two lowercase words) read this as
    // a trinomial and minted a determination nothing could resolve. Anchoring
    // on the row's own genus and epithet is what excludes it.
    expect(await parsed("Not a bee")).toEqual([[null, null, null, null, null, null, null]]);
    expect(await parse("Not a bee")).toEqual([["unparsed"]]);
  });

  test("an authored binomial is not mistaken for a trinomial", async () => {
    expect(await parsed("Bombus vosnesenskii Radoszkowski, 1862")).toEqual([
      ["Bombus", null, "vosnesenskii", "Radoszkowski, 1862", null, null, null],
    ]);
  });

  test("subgenus comes from either column, bracketed or its own", async () => {
    expect(await parsed("Lasioglossum (Dialictus)")).toEqual([
      ["Lasioglossum", "Dialictus", null, null, null, null, null],
    ]);
    expect(await parsed("Andrena (Andrena)")).toEqual([["Andrena", "Andrena", null, null, null, null, null]]);
  });

  test("the other verbatim fields are surveyed too, so a new shape shows up", async () => {
    // recordedBy in production uses '|' and nothing else — no '&', no comma.
    // Symbiota's duplicate matcher split 'B. & C. Durden' on '&' and matched
    // the token 'B.' to two unrelated collectors; this view is how we would
    // learn that our own corpus had started to look like that.
    expect(
      await rows(conn, "SELECT field, shape, records FROM legacy_verbatim_shape ORDER BY field, shape"),
    ).toEqual([
      ["identifiedBy", "named", 25n],
      ["month", "roman numeral", 1n],
      ["recordedBy", "non-ASCII", 0n],
      ["recordedBy", "other separator (& , ; and)", 0n],
      ["recordedBy", "pipe-separated", 1n],
      ["url", "canonical observation", 1n],
      ["url", "not an observation", 1n],
      ["url", "observation, other scheme or host", 1n],
      ["verbatimEventDate", "date did not parse", 0n],
      ["verbatimEventDate", "present", 0n],
    ]);
  });

  test("a qualified name reaches the species it stops short of, carrying the qualifier", async () => {
    // "Lasioglossum nr. tenax" used to land on the bare genus: specificEpithet
    // is empty on these rows, so the string was the only witness and nothing
    // read it. The determination now points at Lasioglossum tenax and says
    // nr. — which is what the determiner meant (beeline-tgu).
    expect(await parsed("Lasioglossum nr. tenax")).toEqual([
      ["Lasioglossum", null, null, null, null, "nr.", "tenax"],
    ]);
  });

  test("every qualifier spelling normalises to the three the store distinguishes", async () => {
    expect(
      await rows(
        conn,
        `SELECT sci, qualifier, qualified_epithet FROM legacy_det_taxa
          WHERE qualifier IS NOT NULL ORDER BY sci`,
      ),
    ).toEqual([
      ["Andrena aff. nivalis", "aff.", "nivalis"],
      ["Bombus cf. occidentalis", "cf.", "occidentalis"],
      // cfr. is a spelling of cf., normalised here rather than in the CHECK.
      ["Bombus cfr. griseocollis", "cf.", "griseocollis"],
      ["Lasioglossum nr. tenax", "nr.", "tenax"],
    ]);
  });

  test("a qualifier with no genus to hang on is not a qualifier", async () => {
    // 'Bombus nr. mixtus' with an empty genus column: reading the qualifier
    // off the string alone would attach nr. to whatever coarser rank the row
    // resolves to — a family or an order that nobody qualified.
    expect(await parsed("Bombus nr. mixtus")).toEqual([[null, null, null, null, null, null, null]]);
  });

  test("names the model has nowhere to put are named as such, not silently flattened", async () => {
    // Not a mistake anybody made: a determiner separated Melissodes sp.1 from
    // sp.5 deliberately. The model records the genus and loses the rest — so
    // the loss is at least visible (beeline-8g7).
    expect(await rows(conn, "SELECT sci, parse, lands_on FROM legacy_name_flattened ORDER BY sci")).toEqual([
      ["Bombus nr. mixtus", "unparsed", ""], // synthetic: no genus, so nothing to attach
      ["Lasioglossum  sp.1", "morphospecies", "Lasioglossum"],
      ["Melissodes sp.1", "morphospecies", "Melissodes"],
      ["Not a bee", "unparsed", ""],
      ["Stelis sp.7", "morphospecies", "Stelis"],
    ]);
  });
});
