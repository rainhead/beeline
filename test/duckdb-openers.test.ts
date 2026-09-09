import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every DuckDB this project opens must go through `openDuckDb` or
 * `openMemoryDuckDb` (src/db.ts), so that the stated memory and thread
 * budgets — and the BEELINE_DB default — apply to all of them.
 *
 * This test exists because the refactor that introduced those helpers missed
 * two call sites: the survey of what to change was a `grep | head`, which
 * silently stops at ten. `pnpm typecheck` and 544 tests passed over the gap,
 * because a direct `DuckDBInstance.create` is perfectly valid code. Only
 * counting them catches it.
 */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

async function tsFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await tsFiles(path)));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(path);
  }
  return found;
}

describe("DuckDB openers", () => {
  it("are all in src/db.ts", async () => {
    const offenders: string[] = [];
    for (const file of await tsFiles(SRC)) {
      if (file === join(SRC, "db.ts")) continue; // the definition itself
      const text = await readFile(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (line.includes("DuckDBInstance.create")) {
          offenders.push(`${file.slice(SRC.length)}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      `open these through openDuckDb/openMemoryDuckDb (src/db.ts) so the budgets apply:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
