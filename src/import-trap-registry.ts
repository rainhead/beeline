import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { csvCell } from "./app/listings.js";
import { DEFAULT_DB } from "./person-change.js";
import { checkTrapSample, createTrapSample, type TrapSampleForm } from "./trap-sample.js";

/**
 * A one-time import of a staff spreadsheet of trap samples (beeline-3vs.3),
 * as the old Beeline's records were imported: Lincoln Best's registry of
 * Oregon's trap samples (Wet_Sample_Inventory.xlsx, 1,608 samples from 2018
 * to 2025), one row per sample.
 *
 * A row whose number Beeline has no trap sample for becomes a sample entered
 * in Beeline (`sample_entry`), credited to whoever runs the import, through
 * the same checks and writer as the form. A row whose number Beeline already
 * has is compared and never written: where the two disagree, the difference
 * is listed for somebody to settle, since the old record's labels are on
 * pins and the registry may be the one that is wrong.
 *
 * Only the columns a label prints or a Darwin Core record carries are read
 * (the scope rule on beeline-3vs): the number, the collectors, the start and
 * end days, the method, the point, and the place. Whether a bottle held
 * bumble bees, its taxon fractions, the lab's timings, and the notes stay in
 * the spreadsheet, and so does everything after the first sentence of the
 * method (what was flowering, a trap that tipped over).
 *
 * Collectors are read through ingest/trap-registry-collectors.csv, which maps
 * each spelling the registry uses to people, in order: the registry writes
 * one couple four ways, and a short table a person can check is better than
 * rules that guess. A spelling it lacks holds the row.
 *
 * What cannot be placed is held, with the reason, in a CSV beside the file.
 */

export const COLLECTOR_MAP = "ingest/trap-registry-collectors.csv";

export const HELD_REASONS = ["number_shape", "collector_unknown", "no_date", "refused"] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

export interface RegistryRow {
  sampleID: string | null;
  Collector: string | null;
  sampleMethod: string | null;
  startDay: string | null;
  startMonth: string | null;
  startYear: string | null;
  endDay: string | null;
  endMonth: string | null;
  endYear: string | null;
  Latitude: string | null;
  Longitude: string | null;
  Country: string | null;
  State: string | null;
  County: string | null;
  Locality: string | null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ROMAN = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];

/** A month as the registry writes it: a word, its first three letters, a number, or a Roman numeral. */
export function parseMonth(value: string | null): number | null {
  if (value === null) return null;
  const v = value.trim().toLowerCase().replace(/\.$/, "");
  if (v === "") return null;
  if (/^\d+(\.0+)?$/.test(v)) {
    const n = Number(v);
    return n >= 1 && n <= 12 ? n : null;
  }
  const roman = ROMAN.indexOf(v);
  if (roman >= 0) return roman + 1;
  const word = MONTHS.findIndex((m) => m === v || (v.length >= 3 && m.startsWith(v)));
  return word >= 0 ? word + 1 : null;
}

const whole = (value: string | null): number | null => {
  if (value === null || !/^\s*\d+(\.0+)?\s*$/.test(value)) return null;
  return Number(value);
};

/** A day from the registry's three columns, as YYYY-MM-DD; null if any part is missing or it is no date. */
export function registryDate(day: string | null, month: string | null, year: string | null): string | null {
  const d = whole(day);
  const m = parseMonth(month);
  const y = whole(year);
  if (d === null || m === null || y === null) return null;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

export interface ParsedMethod {
  kind: "trap" | "net";
  /** The kind of trap, as the form's list words it, or "trap" where the row does not say. */
  protocol: string;
  /** How many traps, where the row says and they are of one kind. */
  trapCount: number | null;
  /** The effort as written, where the row names more than one kind of trap and no count can stand for it. */
  effort: string | null;
}

/**
 * The method, from its first sentence: "6 vane traps", "16 pan traps", "12
 * yellow, 4 blue cups" (pan traps, counted by their cups), "42 pan traps, 14
 * vane traps", "one trap", "net". The rest of the cell is notes.
 */
export function parseMethod(value: string | null): ParsedMethod {
  const first = (value ?? "").split(".")[0]!.trim().toLowerCase();
  if (/^net\b/.test(first)) return { kind: "net", protocol: "aerial net", trapCount: null, effort: null };
  const vane = /\bvanes?\b/.test(first);
  const pan = /\b(pans?|cups?|bowl)\b/.test(first);
  if (vane && pan) {
    return { kind: "trap", protocol: "vane and pan traps", trapCount: null, effort: first };
  }
  const protocol = vane ? "vane trap" : pan ? "pan trap" : "trap";
  const numbers = [...first.matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1]));
  // Cups are counted by colour ("12 yellow, 4 blue cups"), so their numbers
  // add up; anywhere else, several numbers are not a count (CodeRabbit).
  const cups = /\bcups?\b/.test(first);
  const count =
    numbers.length === 0 ? (/^one\b/.test(first) ? 1 : null)
    : numbers.length === 1 ? numbers[0]!
    : cups ? numbers.reduce((a, b) => a + b, 0)
    : null;
  return { kind: "trap", protocol, trapCount: count, effort: null };
}

/** The registry's spelling of a collector list, as the map keys it: trimmed, runs of space as one. */
export const collectorKey = (s: string) => s.replace(/\s+/g, " ").trim();

export async function readCollectorMap(path = COLLECTOR_MAP): Promise<Map<string, string[]>> {
  const text = await readFile(path, "utf8");
  const map = new Map<string, string[]>();
  for (const line of text.split("\n").slice(1)) {
    if (line.trim() === "") continue;
    // verbatim,collectors,basis — the first two never hold a comma or a quote.
    const [verbatim, collectors] = line.split(",");
    map.set(collectorKey(verbatim!), collectors!.split("|").map((n) => n.trim()));
  }
  return map;
}

export interface Held {
  sampleID: string;
  reason: HeldReason;
  detail: string;
}

export interface Difference {
  sampleID: string;
  field: string;
  registry: string;
  beeline: string;
}

export interface ImportResult {
  rows: number;
  created: { active: number; settled: number };
  unchanged: number;
  differing: number;
  held: Record<HeldReason, number>;
  heldPath: string;
  differencesPath: string;
  dryRun: boolean;
}

export interface ImportOptions {
  file: string;
  /** The iNaturalist login of whoever runs the import, credited as the enterer. */
  by: string;
  collectorMap?: string;
  heldPath?: string;
  differencesPath?: string;
  dryRun?: boolean;
}

async function rows<T>(conn: DuckDBConnection, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await conn.runAndReadAll(sql, params as never)).getRowObjectsJS() as T[];
}

const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;

interface Existing {
  date_start: string;
  date_end: string;
  collectors: string | null;
  latitude: number | null;
  longitude: number | null;
}

export async function importTrapRegistry(conn: DuckDBConnection, opts: ImportOptions): Promise<ImportResult> {
  const [person] = await rows<{ person_id: number }>(conn, `SELECT person_id FROM inat_account WHERE login = $1`, [opts.by]);
  if (person === undefined) throw new Error(`--by ${opts.by}: no person signs in with that iNaturalist login`);
  const collectorMap = await readCollectorMap(opts.collectorMap);
  // The excel extension only for a spreadsheet: installing it may download it.
  const isCsv = opts.file.toLowerCase().endsWith(".csv");
  if (!isCsv) await conn.run("INSTALL excel; LOAD excel");
  const source = isCsv
    ? `read_csv(${sqlString(opts.file)}, header = true, all_varchar = true)`
    : `read_xlsx(${sqlString(opts.file)}, header = true, all_varchar = true, stop_at_empty = false)`;
  const registry = await rows<RegistryRow>(conn, `SELECT * FROM ${source} WHERE sampleID IS NOT NULL AND trim(sampleID) <> ''`);
  const [{ active_since }] = await rows<{ active_since: string }>(conn, `SELECT strftime(active_since, '%Y-%m-%d') AS active_since FROM season`) as [{ active_since: string }];

  const held: Held[] = [];
  const differences: Difference[] = [];
  const result: ImportResult = {
    rows: registry.length,
    created: { active: 0, settled: 0 },
    unchanged: 0,
    differing: 0,
    held: Object.fromEntries(HELD_REASONS.map((r) => [r, 0])) as Record<HeldReason, number>,
    heldPath: opts.heldPath ?? `${opts.file}.held.csv`,
    differencesPath: opts.differencesPath ?? `${opts.file}.differences.csv`,
    dryRun: opts.dryRun ?? false,
  };
  const hold = (sampleID: string, reason: HeldReason, detail: string) => {
    held.push({ sampleID, reason, detail });
    result.held[reason]++;
  };

  for (const row of registry) {
    const number = row.sampleID!.trim();
    if (!/^OBAS-\d{5}$/.test(number)) {
      hold(number, "number_shape", "not an OBAS- number with five digits");
      continue;
    }
    const verbatim = collectorKey(row.Collector ?? "");
    const collectors = collectorMap.get(verbatim);
    if (collectors === undefined) {
      hold(number, "collector_unknown", verbatim === "" ? "no collector" : verbatim);
      continue;
    }
    const start = registryDate(row.startDay, row.startMonth, row.startYear);
    if (start === null) {
      hold(number, "no_date", `${row.startDay ?? ""} ${row.startMonth ?? ""} ${row.startYear ?? ""}`.trim() || "no start day");
      continue;
    }
    // The start day stands for the end only where no end is written; an end
    // that is written but unreadable holds the row, since it would print (CodeRabbit).
    const endGiven = [row.endDay, row.endMonth, row.endYear].some((p) => p !== null && p.trim() !== "");
    const end = endGiven ? registryDate(row.endDay, row.endMonth, row.endYear) : start;
    if (end === null) {
      hold(number, "no_date", `end day: ${row.endDay ?? ""} ${row.endMonth ?? ""} ${row.endYear ?? ""}`.trim());
      continue;
    }
    const method = parseMethod(row.sampleMethod);

    const [existing] = await rows<Existing>(
      conn,
      `SELECT strftime(s.date_start, '%Y-%m-%d') AS date_start, strftime(s.date_end, '%Y-%m-%d') AS date_end,
              (SELECT string_agg(p.display_name, '|' ORDER BY c.position) FROM sample_collector c JOIN person p ON p.entity_id = c.person_id
               WHERE c.sample_id = s.entity_id) AS collectors,
              l.latitude, l.longitude
       FROM sample s LEFT JOIN sample_location l ON l.sample_id = s.entity_id
       -- A trap sample, or a net sample an earlier run entered from a row saying "net".
       WHERE s.sample_number = $1 AND (s.kind = 'trap' OR EXISTS (SELECT 1 FROM sample_entry e WHERE e.sample_id = s.entity_id))
       ORDER BY s.entity_id LIMIT 1`,
      [number],
    );
    if (existing !== undefined) {
      const found: Difference[] = [];
      const compare = (field: string, registryValue: string, beelineValue: string) => {
        if (registryValue !== beelineValue) found.push({ sampleID: number, field, registry: registryValue, beeline: beelineValue });
      };
      compare("start day", start, existing.date_start);
      compare("end day", end, existing.date_end);
      compare("collectors", collectors.join("|"), existing.collectors ?? "");
      const lat = Number(row.Latitude);
      const lon = Number(row.Longitude);
      // The registry rounds to three places, about 100 m.
      if (row.Latitude !== null && existing.latitude !== null && Math.abs(lat - existing.latitude) > 0.0015) {
        compare("latitude", String(lat), String(existing.latitude));
      }
      if (row.Longitude !== null && existing.longitude !== null && Math.abs(lon - existing.longitude) > 0.0015) {
        compare("longitude", String(lon), String(existing.longitude));
      }
      if (found.length === 0) result.unchanged++;
      else {
        result.differing++;
        differences.push(...found);
      }
      continue;
    }

    const form: TrapSampleForm = {
      sample_number: number,
      collectors,
      date_start: start,
      date_end: end,
      method: method.protocol,
      trap_count: method.trapCount === null ? "" : String(method.trapCount),
      specimen_count: "0",
      latitude: row.Latitude ?? "",
      longitude: row.Longitude ?? "",
      uncertainty: "",
      country: row.Country ?? "",
      state_province: row.State ?? "",
      county: row.County ?? "",
      locality: row.Locality ?? "",
    };
    const checked = await checkTrapSample(conn, form);
    if ("problems" in checked) {
      hold(number, "refused", Object.values(checked.problems).join(" "));
      continue;
    }
    const sample = method.effort === null ? checked.sample : { ...checked.sample, sampling_effort: method.effort };
    if (!result.dryRun) {
      const id = await createTrapSample(conn, sample, person.person_id, method.kind);
      if (id === "taken") {
        hold(number, "refused", `Trap sample ${number} is already in Beeline.`);
        continue;
      }
    }
    result.created[start >= active_since ? "active" : "settled"]++;
  }

  await writeFile(
    result.heldPath,
    ["sampleID,reason,detail", ...held.map((h) => [h.sampleID, h.reason, h.detail].map(csvCell).join(","))].join("\n") + "\n",
  );
  await writeFile(
    result.differencesPath,
    ["sampleID,field,registry,beeline", ...differences.map((d) => [d.sampleID, d.field, d.registry, d.beeline].map(csvCell).join(","))].join("\n") +
      "\n",
  );
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const valued = ["--by", "--held", "--differences"];
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1] ?? ""));
  const file = positional[0];
  const by = option("--by");
  if (file === undefined || by === undefined) {
    console.error("usage: pnpm trap:import <file.xlsx> [db] --by <iNaturalist login> [--held <path>] [--differences <path>] [--dry-run]");
    process.exit(2);
  }
  const { openDuckDb } = await import("./db.js");
  const instance = await openDuckDb(positional[1] ?? process.env.BEELINE_DB ?? DEFAULT_DB);
  const conn = await instance.connect();
  try {
    const result = await importTrapRegistry(conn, {
      file,
      by,
      heldPath: option("--held"),
      differencesPath: option("--differences"),
      dryRun: args.includes("--dry-run"),
    });
    await conn.run("CHECKPOINT");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    conn.closeSync();
  }
}
