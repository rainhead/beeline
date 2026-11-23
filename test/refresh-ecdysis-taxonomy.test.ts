import type { DuckDBConnection } from "@duckdb/node-api";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { fetchEcdysisTaxonomy } from "../src/fetch-ecdysis-taxonomy.js";
import { describeRefresh, refreshEcdysisTaxonomy } from "../src/load-ecdysis-taxonomy.js";
import { createMemoryDb, insertCleanSample, rows } from "./helpers.js";

/**
 * The weekly refresh of Ecdysis's taxonomy (beeline-xni1). The fetch is
 * stood in for by copying the fixture (real rows of the fetch of 2026-10-24,
 * test/fixtures/ecdysis-taxonomy/) into the job's folder, edited where a
 * test needs Ecdysis to have changed its mind; the edits are labelled.
 */

const FIXTURE = new URL("./fixtures/ecdysis-taxonomy/", import.meta.url).pathname;

let conn: DuckDBConnection;
let dir: string;

/** A stand-in for the fetch: the fixture, with `edit` applied to its CSV and the manifest dated `day`. */
const fetchFixture =
  (day: string, edit: (csv: string) => string = (csv) => csv): typeof fetchEcdysisTaxonomy =>
  async (options = {}) => {
    const target = options.dir!;
    await cp(FIXTURE, target, { recursive: true });
    const csv = edit(await readFile(join(target, "ecdysis-taxa.csv"), "utf8"));
    await writeFile(join(target, "ecdysis-taxa.csv"), csv);
    const taxa = csv.trim().split("\n").length - 1;
    await writeFile(join(target, "manifest.json"), JSON.stringify({ fetchedAt: `${day}T05:00:00.000Z`, taxa, exports: [] }));
    return { path: join(target, "ecdysis-taxa.csv"), fetchedAt: `${day}T05:00:00.000Z`, taxa, exports: [] };
  };

async function node(rank: string, name: string, parent: string | null): Promise<void> {
  await conn.run(
    `INSERT INTO animal (rank, scientific_name, parent_id)
     SELECT '${rank}', '${name}', ${parent === null ? "NULL" : `(SELECT entity_id FROM animal WHERE scientific_name = '${parent}')`}`,
  );
}

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  dir = join(await mkdtemp(join(tmpdir(), "ecdysis-refresh-")), "taxonomy");
  await node("kingdom", "Animalia", null);
  await node("phylum", "Arthropoda", "Animalia");
  await node("class", "Insecta", "Arthropoda");
  await node("order", "Hymenoptera", "Insecta");
  await node("family", "Apidae", "Hymenoptera");
  await node("family", "Vespidae", "Hymenoptera");
  await node("genus", "Euodynerus", "Vespidae");
});

describe("the weekly refresh of Ecdysis's taxonomy", () => {
  test("loads a first fetch and reports nothing as moved", async () => {
    const result = await refreshEcdysisTaxonomy(conn, { dir, fetchTaxonomy: fetchFixture("2026-10-24") });
    expect(result).toMatchObject({ previousFetchedOn: null, moved: [], curationStale: 0, draftsNoLongerOffered: { active: 0, settled: 0 } });
    // 60 rows, of which 54 are at ranks the store admits.
    expect(result.load.taxa).toBe(54);
    expect(await rows(conn, "SELECT count(*) FROM ecdysis_adoptable WHERE name = 'Chrysis'")).toEqual([[1n]]);
  });

  test("reports the tree's names that moved in Ecdysis, and drafts whose name is no longer offered", async () => {
    await refreshEcdysisTaxonomy(conn, { dir, fetchTaxonomy: fetchFixture("2026-10-24") });
    // A volunteer's draft names Chrysis from Ecdysis, not yet adopted.
    const ada = Number((await rows(conn, "INSERT INTO person (display_name) VALUES ('Ada Adams') RETURNING entity_id"))[0]![0]);
    const sample = await insertCleanSample(conn, { collector_id: String(ada), sample_number: "'1'" });
    const specimen = Number(
      (await rows(conn, `INSERT INTO specimen (sample_id, specimen_number, field_number) VALUES (${sample}, 1, '26000101') RETURNING entity_id`))[0]![0],
    );
    await conn.run(`INSERT INTO determination_draft (specimen_id, determiner_id, ecdysis_tid) VALUES (${specimen}, ${ada}, 106248)`);
    // Synthetic edits: Ecdysis makes Euodynerus a synonym of Bombus, and drops Chrysis.
    const later = fetchFixture("2026-11-21", (csv) =>
      csv
        .replace('287425,Euodynerus,"Dalla Torre, 1904",180,96610,accepted,287425', '287425,Euodynerus,"Dalla Torre, 1904",180,96610,synonym,173433')
        .replace(/^106248,Chrysis,.*\n/m, ""),
    );
    const result = await refreshEcdysisTaxonomy(conn, { dir, fetchTaxonomy: later });
    expect(result.previousFetchedOn).toBe("2026-10-24");
    expect(result.moved).toEqual([{ rank: "genus", name: "Euodynerus", was: "accepted", now: "synonym of Bombus" }]);
    // The sample insertCleanSample makes is in the current season.
    expect(result.draftsNoLongerOffered).toEqual({ active: 1, settled: 0 });
    expect(describeRefresh(result)).toContain("Euodynerus (was accepted, now synonym of Bombus)");
    expect(describeRefresh(result)).toContain("volunteer drafts naming a taxon Ecdysis no longer offers: 1 in the active seasons, 0 in settled ones");
  });

  test("names each node it filed under a tribe, and says the tree is in step", async () => {
    await node("genus", "Bombus", "Apidae");
    const result = await refreshEcdysisTaxonomy(conn, { dir, fetchTaxonomy: fetchFixture("2026-10-24") });
    expect(result.load.filing.moved).toEqual([{ rank: "genus", name: "Bombus", from: "Apidae", to: "Bombini" }]);
    expect(result.load.filing.created.map((c) => c.name)).toEqual(["Apinae", "Bombini"]);
    expect(result.load.filingStale).toBe(0);
    const line = describeRefresh(result);
    expect(line).toContain("Bombus: Apidae to Bombini");
    expect(line).toContain("2 subfamilies, tribes and subtribes created");
    expect(line).toContain("every node sits where Ecdysis files it");
  });

  test("refuses a fetch that shrank by more than a twentieth, and leaves the store as it was", async () => {
    await refreshEcdysisTaxonomy(conn, { dir, fetchTaxonomy: fetchFixture("2026-10-24") });
    // Synthetic: an export that lost most of its rows.
    const truncated = fetchFixture("2026-11-21", (csv) => csv.split("\n").slice(0, 20).join("\n") + "\n");
    await expect(refreshEcdysisTaxonomy(conn, { dir, fetchTaxonomy: truncated })).rejects.toThrow(/fewer than 95%/);
    expect(await rows(conn, "SELECT DISTINCT CAST(fetched_on AS TEXT) FROM ecdysis_taxon")).toEqual([["2026-10-24"]]);
  });

  test("counts the names the store keeps, so names gained at ranks it drops cannot hide a loss", async () => {
    await refreshEcdysisTaxonomy(conn, { dir, fetchTaxonomy: fetchFixture("2026-10-24") });
    // Synthetic: three species gone (54 kept become 51, 94%), and ten names
    // added at a rank the store does not keep (200, below subtribe and above
    // genus in Symbiota's numbering, which animal_rank skips): 70 rows against
    // the first 60.
    const tribes = Array.from({ length: 10 }, (_, i) => `${9100000 + i},Sectio${i},,200,86587,accepted,${9100000 + i}`).join("\n");
    const lossHidden = fetchFixture("2026-11-21", (csv) =>
      csv
        .replace(/^236821,.*\n/m, "")
        .replace(/^237038,.*\n/m, "")
        .replace(/^245760,.*\n/m, "")
        .concat(`${tribes}\n`),
    );
    await expect(refreshEcdysisTaxonomy(conn, { dir, fetchTaxonomy: lossHidden })).rejects.toThrow(/keeps 51 names against the 54/);
    expect(await rows(conn, "SELECT DISTINCT CAST(fetched_on AS TEXT) FROM ecdysis_taxon")).toEqual([["2026-10-24"]]);
  });
});
