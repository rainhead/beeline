import { describe, expect, it } from "vitest";
import { configFromEnv } from "../src/app/config.js";

describe("configFromEnv sync settings (beeline-vni)", () => {
  it("parses comma-separated project ids and a day count", () => {
    const config = configFromEnv({ BEELINE_SYNC_PROJECTS: "18521, 166376,99706", BEELINE_SWEEP_DAYS: "30" });
    expect(config.syncProjects).toEqual([18521, 166376, 99706]);
    expect(config.sweepDays).toBe(30);
  });

  it("rejects malformed project ids at boot, not at 2am", () => {
    expect(() => configFromEnv({ BEELINE_SYNC_PROJECTS: "99706;99707" })).toThrow(/BEELINE_SYNC_PROJECTS/);
    expect(() => configFromEnv({ BEELINE_SYNC_PROJECTS: "18521,oops" })).toThrow(/BEELINE_SYNC_PROJECTS/);
  });

  it("rejects a sweep depth that is not a whole positive number of days", () => {
    expect(() => configFromEnv({ BEELINE_SWEEP_DAYS: "1yr" })).toThrow(/BEELINE_SWEEP_DAYS/);
    expect(() => configFromEnv({ BEELINE_SWEEP_DAYS: "0" })).toThrow(/BEELINE_SWEEP_DAYS/);
  });
});

describe("configFromEnv deploy safety", () => {
  it("requires BEELINE_ORIGIN outside development (beeline-4cb)", () => {
    const base = { BEELINE_ENV: "sandbox", BEELINE_PRIVATE_DB_KEY: "k" };
    expect(() => configFromEnv(base)).toThrow(/BEELINE_ORIGIN/);
    const config = configFromEnv({ ...base, BEELINE_ORIGIN: "https://beeline.example" });
    expect(config.origin).toBe("https://beeline.example");
  });

  it("parses the admin allowlist", () => {
    expect(configFromEnv({ BEELINE_ADMIN_LOGINS: "rainhead, amelathopoulos" }).adminLogins).toEqual([
      "rainhead",
      "amelathopoulos",
    ]);
    expect(configFromEnv({}).adminLogins).toEqual([]);
  });
});
