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

  // The origin is concatenated into the OAuth redirect_uri, which iNaturalist
  // matches against its one registered URI exactly — and it is checked on the
  // token exchange as well as the authorize redirect, so a bad one fails
  // AFTER the person has signed in, showing only the generic failure page.
  // Refused at boot instead.
  it("refuses an origin that is not bare", () => {
    const base = { BEELINE_ENV: "sandbox", BEELINE_PRIVATE_DB_KEY: "k" };
    const origin = (o: string) => () => configFromEnv({ ...base, BEELINE_ORIGIN: o });
    expect(origin("https://beeline.fly.dev/")).toThrow(/bare origin/); // -> //auth/inat/callback
    expect(origin("https://beeline.fly.dev/app")).toThrow(/bare origin/);
    expect(origin("beeline.fly.dev")).toThrow(/absolute URL/);
    expect(origin("ftp://beeline.fly.dev")).toThrow(/http or https/);
    expect(origin("https://beeline.fly.dev")().origin).toBe("https://beeline.fly.dev");
    expect(origin("http://localhost:3054")().origin).toBe("http://localhost:3054");
  });

  // Pinned exactly, not loosely: this is a permission list, and a name
  // arriving in it should have to arrive in a diff too.
  it("the admin roster is checked in; the env var overrides it when set", () => {
    expect(configFromEnv({}).adminLogins).toEqual([
      "rainhead",
      "amelathopoulos",
      "clankford",
      "bzand",
      "karen_wright",
      "beesofcanada",
    ]);
    expect(configFromEnv({ BEELINE_ADMIN_LOGINS: "rainhead, amelathopoulos" }).adminLogins).toEqual([
      "rainhead",
      "amelathopoulos",
    ]);
    expect(configFromEnv({ BEELINE_ADMIN_LOGINS: "" }).adminLogins).toEqual([]); // explicit nobody
  });
});
