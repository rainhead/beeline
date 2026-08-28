import { describe, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { messagesFor } from "../src/app/messages/index.js";
import { createMemoryDb, rows } from "./helpers.js";

describe("message catalog", () => {
  it("resolves to English for any locale, for now", async () => {
    expect(messagesFor(null)).toBe(en);
    expect(messagesFor("fr-CA")).toBe(en);
  });

  it("formats numbers per locale and pluralizes in interpolations", () => {
    expect(en.qc.summary(1200, 3)).toBe("1,200 samples need attention — 3 flags block label printing.");
    expect(en.qc.summary(1, 0)).toBe("1 sample needs attention.");
  });

  it("date formatters pass the proofing placeholder through", () => {
    expect(en.qc.sampleTitle("7", "«sample»")).toBe("Sample 7 · «sample»");
    expect(en.qc.sampleTitle("7", new Date("2026-07-14T12:00:00"))).toContain("Jul");
  });

  it("carries instructions for exactly the QC rules the schema declares", async () => {
    const { conn } = await createMemoryDb();
    const ruleNames = (await rows(conn, "SELECT name FROM qc_rule ORDER BY name")).map(([name]) => name as string);
    expect(Object.keys(en.qcInstructions).sort()).toEqual(ruleNames);
  });

  it("describes exactly the jobs the registry builds", async () => {
    const { buildJobs } = await import("../src/app/jobs/registry.js");
    const names = buildJobs({ syncProjects: [], sweepDays: 365 })
      .map((j) => j.name)
      .sort();
    expect(Object.keys(en.jobs.descriptions).sort()).toEqual(names);
  });

  it("lists glossary entries alphabetically, because it is a page for looking a word up", () => {
    const terms = Object.values(en.glossary.entries).map((e) => e.term);
    const sorted = [...terms].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), "en"));
    expect(terms).toEqual(sorted);
  });

  it("sets its nomenclature examples the way the entries say to set them", () => {
    // A definition that says "genus names are italic" beside a roman Bombus
    // teaches the opposite (beeline-0i2.6), so the examples are data.
    const withExamples = Object.entries(en.glossary.entries).filter(([, e]) => "example" in e);
    expect(withExamples.map(([slug]) => slug).sort()).toEqual([
      "authorship",
      "cf-aff",
      "scientific-name",
      "sensu-stricto",
      "sp",
      "subgenus",
    ]);
    // And no entry smuggles a name into its prose instead.
    for (const [slug, entry] of Object.entries(en.glossary.entries)) {
      expect(entry.definition, slug).not.toMatch(/Bombus/);
    }
  });

});
