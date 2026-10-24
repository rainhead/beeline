import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchEcdysisTaxonomy, parsePhpCsv, readExport } from "../src/fetch-ecdysis-taxonomy.js";

/**
 * Fetching Ecdysis's thesaurus (beeline-7gob).
 *
 * The export lines are real: lifted byte for byte from Ecdysis's export of
 * Lepidoptera on 2026-10-23 (test/fixtures/ecdysis-taxonomy-export.csv), the
 * header and Animalia's row, Hozbeka, whose author Ecdysis stores
 * double-encoded and with a backslash before a quote, and Anarsia
 * achresella, whose author is quoted. The tree the fetch walks below is
 * synthetic, built from those rows and real ids: what is under test is the
 * splitting, not Ecdysis's tree.
 */

const EXPORT = new URL("./fixtures/ecdysis-taxonomy-export.csv", import.meta.url).pathname;

describe("PHP's CSV", () => {
  test("a backslash before a quote does not end the field, and a doubled quote is a quote", async () => {
    const rows = readExport(await readFile(EXPORT, "utf8"), "the fixture");
    expect(rows.map((r) => [r.tid, r.name, r.author, r.rank_id, r.status, r.accepted_tid])).toEqual([
      ["1", "Animalia", "Linnaeus, 1758", "10", "accepted", "1"],
      // As Ecdysis stores it: its API answers the same string for taxon 864345.
      ["864345", "Hozbeka", 'Ã\u0083â\u0080\\"zdikmen, 2009', "180", "accepted", "864345"],
      ["499160", "Anarsia achresella", '"Shah Patel Patel," 1988', "220", "accepted", "499160"],
    ]);
  });

  test("the byte-order mark is not part of the first column's name", () => {
    expect(parsePhpCsv("﻿taxonID,scientificName\n1,Animalia\n")).toEqual([["taxonID", "scientificName"], ["1", "Animalia"]]);
  });

  test("a file that is not the taxonomy export is refused", () => {
    expect(() => readExport("tid,name\n1,Animalia\n", "a CSV")).toThrow(/not Symbiota's taxonomy export/);
  });
});

/** A stand-in for Ecdysis: an export per taxon id, 500 for those too large, and the tree browser's children. */
function ecdysis(exports: Record<number, string | 500>, children: Record<number, { id: number; label: string }[]>) {
  const asked: string[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/v2/taxonomy?taxon=Insecta")) {
      asked.push("api Insecta");
      return Response.json({ results: [{ tid: 6, rankID: 60, kingdomName: "Animalia" }] });
    }
    if (url.includes("getdynamicchildren.php")) {
      const id = Number(new URL(url).searchParams.get("id"));
      asked.push(`children ${id}`);
      return Response.json({ id, children: children[id] ?? [] });
    }
    const target = Number(new URLSearchParams(String(init?.body)).get("target"));
    asked.push(`export ${target}`);
    const body = exports[target];
    if (body === 500 || body === undefined) return new Response("", { status: 500 });
    return new Response(body);
  };
  return { f, asked };
}

const HEADER = (await readFile(EXPORT, "utf8")).split("\n")[0]!;
const ANIMALIA = "1,Animalia,\"Linnaeus, 1758\",Animalia,,,,,,10,Animalia,,1,Animalia,1,1,Animalia";
const row = (tid: number, name: string, rankId: number, parent: number) =>
  `${tid},${name},,${name},,,,,,${rankId},Animalia,,${parent},,1,${tid},${name}`;

describe("fetching the insects", () => {
  test("a branch too large to export is split into its children, and a name two exports share is written once", async () => {
    const { f, asked } = ecdysis(
      {
        6: 500,
        7: 500,
        82673: [HEADER, ANIMALIA, row(82673, "Diptera", 100, 35)].join("\n"),
        82681: [HEADER, ANIMALIA, row(82681, "Hymenoptera", 100, 35)].join("\n"),
        655263: [HEADER, ANIMALIA, row(655263, "Apterygota", 70, 6)].join("\n"),
      },
      {
        6: [{ id: 655263, label: "2-70-Subclass-Apterygota" }, { id: 7, label: "2-70-Subclass-Pterygota" }],
        7: [{ id: 82673, label: "2-100-Order-Diptera" }, { id: 82681, label: "2-100-Order-Hymenoptera" }],
      },
    );
    const dir = await mkdtemp(join(tmpdir(), "beeline-ecdysis-taxonomy-"));
    try {
      const result = await fetchEcdysisTaxonomy({ dir, fetch: f, now: new Date("2026-10-24T05:12:21Z"), retryDelayMs: 0 });
      // A failed export is asked again once before it is split.
      expect(asked).toEqual([
        "api Insecta",
        "export 6",
        "export 6",
        "children 6",
        "export 655263",
        "export 7",
        "export 7",
        "children 7",
        "export 82673",
        "export 82681",
      ]);
      expect(result.exports.map((e) => e.name)).toEqual(["Apterygota", "Diptera", "Hymenoptera"]);
      const written = (await readFile(result.path, "utf8")).trim().split("\n");
      expect(written[0]).toBe("tid,name,author,rank_id,parent_tid,status,accepted_tid");
      // Animalia came with every export and is written once.
      expect(written.filter((l) => l.startsWith("1,Animalia,"))).toEqual(['1,Animalia,"Linnaeus, 1758",10,1,accepted,1']);
      expect(written).toHaveLength(5);
      const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({ fetchedAt: "2026-10-24T05:12:21.000Z", taxa: 4 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a 500 that passes is not taken for a branch too large to export", async () => {
    let failed = false;
    const { f: inner, asked } = ecdysis({ 6: [HEADER, ANIMALIA, row(6, "Insecta", 60, 4)].join("\n") }, {});
    const f: typeof fetch = async (input, init) => {
      if (String(input).includes("taxonomydisplay.php") && !failed) {
        failed = true;
        asked.push("export 6 (500)");
        return new Response("", { status: 500 });
      }
      return inner(input, init);
    };
    const dir = await mkdtemp(join(tmpdir(), "beeline-ecdysis-taxonomy-"));
    try {
      const result = await fetchEcdysisTaxonomy({ dir, fetch: f, retryDelayMs: 0 });
      expect(asked).toEqual(["api Insecta", "export 6 (500)", "export 6"]);
      expect(result.exports.map((e) => e.name)).toEqual(["Insecta"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a gateway that fails twice fails the fetch, naming the taxon", async () => {
    const f: typeof fetch = async (input) =>
      String(input).includes("/api/v2/taxonomy")
        ? Response.json({ results: [{ tid: 6, rankID: 60, kingdomName: "Animalia" }] })
        : new Response("", { status: 503 });
    const dir = await mkdtemp(join(tmpdir(), "beeline-ecdysis-taxonomy-"));
    try {
      await expect(fetchEcdysisTaxonomy({ dir, fetch: f, retryDelayMs: 0 })).rejects.toThrow(/unavailable for the export of taxon 6, twice/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a name that cannot be exported and has no children to split into fails the fetch, and writes nothing", async () => {
    const { f } = ecdysis({ 6: 500 }, {});
    const dir = await mkdtemp(join(tmpdir(), "beeline-ecdysis-taxonomy-"));
    try {
      await expect(fetchEcdysisTaxonomy({ dir, fetch: f, retryDelayMs: 0 })).rejects.toThrow(/could not export Insecta/);
      await expect(readFile(join(dir, "ecdysis-taxa.csv"), "utf8")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
