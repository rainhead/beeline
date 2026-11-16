import { strToU8, zipSync } from "fflate";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { fetchArchive } from "../src/fetch-archive.js";

/**
 * Downloading a museum's published archive (beeline-muke) against a stand-in
 * for GBIF's registry and the publisher's IPT. The addresses, the registry's
 * answer and the archive's three files are shaped as OSAC's Oregon Bee Atlas
 * dataset's were on 2026-11-15: the registry lists the archive under
 * DWC_ARCHIVE, the IPT serves an earlier version at the same address with
 * `&v=`, and answers 401 for a version it keeps private.
 */

const DATASET = "1fa69ff3-3e40-465f-927f-12b1484d3731";
const ENDPOINT = "https://osac.oregonstate.edu/ipt/archive.do?r=osac-oba";

const zipOf = (version: string, dataset = DATASET) =>
  zipSync({
    "occurrence.txt": strToU8(`id\toccurrenceID\n1\thttps://osac.oregonstate.edu/OBS/OBA_1 v${version}\n`),
    "eml.xml": strToU8(`<eml packageId="${dataset}/v${version}"><pubDate>\n 2026-11-04\n</pubDate></eml>`),
    "meta.xml": strToU8(`<archive metadata="eml.xml"><core rowType="Occurrence"><files>\n<location>occurrence.txt</location></files></core></archive>`),
  });

let dir: string;
let asked: string[];
const answers: typeof fetch = async (input) => {
  const url = String(input);
  asked.push(url);
  if (url === `https://api.gbif.org/v1/dataset/${DATASET}`) {
    return Response.json({ endpoints: [{ type: "EML", url: "https://osac.oregonstate.edu/ipt/eml.do?r=osac-oba" }, { type: "DWC_ARCHIVE", url: ENDPOINT }] });
  }
  if (url === ENDPOINT) return new Response(zipOf("1.9"));
  if (url === `${ENDPOINT}&v=1.6`) return new Response(zipOf("1.6"));
  if (url === `${ENDPOINT}&v=1.2`) return new Response("private", { status: 401 });
  return new Response("not found", { status: 404 });
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "archive-fetch-"));
  asked = [];
});

describe("fetching a published archive", () => {
  test("asks GBIF's registry where the publisher's archive is, and unpacks it under the version it states", async () => {
    const fetched = await fetchArchive({ datasetKey: DATASET, dir, fetch: answers });
    expect(fetched).toEqual({ datasetKey: DATASET, version: "1.9", publishedOn: "2026-11-04", url: ENDPOINT, dir: join(dir, DATASET, "1.9") });
    expect(asked).toEqual([`https://api.gbif.org/v1/dataset/${DATASET}`, ENDPOINT]);
    expect(await readFile(join(fetched.dir, "occurrence.txt"), "utf8")).toContain("v1.9");
    expect(await readFile(join(fetched.dir, "eml.xml"), "utf8")).toContain(`${DATASET}/v1.9`);
  });

  test("an earlier version is asked of the IPT by number", async () => {
    const fetched = await fetchArchive({ datasetKey: DATASET, version: "1.6", dir, fetch: answers });
    expect(fetched).toMatchObject({ version: "1.6", url: `${ENDPOINT}&v=1.6`, dir: join(dir, DATASET, "1.6") });
  });

  test("a version the IPT keeps private, a wrong key and another dataset's archive are refused", async () => {
    await expect(fetchArchive({ datasetKey: DATASET, version: "1.2", dir, fetch: answers })).rejects.toThrow(/answered 401/);
    await expect(fetchArchive({ datasetKey: "oregon-bee-atlas", dir, fetch: answers })).rejects.toThrow(/not a GBIF dataset key/);
    const other: typeof fetch = async (input) =>
      String(input) === ENDPOINT ? new Response(zipOf("1.9", "00000000-0000-0000-0000-000000000000")) : answers(input);
    await expect(fetchArchive({ datasetKey: DATASET, dir, fetch: other })).rejects.toThrow(/is dataset 00000000/);
  });
});
