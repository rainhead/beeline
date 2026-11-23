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
  it("reads 0 when the counters did not move", () => {
    expect(stealBetween(line(1000, 5), line(1000, 5))).toBe("0");
  });
});

describe("on-machine.sh refusing", () => {
  it("refuses when the machine is being throttled", () => {
    const dir = mkdtempSync(join(tmpdir(), "steal-"));
    const stat = join(dir, "stat");
    writeFileSync(stat, line(1000, 5000));
    // A fake `sleep` that moves the counters, so the test does not wait 5 seconds.
    writeFileSync(join(dir, "sleep"), `#!/bin/sh\nprintf '%s' '${line(1010, 5090)}' > "${stat}"\n`, { mode: 0o755 });
    const r = spawnSync("sh", [script, "pages"], {
      env: { PATH: `${dir}:${process.env.PATH}`, PROC_STAT: stat },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("90% of CPU time was stolen");
  });
});
