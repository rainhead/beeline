import { describe, expect, it } from "vitest";
import {
  governanceFor,
  inForce,
  parseProgramLicenses,
  parseProgramPrivacyPolicies,
  readProgramGovernance,
} from "../src/program-governance.js";

const LICENSES = "program,from_season,license,decided_by,decided_on,source,reason";
const POLICIES = "program,from_season,url,decided_by,decided_on,reason";
const licenses = (...rows: string[]) => parseProgramLicenses([LICENSES, ...rows].join("\n"), "licenses.csv");
const policies = (...rows: string[]) => parseProgramPrivacyPolicies([POLICIES, ...rows].join("\n"), "policies.csv");

describe("program licences and privacy policies", () => {
  it("reads the curated files in ingest/", async () => {
    // A malformed decision must fail here rather than on the night's run.
    const g = await readProgramGovernance();
    expect(g.licenses.length).toBeGreaterThan(0);
    for (const l of g.licenses) expect(l.source).not.toBe("");
  });

  it("holds a row from its season until the program's next, and the latest from then on", () => {
    const rows = licenses(
      "OBA,2018,CC-BY-4.0,Test,2026-10-10,https://example.org/2018,First",
      "OBA,2019,CC-BY-NC-4.0,Test,2026-10-10,https://example.org/2019,Changed",
      "WaBA,2023,CC-BY-NC-4.0,Test,2026-10-10,https://example.org/waba,Seen",
    );
    expect(inForce(rows, "OBA", 2017)).toBeNull();
    expect(inForce(rows, "OBA", 2018)?.license).toBe("CC-BY-4.0");
    expect(inForce(rows, "OBA", 2019)?.license).toBe("CC-BY-NC-4.0");
    // The presumption: a program continues with the licence it last used.
    expect(inForce(rows, "OBA", 2031)?.license).toBe("CC-BY-NC-4.0");
    expect(inForce(rows, "WaBA", 2022)).toBeNull();
    expect(inForce(rows, "BC", 2026)).toBeNull();
  });

  it("finds the order of rows irrelevant", () => {
    const rows = licenses(
      "OBA,2019,CC-BY-NC-4.0,Test,2026-10-10,https://example.org/2019,Changed",
      "OBA,2018,CC-BY-4.0,Test,2026-10-10,https://example.org/2018,First",
    );
    expect(inForce(rows, "OBA", 2025)?.license).toBe("CC-BY-NC-4.0");
  });

  it("asks for both a licence and a policy, each in force on its own range", () => {
    const g = {
      licenses: licenses("OBA,2017,CC-BY-NC-4.0,Test,2026-10-10,https://example.org/oba,Seen"),
      policies: policies("OBA,2026,,Test,2026-10-10,Agreed in a meeting; not yet published"),
    };
    expect(governanceFor(g, "OBA", 2025)).toMatchObject({ policy: null });
    const now = governanceFor(g, "OBA", 2026);
    expect(now.license?.license).toBe("CC-BY-NC-4.0");
    expect(now.policy?.url).toBe("");
  });

  it("refuses what the loader cannot transcribe", () => {
    const row = (license: string) => `OBA,2017,${license},Test,2026-10-10,https://example.org,Why`;
    // Only the licences GBIF accepts.
    expect(() => licenses(row("CC-BY-SA-4.0"))).toThrow(/not one GBIF accepts/);
    expect(() => licenses(row("CC-BY-NC-4.0"), row("CC-BY-4.0"))).toThrow(/OBA from 2017 is stated twice/);
    expect(() => licenses("OBA,17,CC-BY-4.0,Test,2026-10-10,https://example.org,Why")).toThrow(/not a season/);
    expect(() => licenses("OBA,2017,CC-BY-4.0,,2026-10-10,https://example.org,Why")).toThrow(/who decided/);
    expect(() => licenses("OBA,2017,CC-BY-4.0,Test,2026-10-10,,Why")).toThrow(/where it was seen/);
    expect(() => licenses("OBA,2017,CC-BY-4.0,Test,2026-10-10,https://example.org,")).toThrow(/says why/);
    expect(() => policies("OBA,2026,not a url,Test,2026-10-10,Why")).toThrow(/not a web address/);
    expect(() => parseProgramLicenses("program,season\nOBA,2017", "x.csv")).toThrow(/header/);
  });
});
