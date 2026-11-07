import { describe, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { es } from "../src/app/messages/es.js";
import { messagesFor } from "../src/app/messages/index.js";
import { createMemoryDb, rows } from "./helpers.js";

describe("message catalog", () => {
  it("resolves to Spanish for Spanish locales, English otherwise", async () => {
    expect(messagesFor(null)).toBe(en);
    expect(messagesFor("fr-CA")).toBe(en);
    expect(messagesFor("es")).toBe(es);
    expect(messagesFor("es-MX")).toBe(es);
    expect(messagesFor("es-419")).toBe(es);
  });

  it("formats numbers per locale and pluralizes in interpolations", () => {
    expect(en.qc.summary(1200, 3, 0, 0)).toBe("1,200 samples need attention (3 cannot print until fixed)");
    // Waiting only: the clause has to carry its own subject.
    expect(en.qc.summary(0, 0, 3, 0)).toBe("3 samples are waiting on labels");
    expect(en.qc.summary(0, 0, 1, 0)).toBe("1 sample is waiting on labels");
    expect(en.qc.summary(1, 0, 2, 1)).toBe(
      "1 sample needs attention · 2 are waiting on labels · 1 observation still says 0 specimens",
    );
    expect(en.qc.summary(0, 0, 0, 0, 2)).toBe("2 observations have no sample number");
    // A day's skipped numbers: plural by how many numbers, not how many runs.
    expect(en.qc.skipped.day("«day»", ["3"], 1)).toBe("«day»: no sample 3");
    expect(en.qc.skipped.day("«day»", ["3–5"], 3)).toBe("«day»: no samples 3–5");
    expect(en.qc.skipped.day("«day»", ["2", "7"], 2)).toBe("«day»: no samples 2 and 7");

    // Spanish catalog interpolations:
    expect(es.qc.summary(1200, 3, 0, 0)).toBe("1,200 muestras necesitan atención (3 no pueden imprimirse hasta corregirse)");
    expect(es.qc.summary(0, 0, 3, 0)).toBe("3 muestras están esperando etiquetas");
    expect(es.qc.summary(0, 0, 1, 0)).toBe("1 muestra está esperando etiquetas");
    expect(es.qc.summary(1, 0, 2, 1)).toBe(
      "1 muestra necesita atención · 2 están esperando etiquetas · 1 observación aún indica 0 ejemplares",
    );
    expect(es.qc.summary(0, 0, 0, 0, 2)).toBe("2 observaciones no tienen número de muestra");
    expect(es.qc.skipped.day("«day»", ["3"], 1)).toBe("«day»: sin muestra 3");
    expect(es.qc.skipped.day("«day»", ["3–5"], 3)).toBe("«day»: sin muestras 3–5");
    expect(es.qc.skipped.day("«day»", ["2", "7"], 2)).toBe("«day»: sin muestras 2 y 7");
  });

  it("date formatters pass the proofing placeholder through", () => {
    expect(en.qc.sampleTitle("7", "«sample»")).toBe("Sample 7 · «sample»");
    expect(en.qc.sampleTitle("7", new Date("2026-07-14T12:00:00"))).toContain("Jul");

    expect(es.qc.sampleTitle("7", "«sample»")).toBe("Muestra 7 · «sample»");
    expect(es.qc.sampleTitle("7", new Date("2026-07-14T12:00:00"))).toMatch(/jul/i);
  });

  it("names a print run by when it was prepared, in Pacific time, and its scope — never by its id (GitHub #105)", () => {
    expect(en.printRuns.run.title(new Date("2026-09-28T21:05:07Z"), null)).toBe("Print run 2026-09-28 14:05:07 PDT · program");
    // Winter, and a UTC evening that is still the day before in Oregon.
    expect(en.printRuns.run.title(new Date("2026-01-03T03:00:09Z"), "WA")).toBe("Print run 2026-01-02 19:00:09 PST · WA");
    // Midnight reads 00, not 24.
    expect(en.printRuns.run.title(new Date("2026-09-28T07:00:00Z"), null)).toBe("Print run 2026-09-28 00:00:00 PDT · program");

    expect(es.printRuns.run.title(new Date("2026-09-28T21:05:07Z"), null)).toBe("Tirada de impresión 2026-09-28 14:05:07 GMT-7 · programa");
  });

  it("carries instructions for exactly the QC rules the schema declares", async () => {
    const { conn } = await createMemoryDb();
    const ruleNames = (await rows(conn, "SELECT name FROM qc_rule ORDER BY name")).map(([name]) => name as string);
    expect(Object.keys(en.qcInstructions).sort()).toEqual(ruleNames);
    expect(Object.keys(es.qcInstructions).sort()).toEqual(ruleNames);
  });

  it("describes exactly the jobs the registry builds", async () => {
    const { buildJobs } = await import("../src/app/jobs/registry.js");
    const names = buildJobs({
      syncProjects: [],
      sweepDays: 365,
      personChangesPath: "unused.csv",
      sampleChangesPath: "unused.csv",
      sampleStatePath: "unused.csv",
    })
      .map((j) => j.name)
      .sort();
    expect(Object.keys(en.jobs.descriptions).sort()).toEqual(names);
    expect(Object.keys(es.jobs.descriptions).sort()).toEqual(names);
  });

  it("lists glossary entries alphabetically, because it is a page for looking a word up", () => {
    const terms = Object.values(en.glossary.entries).map((e) => e.term);
    const sorted = [...terms].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), "en"));
    expect(terms).toEqual(sorted);

    const esTerms = Object.values(es.glossary.entries).map((e) => e.term);
    const esSorted = [...esTerms].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), "es"));
    expect(esTerms).toEqual(esSorted);
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

    const esWithExamples = Object.entries(es.glossary.entries).filter(([, e]) => "example" in e);
    expect(esWithExamples.map(([slug]) => slug).sort()).toEqual([
      "authorship",
      "cf-aff",
      "scientific-name",
      "sensu-stricto",
      "sp",
      "subgenus",
    ]);
    for (const [slug, entry] of Object.entries(es.glossary.entries)) {
      expect(entry.definition, slug).not.toMatch(/Bombus/);
    }
  });

});
