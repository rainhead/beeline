import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * fly.toml holds settings whose failure mode is silence, so they are pinned
 * here rather than trusted to review.
 *
 * The one that prompted this: `kill_timeout` was written at the foot of the
 * file, which in TOML puts it inside whichever table opened last — in this
 * case `[[http_service.checks]]`, where Fly never reads it. The 120 seconds
 * DuckDB needs to checkpoint became the 5-second default, and nothing said
 * so: `fly config validate` reports that file as valid, because an unknown
 * key inside a health check is not an error to Fly. A misplaced key is not a
 * syntax error in any tool we run. It is only wrong against intent.
 *
 * So the parser below is deliberately not a TOML parser. It answers exactly
 * one question — which table does this bare key belong to — because that is
 * the rule that was broken, and a full parse would hide it behind a nested
 * lookup that reads as if it had always been correct.
 */
const FLY_TOML = fileURLToPath(new URL("../fly.toml", import.meta.url));

interface Entry {
  /** The table this key landed in: "" for top level, else e.g. "http_service.checks". */
  table: string;
  value: string;
}

function scanToml(text: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  let table = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s*#.*$/, "").trim();
    if (line === "") continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      table = header[1]!.trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (kv) entries.set(`${table}:${kv[1]}`, { table, value: kv[2]!.replace(/^"|"$/g, "") });
  }
  return entries;
}

const read = async () => scanToml(await readFile(FLY_TOML, "utf8"));

describe("fly.toml", () => {
  it("keeps kill_signal and kill_timeout at the top level, not inside a table", async () => {
    const entries = await read();
    // Named by their full key so a move into any table fails here rather than
    // at 2am on a machine Fly restarted for host maintenance.
    for (const key of ["kill_signal", "kill_timeout"]) {
      const found = [...entries].filter(([k]) => k.endsWith(`:${key}`));
      expect(found, `${key} is absent from fly.toml`).toHaveLength(1);
      expect(found[0]![1].table, `${key} belongs to top level, not [${found[0]![1].table}]`).toBe("");
    }
  });

  it("keeps swap_size_mb at the top level, where Fly reads it", async () => {
    const entries = await read();
    const found = [...entries].filter(([k]) => k.endsWith(":swap_size_mb"));
    expect(found, "swap_size_mb is absent from fly.toml").toHaveLength(1);
    // Not a [[vm]] key: written there it is dropped in the same silence, and
    // the machine runs with no swap. DuckDB's memory_limit governs only
    // DuckDB — the Node heap is what swap is for.
    expect(found[0]![1].table, `swap_size_mb belongs to top level, not [${found[0]![1].table}]`).toBe("");
  });

  it("allows DuckDB long enough to checkpoint on shutdown", async () => {
    const entries = await read();
    const timeout = entries.get(":kill_timeout")!.value;
    const seconds = Number(/^(\d+)s$/.exec(timeout)?.[1]);
    // An uncheckpointed WAL carrying DDL can leave the store unopenable on
    // DuckDB <= 1.5.5 (beeline-c1b). The default 5s is not enough.
    expect(seconds).toBeGreaterThanOrEqual(60);
    expect(entries.get(":kill_signal")!.value).toBe("SIGTERM");
  });

  it("keeps both stores on the mounted volume", async () => {
    const entries = await read();
    const destination = entries.get("mounts:destination")!.value;
    // A store path outside the mount is not an error anyone sees: the app
    // opens it, serves from it, and the machine's next redeploy discards it
    // with the container layer.
    for (const key of ["BEELINE_DB", "BEELINE_PRIVATE_DB"]) {
      const path = entries.get(`env:${key}`);
      expect(path, `${key} is not set in [env]`).toBeDefined();
      expect(path!.value.startsWith(`${destination}/`), `${key}=${path!.value} is not under ${destination}`).toBe(true);
    }
  });

  it("never lets the machine stop, because the scheduler is in-process", async () => {
    const entries = await read();
    // A suspended machine runs no nightly and no Sunday sweep, and nothing
    // alarms — the data just quietly stops arriving (src/app/jobs/).
    expect(entries.get("http_service:auto_stop_machines")!.value).toBe("off");
    expect(entries.get("http_service:min_machines_running")!.value).toBe("1");
  });

  it("leaves DuckDB room to work, and room around it", async () => {
    const entries = await read();
    const mb = (v: string) => {
      const m = /^(\d+)\s*(mb|gb)$/i.exec(v.trim());
      return Number(m![1]) * (m![2].toLowerCase() === "gb" ? 1024 : 1);
    };
    const duckdb = mb(entries.get("env:BEELINE_DUCKDB_MEMORY_LIMIT")!.value);
    const machine = mb(entries.get("vm:memory")!.value);
    // The nightly, not the browsing, is what this sizes for: 384 MB was set
    // from a measurement of the legacy import and the observation path failed
    // outright on it — every 15 minutes, invisibly. 512 MB was the measured
    // floor against the deployed store's corpus, which grows nightly.
    expect(duckdb).toBeGreaterThanOrEqual(384*2);
    // And DuckDB must not be promised more than the machine has, or its limit
    // stops being a limit and the kernel decides instead. The process needs
    // roughly 250 MB beyond DuckDB's own budget.
    expect(machine - duckdb).toBeGreaterThanOrEqual(512);
  });

  it("serves on the port the app is told to listen on", async () => {
    const entries = await read();
    expect(entries.get("http_service:internal_port")!.value).toBe(entries.get("env:PORT")!.value);
  });
});
