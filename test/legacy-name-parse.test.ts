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

let conn: DuckDBConnection;

beforeAll(async () => {
  ({ conn } = await createMemoryDb());
  // The parser reads legacy_promotable; these are the only columns it touches.
  await conn.run(`CREATE TABLE legacy_promotable (
    _id TEXT, "order" TEXT, family TEXT, genus TEXT, subgenus TEXT,
    specificEpithet TEXT, scientificName TEXT, taxonRank TEXT)`);
  for (const [i, r] of CORPUS.entries()) {
    await conn.run(
      `INSERT INTO legacy_promotable (_id, "order", family, genus, subgenus,
         specificEpithet, scientificName, taxonRank)
       VALUES ($1, '', '', $2, $3, $4, $5, $6)`,
      [String(i), r.genus ?? "", r.subgenus ?? "", r.epithet ?? "", r.sci, r.rank ?? ""] as never,
    );
  }
  await conn.run(await readFile("ingest/parse-names.sql", "utf8"));
});

const parse = (sci: string) =>
  rows(conn, `SELECT parse FROM legacy_name_parse WHERE sci = '${sci.replaceAll("'", "''")}'`);

const parsed = (sci: string) =>
  rows(
    conn,
    `SELECT base_genus, sub, epithet, authorship, trinomial FROM legacy_det_taxa
      WHERE sci = '${sci.replaceAll("'", "''")}'`,
  );

describe("taking a verbatim scientific name apart", () => {
  test("every string lands in exactly one category, and nothing is a surprise", async () => {
    expect(await rows(conn, "SELECT parse, count(*) FROM legacy_name_parse GROUP BY 1 ORDER BY 1")).toEqual([
      ["binomial", 1n],
      ["binomial with authorship", 4n],
      ["morphospecies", 3n],
      ["near", 1n],
      ["subgenus", 2n],
      ["trinomial", 5n],
      ["uninomial", 1n],
      ["unparsed", 1n],
    ]);
  });

  test("authorship is a name, never the third epithet of a trinomial", async () => {
    // The bug: Osmia montana carried authorship "montana", Bembix americana
    // "spinolae", Colletes consors "pascoensis" — and authorship prints on a
    // label, which is permanent once printed.
    expect(await parsed("Osmia montana montana")).toEqual([["Osmia", null, "montana", null, "Osmia montana montana"]]);
    expect(await parsed("Colletes consors pascoensis")).toEqual([
      ["Colletes", null, "consors", null, "Colletes consors pascoensis"],
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
    expect(await parsed("Not a bee")).toEqual([[null, null, null, null, null]]);
    expect(await parse("Not a bee")).toEqual([["unparsed"]]);
  });

  test("an authored binomial is not mistaken for a trinomial", async () => {
    expect(await parsed("Bombus vosnesenskii Radoszkowski, 1862")).toEqual([
      ["Bombus", null, "vosnesenskii", "Radoszkowski, 1862", null],
    ]);
  });

  test("subgenus comes from either column, bracketed or its own", async () => {
    expect(await parsed("Lasioglossum (Dialictus)")).toEqual([["Lasioglossum", "Dialictus", null, null, null]]);
    expect(await parsed("Andrena (Andrena)")).toEqual([["Andrena", "Andrena", null, null, null]]);
  });

  test("names the model has nowhere to put are named as such, not silently flattened", async () => {
    // Neither is a mistake anybody made: a determiner separated Melissodes
    // sp.1 from sp.5 deliberately, and "nr. tenax" says something precise.
    // The model records the genus and loses the rest — so the loss is at
    // least visible (beeline-tgu, beeline-8g7).
    expect(await rows(conn, "SELECT sci, parse, lands_on FROM legacy_name_flattened ORDER BY sci")).toEqual([
      ["Lasioglossum  sp.1", "morphospecies", "Lasioglossum"],
      ["Lasioglossum nr. tenax", "near", "Lasioglossum"],
      ["Melissodes sp.1", "morphospecies", "Melissodes"],
      ["Not a bee", "unparsed", ""],
      ["Stelis sp.7", "morphospecies", "Stelis"],
    ]);
  });
});
