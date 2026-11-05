import { describe, expect, it } from "vitest";
import type { InatClient } from "../src/app/auth.js";
import { createApp } from "../src/app/server.js";
import { en } from "../src/app/messages/en.js";
import { QC_RULE_NAMES } from "../src/app/listings.js";
import { createKysely } from "../src/db.js";
import { createMemoryDb, insertCleanSample, rows, scratchPaths } from "./helpers.js";

/**
 * The samples listing's Flags column (beeline-ik0d, Peter 2026-11-04): one
 * chip per kind of flag, named for the problem, and a filter for one kind.
 */

const unusedInat: InatClient = {
  authorizeUrl: () => "unused",
  exchangeCode: () => Promise.reject(new Error("not under test")),
  identity: () => Promise.reject(new Error("not under test")),
};
const s = en.listings.status;

async function setup() {
  const { instance, conn } = await createMemoryDb();
  const [[staff]] = (await rows(
    conn,
    `INSERT INTO person (display_name, given_name, family_name) VALUES ('Sam Staff', 'Sam', 'Staff') RETURNING entity_id`,
  )) as [[number]];
  await conn.run(`INSERT INTO person_admin (person_id) VALUES (${staff})`);
  // A locality too long for a label, and held by staff with a reason.
  const held = await insertCleanSample(conn, { sample_number: "'H'", locality: "'Finley National Wildlife Refuge'" });
  await conn.run(
    `INSERT INTO sample_hold (sample_id, reason, held_by)
     VALUES (${held}, 'Pin is in the river; asked the collector to move it', ${staff})`,
  );
  // Five kinds of flag at once (accuracy, no locality, place abbreviation,
  // and two more): more than a cell shows.
  const many = await insertCleanSample(
    conn,
    { sample_number: "'M'", locality: "NULL", county: "NULL", country: "'United States'" },
    { coordinate_uncertainty_m: "500" },
  );
  const clean = await insertCleanSample(conn, { sample_number: "'C'" });
  const app = createApp({
    ...(await scratchPaths()),
    db: createKysely(instance),
    config: { environment: "sandbox" as const, origin: "http://localhost:3054" },
    inat: unusedInat,
    resolveSession: async () => ({ personId: staff, login: "staff", iconUrl: null }),
  });
  const get = async (path: string) => (await app.request(path)).text();
  return { get, conn, ids: { held, many, clean } };
}

const link = (id: number) => `href="/samples/${id}"`;

describe("the Flags column", () => {
  it("shows a hold by its reason, cut short, with the whole reason in its panel", async () => {
    const { get } = await setup();
    const page = await get("/samples?scope=all");
    expect(page).toContain(`Pin is in the river; as…<span class="visually-hidden">: ${s.flagSeverity.blocking}</span>`);
    expect(page).toContain("<q>Pin is in the river; asked the collector to move it</q>");
    expect(page).toContain(`${s.flag.locality_format}<span class="visually-hidden">`);
  });

  it("shows three kinds of flag and links to the sample for the rest", async () => {
    const { get, ids } = await setup();
    const page = await get("/samples?scope=all");
    expect(page).toContain(`<a href="/samples/${ids.many}">${s.flagMore(2)}</a>`);
    // Blocking first: the county is only a heads-up, so it is among those
    // left over, and its chip is not drawn.
    expect(page).not.toContain(`${s.flag.missing_recommended_field}<span class="visually-hidden">`);
  });

  it("filters to one kind of flag", async () => {
    const { get, ids } = await setup();
    const page = await get("/samples?scope=all&flag=staff_hold");
    expect(page).toContain(link(ids.held));
    expect(page).not.toContain(link(ids.many));
    expect(page).not.toContain(link(ids.clean));
    expect(page).toContain(`${en.listings.filters.flagKind}: ${s.flag.staff_hold}`);
    // Not a rule: ignored, as any other unknown value is.
    const unknown = await get("/samples?scope=all&flag=nonsense");
    for (const id of [ids.held, ids.many, ids.clean]) expect(unknown).toContain(link(id));
  });

  it("names exactly the rules the schema declares", async () => {
    const { conn } = await createMemoryDb();
    const ruleNames = (await rows(conn, "SELECT name FROM qc_rule ORDER BY name")).map(([name]) => name as string);
    expect([...QC_RULE_NAMES].sort()).toEqual(ruleNames);
    expect(Object.keys(s.flag).sort()).toEqual(ruleNames);
  });
});
