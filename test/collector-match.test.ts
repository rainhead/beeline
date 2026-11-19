import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import { foldName, matchCollectors } from "../src/collector-match.js";
import { checkTrapSample, type TrapSampleForm } from "../src/trap-sample.js";
import { createMemoryDb, CURRENT_SEASON, rows } from "./helpers.js";

/**
 * Naming collectors (beeline-kgyd.4.5). The spellings are the ones AGENTS.md
 * records from the old Beeline's records, where 'MaryJo Mosby' became
 * 'Mary Jo Mosby' and 'Amy Grotta' was once typed 'Amy GRotta'; the accented
 * name and the pair who fold together are synthetic, since production has
 * neither (store of 18 November 2026).
 */

let conn: DuckDBConnection;
const ids: Record<string, number> = {};

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  for (const name of ["Mary Jo Mosby", "Amy Grotta", "José Ruiz", "Ann Lee", "AnnLee", "Emily Hoskins"]) {
    const [[id]] = (await rows(conn, `INSERT INTO person (display_name) VALUES ('${name}') RETURNING entity_id`)) as [[number]];
    ids[name] = Number(id);
  }
  await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${ids["Amy Grotta"]}, 4242, 'agrotta')`);
});

const names = async (entries: string[], staff = true) => {
  const found = await matchCollectors(conn, entries, { staff });
  return "problem" in found ? found.problem : found.collectors.map((c) => c.display_name);
};

describe("naming collectors", () => {
  it("takes a display name exactly, in the order given", async () => {
    expect(await names(["Amy Grotta", "Mary Jo Mosby"])).toEqual(["Amy Grotta", "Mary Jo Mosby"]);
  });

  it("folds typography and case: a respelling and a stray capital still name the person", async () => {
    expect(await names(["MaryJo Mosby", "  amy GRotta  "])).toEqual(["Mary Jo Mosby", "Amy Grotta"]);
  });

  it("reads an accented letter as its base letter", async () => {
    expect(await names(["Jose Ruiz"])).toEqual(["José Ruiz"]);
    expect(foldName("José Ruiz")).toBe("joseruiz");
  });

  it("takes an exact name before the fold, so a name two people fold to still names the one written that way", async () => {
    expect(await names(["AnnLee"])).toEqual(["AnnLee"]);
    expect(await names(["Ann Lee"])).toEqual(["Ann Lee"]);
    expect(await names(["ann-lee"])).toBe("ann-lee could be any of Ann Lee, AnnLee; name one by their id or iNaturalist login.");
  });

  it("takes a person's id, or their iNaturalist login or user id", async () => {
    expect(await names([String(ids["Emily Hoskins"]), "inat:AGrotta"])).toEqual(["Emily Hoskins", "Amy Grotta"]);
    expect(await names(["inat:4242"])).toEqual(["Amy Grotta"]);
    expect(await names(["999999"])).toBe("Beeline has nobody whose id is 999999.");
    expect(await names(["inat:nobody"])).toBe("Beeline knows nobody by the iNaturalist login nobody.");
    expect(await names(["inat:999999999999999999999999"])).toBe("Beeline knows nobody by the iNaturalist user id 999999999999999999999999.");
    // A cached login can answer for two accounts in different case until the next sync: refused, not guessed.
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${ids["Ann Lee"]}, 4343, 'AGrotta')`);
    expect(await names(["inat:agrotta"])).toBe("2 people answer to the iNaturalist login agrotta; name one by their id.");
  });

  it("does not know an old spelling promotion recorded and the overlay resolves: only display names are read", async () => {
    // 'Emma Hoskins' is an alias of Emily Hoskins in ingest/collector-aliases.csv's sense, which this rule does not read.
    expect(await names(["Emma Hoskins"])).toBe("Beeline has nobody called Emma Hoskins; add them on /unclaimed or /people first.");
  });

  it("refuses an empty list, a name with no letters, and one person twice", async () => {
    expect(await names(["", "  "])).toBe("At least one collector is needed.");
    expect(await names(["--"])).toBe('"--" is not a name.');
    expect(await names(["Amy Grotta", "inat:agrotta"])).toBe("Amy Grotta is named twice.");
  });

  it("tells a collector, who cannot reach the staff pages, to ask staff", async () => {
    expect(await names(["Emma Hoskins"], false)).toBe("Beeline has nobody called Emma Hoskins; ask staff to add them.");
    expect(await names(["ann-lee"], false)).toBe("ann-lee could be any of Ann Lee, AnnLee; ask staff to tell them apart.");
  });

  it("is the trap form's rule too", async () => {
    const form: TrapSampleForm = {
      sample_number: "OBAS-20300",
      collectors: ["MaryJo Mosby", "inat:agrotta"],
      date_start: `${CURRENT_SEASON}-06-16`,
      date_end: `${CURRENT_SEASON}-07-12`,
      method: "vane trap",
      trap_count: "",
      specimen_count: "",
      latitude: "42.005",
      longitude: "-118.592",
      uncertainty: "",
      country: "USA",
      state_province: "OR",
      county: "Malheur",
      locality: "Fields-Denio N",
    };
    const checked = await checkTrapSample(conn, form);
    if (!("sample" in checked)) throw new Error(JSON.stringify(checked.problems));
    expect(checked.sample.collector_ids).toEqual([ids["Mary Jo Mosby"], ids["Amy Grotta"]]);
    const refused = await checkTrapSample(conn, { ...form, collectors: ["ann-lee"] });
    expect("problems" in refused && refused.problems.collectors).toMatch(/could be any of .*; ask staff to tell them apart/);
    const forStaff = await checkTrapSample(conn, { ...form, collectors: ["Dee Nobody"] }, null, { staff: true });
    expect("problems" in forStaff && forStaff.problems.collectors).toMatch(/add them on \/unclaimed or \/people first/);
  });
});
