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
    expect(en.qc.summary(1200, 3)).toBe("1,200 samples need attention — 3 findings block label printing.");
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

  it("has all three pronoun sets the schema allows", () => {
    // person.pronouns CHECK ('he','she','they') — the catalog must cover them.
    for (const set of ["he", "she", "they"] as const) {
      expect(en.pronounForms[set].subject).toBeTruthy();
      expect(en.pronounForms[set].object).toBeTruthy();
      expect(en.pronounForms[set].possessive).toBeTruthy();
    }
  });
});
