import { describe, expect, it } from "vitest";
import { en } from "../src/app/messages/en.js";
import { messagesFor } from "../src/app/messages/index.js";
import { createMemoryDb, rows } from "./helpers.js";

describe("message catalog", () => {
  it("resolves to English for any locale, for now", async () => {
    expect(messagesFor(null)).toBe(en);
    expect(messagesFor("fr-CA")).toBe(en);
  });

  it("formats numbers per locale in interpolations", () => {
    expect(en.home.holdings(66314, 584)).toBe("Holding 66,314 samples from 584 people.");
  });

  it("carries instructions for exactly the QC rules the schema declares", async () => {
    const { conn } = await createMemoryDb();
    const ruleNames = (await rows(conn, "SELECT name FROM qc_rule ORDER BY name")).map(([name]) => name as string);
    expect(Object.keys(en.qcInstructions).sort()).toEqual(ruleNames);
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
