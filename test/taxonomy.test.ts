import { beforeEach, describe, expect, it } from "vitest";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { createKysely } from "../src/db.js";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { loadItis } from "../src/load-itis.js";
import { itisReportHref, parseTaxonomyQuery, taxonHref, taxonomyHref } from "../src/app/taxonomy.js";
import { createMemoryDb, insertCleanSample } from "./helpers.js";

/**
 * The taxonomy pages (beeline-45v.5).
 *
 * The tree is a slice of the dev store's — the real chain down from Animalia,
 * and a name for each standing animal_itis distinguishes — and the ITIS rows
 * are the ones test/itis.test.ts lifted from the 2026-08-26 release. Megachilidae
 * and Brachymelecta are absent only because that extract is small; the point
 * is the answer the page gives, not the fact about ITIS.
 *
 * Sandbox rather than development, because development makes everyone an
 * admin and this page is for people who are not.
 */

const ITIS = {
  taxonCsv: new URL("./fixtures/itis-taxon.csv", import.meta.url).pathname,
  synonymCsv: new URL("./fixtures/itis-synonym.csv", import.meta.url).pathname,
};

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};

let instance: DuckDBInstance;
let conn: DuckDBConnection;
const ids = new Map<string, number>();

async function node(rank: string, name: string, parent?: string): Promise<void> {
  const parentId = parent === undefined ? "NULL" : String(ids.get(parent));
  const result = await conn.run(
    `INSERT INTO animal (parent_id, rank, scientific_name) VALUES (${parentId}, '${rank}', '${name}') RETURNING entity_id`,
  );
  const [[id]] = (await result.getRows()) as [[number]];
  ids.set(name, id);
}

async function determine(specimen: number, name: string, recordedAt: string, expert = false): Promise<void> {
  await conn.run(`INSERT INTO determination (specimen_id, animal_id, is_expert, channel, recorded_at)
                  VALUES (${specimen}, ${ids.get(name)}, ${expert}, 'legacy_import', TIMESTAMPTZ '${recordedAt}')`);
}

beforeEach(async () => {
  ({ instance, conn } = await createMemoryDb());
  ids.clear();
  await node("kingdom", "Animalia");
  await node("phylum", "Arthropoda", "Animalia");
  await node("class", "Insecta", "Arthropoda");
  await node("order", "Hymenoptera", "Insecta");
  await node("family", "Halictidae", "Hymenoptera");
  await node("family", "Apidae", "Hymenoptera");
  await node("family", "Megachilidae", "Hymenoptera");
  await node("genus", "Lasioglossum", "Halictidae");
  await node("subgenus", "Lasioglossum (Dialictus)", "Lasioglossum");
  await node("species", "Lasioglossum tenax", "Lasioglossum");
  await node("species", "Lasioglossum zonulum", "Lasioglossum");
  await node("species", "Lasioglossum zonulus", "Lasioglossum");
  await node("genus", "Bombus", "Apidae");
  await node("species", "Bombus vosnesenskii", "Bombus");
  await node("genus", "Brachymelecta", "Apidae");
  await node("species", "Brachymelecta californica", "Brachymelecta");
  await node("genus", "Hoplitis", "Megachilidae");
  await node("species", "Hoplitis truncata", "Hoplitis");

  await conn.run(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Ada Collector')`);
  const sample = await insertCleanSample(conn);
  const specimens = (await (
    await conn.run(`INSERT INTO specimen (sample_id, specimen_number) VALUES (${sample}, 1), (${sample}, 2), (${sample}, 3)
                    RETURNING entity_id`)
  ).getRows()) as [number][];
  const [one, two, three] = specimens.map(([id]) => id);
  // A volunteer said tenax; an expert later said zonulum, and the expert's is
  // the determination of record — so tenax counts nothing.
  await determine(one!, "Lasioglossum tenax", "2024-07-01 12:00:00+00");
  await determine(one!, "Lasioglossum zonulum", "2025-01-10 12:00:00+00", true);
  await determine(two!, "Lasioglossum", "2024-07-01 12:00:00+00");
  await determine(three!, "Bombus vosnesenskii", "2024-07-01 12:00:00+00");
});

async function taxonomyApp({ itis = true, admin = false } = {}) {
  if (itis) await loadItis(conn, ITIS);
  if (admin) await conn.run(`INSERT INTO person_admin (person_id) VALUES (1)`);
  return createApp({
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: 1, login: "adacollects", iconUrl: null }),
  });
}

const page = async (app: Awaited<ReturnType<typeof taxonomyApp>>, path: string) => {
  const res = await app.request(path);
  expect(res.status, path).toBe(200);
  return res.text();
};

/** The table row linking to this name. */
const rowFor = (body: string, rank: string, name: string) =>
  body.split("<tr>").find((row) => row.includes(`href="${taxonHref({ rank, scientific_name: name })}"`)) ?? "";

const between = (body: string, start: string, end: string) => {
  const from = body.indexOf(start);
  return from < 0 ? "" : body.slice(from, body.indexOf(end, from));
};

const html = (url: string) => url.replaceAll("&", "&amp;");

describe("the taxonomy pages", () => {
  it("anyone signed in reads them, and finds them in the menu beside the brand with the glossary", async () => {
    const app = await taxonomyApp();
    const body = await page(app, "/taxonomy");
    const menu = between(body, 'class="menu nav-menu"', "</details>");
    const account = between(body, 'class="menu account-menu"', "</details>");
    const header = between(body, 'class="nav-inline"', "</nav>");
    expect(menu).toContain(`href="/taxonomy"`);
    expect(menu).toContain(`href="/glossary"`);
    // Grouped by purpose, shown by access: the staff tools are not offered.
    for (const staff of ["/people", "/jobs", "/design"]) expect(menu).not.toContain(`href="${staff}"`);
    // The account menu is about the person signed in, not a place to find pages.
    for (const path of ["/glossary", "/taxonomy"]) expect(account).not.toContain(`href="${path}"`);
    // The header keeps the records people work through, and only those; the
    // menu carries them too, for a phone, where the header nav is hidden.
    expect(header).toContain(`href="/samples"`);
    expect(header).toContain(`href="/specimens"`);
    expect(header).not.toContain(`href="/glossary"`);
    expect(header).not.toContain(`href="/taxonomy"`);
    expect(menu).toContain(`href="/samples"`);
  });

  it("offers an admin the staff tools in the same menu, and keeps them out of the account menu", async () => {
    const app = await taxonomyApp({ admin: true });
    const body = await page(app, "/taxonomy");
    const menu = between(body, 'class="menu nav-menu"', "</details>");
    const account = between(body, 'class="menu account-menu"', "</details>");
    for (const path of ["/glossary", "/taxonomy", "/people", "/jobs", "/design"]) {
      expect(menu).toContain(`href="${path}"`);
      expect(account).not.toContain(`href="${path}"`);
    }
    // Alphabetical, by the labels a person reads.
    const group = between(menu, `aria-label="${en.layout.more}"`, "</nav>");
    expect([...group.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "/design",
      "/glossary",
      "/jobs",
      "/people",
      "/taxonomy",
    ]);
  });

  it("starts browsing where the tree first branches, counting specimens by determination of record", async () => {
    const app = await taxonomyApp();
    const body = await page(app, "/taxonomy");
    // Animalia, Arthropoda, Insecta and Hymenoptera each hold one thing; the
    // families below Hymenoptera are the first real choice.
    for (const [rank, name] of [["kingdom", "Animalia"], ["class", "Insecta"], ["order", "Hymenoptera"]] as const) {
      expect(between(body, 'class="breadcrumbs"', "</nav>")).toContain(`href="${taxonHref({ rank, scientific_name: name })}"`);
    }
    expect(rowFor(body, "family", "Halictidae")).toContain("<td>2</td>");
    expect(rowFor(body, "family", "Apidae")).toContain("<td>1</td>");
    // Current in ITIS says nothing; absent says so.
    expect(rowFor(body, "family", "Halictidae")).not.toContain(`class="chip`);
    expect(rowFor(body, "family", "Megachilidae")).toContain(en.taxonomy.chip.absent);
    expect(body).toContain(en.taxonomy.summary.synonym(1));
  });

  it("shows a name where it is filed, what is filed below it, and what is determined to it alone", async () => {
    const app = await taxonomyApp();
    const body = await page(app, taxonHref({ rank: "genus", scientific_name: "Lasioglossum" }));
    const trail = between(body, 'class="breadcrumbs"', "</nav>");
    expect(trail).toContain(`href="/taxonomy"`);
    expect(trail).toContain(`href="${taxonHref({ rank: "family", scientific_name: "Halictidae" })}"`);
    expect(body).toContain(en.taxonomy.specimens(2));
    expect(body).toContain(en.taxonomy.determinedHere(1, "genus"));
    expect(body).toContain(`href="/specimens?taxon=Lasioglossum"`);
    expect(body).toContain(en.taxonomy.seeYourSpecimens);
    // The superseded volunteer determination counts for nothing.
    expect(rowFor(body, "species", "Lasioglossum tenax")).toContain("<td>0</td>");
    expect(rowFor(body, "species", "Lasioglossum zonulum")).toContain("<td>1</td>");
    // A subgenus is bracketed by construction, not by its stored spelling.
    expect(rowFor(body, "subgenus", "Lasioglossum (Dialictus)")).toContain("<i>Lasioglossum</i> (<i>Dialictus</i>)");
  });

  it("says how a name stands against ITIS, in full on its own page and briefly in a row", async () => {
    const app = await taxonomyApp();

    const valid = await page(app, taxonHref({ rank: "species", scientific_name: "Lasioglossum tenax" }));
    expect(valid).toContain(en.taxonomy.standing.valid);
    expect(valid).toContain(html(itisReportHref(759441)));

    // Outdated, and ITIS's current name is in the tree too, so it links there.
    const synonym = await page(app, taxonHref({ rank: "species", scientific_name: "Lasioglossum zonulum" }));
    expect(synonym).toContain(en.taxonomy.standing.synonym);
    expect(synonym).toContain(`href="${taxonHref({ rank: "species", scientific_name: "Lasioglossum zonulus" })}"`);
    expect(synonym).toContain(html(itisReportHref(759593)));

    // Two current ITIS names share the spelling, and the page shows both rather than choosing.
    const homonym = await page(app, taxonHref({ rank: "species", scientific_name: "Hoplitis truncata" }));
    expect(homonym).toContain(en.taxonomy.standing.homonym);
    expect(homonym).toContain("(Cresson, 1878)");
    expect(homonym).toContain("Wu, 1992");
    expect(homonym).toContain(html(itisReportHref(715497)));
    expect(homonym).toContain(html(itisReportHref(756786)));

    const absent = await page(app, taxonHref({ rank: "species", scientific_name: "Brachymelecta californica" }));
    expect(absent).toContain(en.taxonomy.standing.absent("species"));

    const genus = await page(app, taxonHref({ rank: "genus", scientific_name: "Lasioglossum" }));
    expect(rowFor(genus, "species", "Lasioglossum zonulum")).toContain(en.taxonomy.chip.synonym);
    expect(rowFor(genus, "species", "Lasioglossum tenax")).not.toContain(`class="chip`);
  });

  it("says ITIS is not loaded rather than calling every name absent", async () => {
    const app = await taxonomyApp({ itis: false });
    const body = await page(app, "/taxonomy");
    expect(body).toContain(en.taxonomy.notLoaded);
    expect(body).not.toContain(en.taxonomy.chip.absent);
    expect(body).not.toContain(`name="standing"`);
    const genus = await page(app, taxonHref({ rank: "genus", scientific_name: "Lasioglossum" }));
    expect(genus).toContain(en.taxonomy.notLoaded);
  });

  it("turns the index into a list when a name or a standing is asked for", async () => {
    const app = await taxonomyApp();

    const outdated = await page(app, "/taxonomy?standing=synonym");
    expect(outdated).toContain(en.taxonomy.found(1));
    expect(rowFor(outdated, "species", "Lasioglossum zonulum")).toContain(
      `href="${taxonHref({ rank: "genus", scientific_name: "Lasioglossum" })}"`,
    );
    expect(outdated).not.toContain(`href="${taxonHref({ rank: "species", scientific_name: "Lasioglossum tenax" })}"`);

    const named = await page(app, "/taxonomy?q=TENAX");
    expect(named).toContain(en.taxonomy.found(1));
    expect(named).toContain(`href="${taxonHref({ rank: "species", scientific_name: "Lasioglossum tenax" })}"`);

    // A name is never read as a pattern.
    expect(await page(app, "/taxonomy?q=%25")).toContain(en.taxonomy.found(0));
  });

  it("addresses a name by rank and name, which a rebuild does not redraw", async () => {
    const app = await taxonomyApp();
    expect(taxonHref({ rank: "subgenus", scientific_name: "Lasioglossum (Dialictus)" })).toBe(
      "/taxonomy/subgenus/Lasioglossum%20(Dialictus)",
    );
    await page(app, "/taxonomy/subgenus/Lasioglossum%20(Dialictus)");
    expect((await app.request("/taxonomy/genus/Nomada")).status).toBe(404);
    // The right name at the wrong rank is not that name.
    expect((await app.request("/taxonomy/species/Lasioglossum")).status).toBe(404);
  });

  it("keeps its filters in the URL", () => {
    const query = { search: "zon", standing: "synonym", page: 2 } as const;
    expect(parseTaxonomyQuery(new URL(taxonomyHref(query), "http://x").searchParams)).toEqual(query);
    expect(taxonomyHref({ search: "", standing: "any", page: 1 })).toBe("/taxonomy");
    expect(parseTaxonomyQuery(new URLSearchParams("standing=octarine&page=0"))).toEqual({
      search: "",
      standing: "any",
      page: 1,
    });
  });
});
