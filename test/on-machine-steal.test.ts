import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "..", "bench", "on-machine.sh");

// Counts since boot: user nice system idle iowait irq softirq steal.
const line = (idle: number, steal: number) => `cpu  100 0 100 ${idle} 0 0 0 ${steal} 0 0\n`;

function stealBetween(a: string, b: string): string {
  const dir = mkdtempSync(join(tmpdir(), "steal-"));
  writeFileSync(join(dir, "a"), a);
  writeFileSync(join(dir, "b"), b);
  return execFileSync(
    "sh",
    ["-c", '. "$1"; steal_percent "$(head -n 1 "$2")" "$(head -n 1 "$3")"', "sh", script, join(dir, "a"), join(dir, "b")],
    { env: { ...process.env, ON_MACHINE_SOURCE_ONLY: "1" }, encoding: "utf8" },
  ).trim();
}

describe("on-machine.sh steal_percent", () => {
  it("measures growth, not the total since boot", () => {
    // 90 of the 100 ticks between the readings were stolen.
    expect(stealBetween(line(1000, 5000), line(1010, 5090))).toBe("90");
  });
  it("reads about 0 on an idle machine", () => {
    expect(stealBetween(line(1000, 5000), line(1100, 5000))).toBe("0");
  });
  it("does not count guest time twice", () => {
    // user and guest each grow 700 and steal 300: 300 of 1000, not 300 of 1700.
    const a = "cpu  0 0 0 0 0 0 0 0 0 0\n";
    const b = "cpu  700 0 0 0 0 0 0 300 700 0\n";
    expect(stealBetween(a, b)).toBe("30");
  });
  it("reads 0 when the counters did not move", () => {
    expect(stealBetween(line(1000, 5), line(1000, 5))).toBe("0");
  });
});

function runScript(before: string, after: string) {
  const dir = mkdtempSync(join(tmpdir(), "steal-"));
  const stat = join(dir, "stat");
  writeFileSync(stat, before);
  // A fake `sleep` that moves the counters, so the test does not wait 5 seconds.
  // The fake `node` stands in for the benchmark, in case a run passes the check.
  writeFileSync(join(dir, "sleep"), `#!/bin/sh\nprintf '%s' '${after}' > "${stat}"\n`, { mode: 0o755 });
  writeFileSync(join(dir, "node"), "#!/bin/sh\necho STARTED\n", { mode: 0o755 });
  return spawnSync("sh", [script, "pages"], {
    env: { PATH: `${dir}:${process.env.PATH}`, PROC_STAT: stat },
    encoding: "utf8",
  });
}

describe("on-machine.sh refusing", () => {
  it("refuses when the machine is being throttled", () => {
    const r = runScript(line(1000, 5000), line(1010, 5090));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("90% of CPU time was stolen");
  });
  it("allows exactly 20%", () => {
    expect(runScript(line(1000, 5000), line(1800, 5200)).stderr).not.toContain("stolen");
  });
  it("refuses 20.9%, which a whole number would round down to 20", () => {
    const r = runScript(line(1000, 5000), line(1791, 5209));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("20% of CPU time was stolen");
  });
});
