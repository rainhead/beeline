import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseCsv } from "./corrections.js";
import { openDuckDb } from "./db.js";
import { DEFAULT_DB } from "./person-change.js";
import {
  CURATED_TAXON_CURATION,
  CURATION_KINDS,
  curationKey,
  readTaxonCuration,
  rowProblem,
  writeTaxonCuration,
  type CurationKind,
  type TaxonCurationRow,
} from "./taxon-curation.js";

/**
 * Record a taxonomist's decision in ingest/taxon-curation.csv (beeline-45v.1).
 *
 * The decision is said in words — which name, which kind of claim, who, why,
 * the paper — by whoever read the taxonomist's answer: a person, or a model
 * reading the snapshot `pnpm taxon:fetch-sheet` wrote. What this fills in is
 * everything that reader should not be trusted to type: the ITIS TSN, what
 * ITIS calls the name instead, and the release those facts are from, looked
 * up in the store; and it refuses a decision the ITIS tables contradict — an
 * addition of a name ITIS has, a departure from a name ITIS still accepts, a
 * homonym choice that is not one of the candidates. The row then goes
 * through the same strict reader as the file itself, and the file is
 * merged: a later decision about the same name supersedes.
 *
 * The reason is the taxonomist's words, verbatim where there are any — "keep,
 * pending Gibbs 2011" — with where they came from ("by email, 2026-10-07").
 * A paraphrase is the reader's, not the taxonomist's, and the file credits
 * the taxonomist.
 */

export interface DecisionInput {
  kind: CurationKind;
  rank: string;
  name: string;
  taxonomist: string;
  reason: string;
  reference?: string;
  /** Homonym only: the TSN of the name meant. */
  tsn?: string;
  /** For a genus or family being added: where it files. */
  parent?: { rank: string; name: string };
  /** ISO date; today when omitted. */
  decidedOn?: string;
}

export interface ItisAnswer {
  /** By the ITIS tables alone, so a name not yet in the tree still answers. */
  standing: "absent" | "valid" | "synonym" | "homonym";
  /** The one TSN, where there is one. */
  tsn: string | null;
  /** For a synonym, what ITIS accepts instead ('; '-joined). */
  currentName: string | null;
  /** Every ITIS name at this rank and spelling. */
  candidates: { tsn: string; author: string | null; usage: string }[];
}

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** ITIS as the store holds it, asked by rank and spelling. */
export function itisFromStore(conn: DuckDBConnection): (rank: string, name: string) => Promise<ItisAnswer> {
  return async (rank, name) => {
    const rows = (await (
      await conn.run(
        `SELECT t.tsn, t.author, t.usage,
                (SELECT string_agg(cur.name, '; ' ORDER BY cur.name) FROM itis_synonym s JOIN itis_taxon cur ON cur.tsn = s.accepted_tsn WHERE s.tsn = t.tsn)
         FROM itis_taxon t WHERE t.rank = ${lit(rank)} AND t.name = ${lit(name)} ORDER BY t.tsn`,
      )
    ).getRows()) as [bigint, string | null, string, string | null][];
    const candidates = rows.map(([tsn, author, usage]) => ({ tsn: String(tsn), author, usage }));
    const valid = rows.filter((r) => r[2] === "valid");
    if (rows.length === 0) return { standing: "absent", tsn: null, currentName: null, candidates };
    if (valid.length > 1) return { standing: "homonym", tsn: null, currentName: null, candidates };
    if (valid.length === 1) return { standing: "valid", tsn: String(valid[0]![0]), currentName: null, candidates };
    const [tsn, , , current] = rows[0]!;
    return { standing: "synonym", tsn: rows.length === 1 ? String(tsn) : null, currentName: current, candidates };
  };
}

export async function itisRelease(conn: DuckDBConnection): Promise<string> {
  const [[d]] = (await (await conn.run("SELECT max(itis_as_of)::VARCHAR FROM itis_taxon")).getRows()) as [[string | null]];
  if (d === null) throw new Error("ITIS is not loaded in this store: run pnpm itis:load first, since a decision records the release it was made against");
  return d;
}

export interface DecideContext {
  itisRelease: string;
  today: string;
  itis: (rank: string, name: string) => Promise<ItisAnswer>;
}

const describe = (c: ItisAnswer["candidates"]) => c.map((x) => `${x.author ?? "no author"} [TSN ${x.tsn}, ${x.usage}]`).join(" | ");

/** One decision as a row the file accepts, or an error saying why ITIS does not agree with the kind claimed. */
export async function decide(input: DecisionInput, ctx: DecideContext): Promise<TaxonCurationRow> {
  const row: TaxonCurationRow = {
    kind: input.kind,
    rank: input.rank,
    name: input.name,
    parent_rank: input.parent?.rank ?? "",
    parent_name: input.parent?.name ?? "",
    itis_tsn: "",
    itis_current_name: "",
    itis_release: ctx.itisRelease,
    taxonomist: input.taxonomist,
    decided_on: input.decidedOn ?? ctx.today,
    reference: input.reference ?? "",
    reason: input.reason,
  };
  const where = `${input.name} (${input.rank})`;
  const itis = await ctx.itis(input.rank, input.name);
  switch (input.kind) {
    case "addition":
      if (itis.standing !== "absent") {
        throw new Error(`${where}: ITIS has this name (${itis.standing}: ${describe(itis.candidates)}), so it is not an addition`);
      }
      break;
    case "departure":
      if (itis.standing !== "synonym" || itis.tsn === null) {
        throw new Error(`${where}: ITIS does not call this name outdated (${itis.standing}${itis.candidates.length > 0 ? `: ${describe(itis.candidates)}` : ""}), so there is nothing to depart from`);
      }
      row.itis_tsn = itis.tsn;
      row.itis_current_name = itis.currentName ?? "";
      break;
    case "homonym": {
      const current = itis.candidates.filter((c) => c.usage === "valid");
      if (current.length < 2) {
        throw new Error(`${where}: ITIS has ${current.length} current name${current.length === 1 ? "" : "s"} at this spelling, so there is no choice to make`);
      }
      if (input.tsn === undefined || !current.some((c) => c.tsn === input.tsn)) {
        throw new Error(`${where}: say which with --tsn, one of: ${describe(current)}`);
      }
      row.itis_tsn = input.tsn;
      break;
    }
  }
  const bad = rowProblem(row);
  if (bad !== null) throw new Error(`${where}: ${bad}`);
  return row;
}

/**
 * The file with these decisions in it: a row for a name already decided is
 * superseded, the rest kept. A name decided twice in the same batch is
 * refused rather than last-wins: the reader meant one of them, and nothing
 * here can say which.
 */
export function mergeDecisions(existing: readonly TaxonCurationRow[], incoming: readonly TaxonCurationRow[]): TaxonCurationRow[] {
  const seen = new Set<string>();
  for (const r of incoming) {
    const k = curationKey(r);
    if (seen.has(k)) throw new Error(`${r.name} (${r.rank}): decided twice in one batch`);
    seen.add(k);
  }
  const byKey = new Map(existing.map((r) => [curationKey(r), r]));
  for (const r of incoming) byKey.set(curationKey(r), r);
  return [...byKey.values()];
}

/**
 * A batch: one decision per line, sharing the taxonomist and the date —
 * "every proposal on the sheet, as confirmed by email" is forty rows with one
 * signature. Columns: kind,rank,name,reason[,reference[,tsn[,parent_rank,parent_name]]].
 */
export const BATCH_COLUMNS = ["kind", "rank", "name", "reason", "reference", "tsn", "parent_rank", "parent_name"] as const;

export function parseBatch(text: string, where: string): Omit<DecisionInput, "taxonomist" | "decidedOn">[] {
  const records = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (records.length === 0) return [];
  const header = records[0]!.map((h) => h.trim());
  const required = BATCH_COLUMNS.slice(0, 4);
  for (const c of required) if (!header.includes(c)) throw new Error(`${where}: no column '${c}' (columns are ${BATCH_COLUMNS.join(",")})`);
  for (const h of header) if (!(BATCH_COLUMNS as readonly string[]).includes(h)) throw new Error(`${where}: '${h}' is not a column (columns are ${BATCH_COLUMNS.join(",")})`);
  const at = (r: string[], c: string) => (r[header.indexOf(c)] ?? "").trim();
  return records.slice(1).map((r, i) => {
    const kind = at(r, "kind");
    if (!(CURATION_KINDS as readonly string[]).includes(kind)) throw new Error(`${where} line ${i + 2}: '${kind}' is not a kind (${CURATION_KINDS.join(", ")})`);
    const parentRank = at(r, "parent_rank"), parentName = at(r, "parent_name");
    return {
      kind: kind as CurationKind,
      rank: at(r, "rank"),
      name: at(r, "name"),
      reason: at(r, "reason"),
      reference: at(r, "reference") || undefined,
      tsn: at(r, "tsn") || undefined,
      parent: parentRank !== "" || parentName !== "" ? { rank: parentRank, name: parentName } : undefined,
    };
  });
}

// CLI: pnpm taxon:decide <kind> <rank> "<name>" --by "L. Best" --reason "…" [--reference …] [--tsn …] [--parent "family Andrenidae"] [--on YYYY-MM-DD] [--db …] [--file …]
//      pnpm taxon:decide --batch decisions.csv --by "L. Best" [--on …] [--db …] [--file …]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      by: { type: "string" },
      reason: { type: "string" },
      reference: { type: "string" },
      tsn: { type: "string" },
      parent: { type: "string" },
      on: { type: "string" },
      batch: { type: "string" },
      db: { type: "string" },
      file: { type: "string" },
    },
  });
  const usage = () => {
    console.error(
      'usage: pnpm taxon:decide <addition|departure|homonym> <rank> "<name>" --by "<taxonomist>" --reason "<their words, and where from>" [--reference <doi or url>] [--tsn <n>] [--parent "<rank> <name>"] [--on YYYY-MM-DD]\n' +
        '       pnpm taxon:decide --batch <csv> --by "<taxonomist>" [--on YYYY-MM-DD]',
    );
    process.exit(2);
  };
  if (values.by === undefined || values.by.trim() === "") usage();
  let inputs: DecisionInput[];
  const shared = { taxonomist: values.by!, decidedOn: values.on };
  if (values.batch !== undefined) {
    if (positionals.length > 0) usage();
    inputs = parseBatch(await readFile(values.batch, "utf8"), values.batch).map((d) => ({ ...d, ...shared }));
  } else {
    const [kind, rank, name] = positionals;
    if (kind === undefined || rank === undefined || name === undefined || values.reason === undefined) usage();
    if (!(CURATION_KINDS as readonly string[]).includes(kind!)) usage();
    let parent: DecisionInput["parent"];
    if (values.parent !== undefined) {
      const space = values.parent.indexOf(" ");
      if (space < 1) usage();
      parent = { rank: values.parent.slice(0, space), name: values.parent.slice(space + 1) };
    }
    inputs = [{ kind: kind as CurationKind, rank: rank!, name: name!, reason: values.reason!, reference: values.reference, tsn: values.tsn, parent, ...shared }];
  }

  const instance = await openDuckDb(values.db ?? DEFAULT_DB);
  const conn = await instance.connect();
  let rows: TaxonCurationRow[];
  try {
    const ctx: DecideContext = { itisRelease: await itisRelease(conn), today: new Date().toISOString().slice(0, 10), itis: itisFromStore(conn) };
    // Every decision is checked before any is written, so a batch with one
    // bad line writes nothing.
    rows = [];
    for (const input of inputs) rows.push(await decide(input, ctx));
  } finally {
    conn.closeSync();
  }
  const file = values.file ?? CURATED_TAXON_CURATION;
  const before = await readTaxonCuration(file);
  const merged = mergeDecisions(before, rows);
  await writeTaxonCuration(file, merged);
  console.log(
    JSON.stringify(
      {
        recorded: rows.map((r) => `${r.kind}: ${r.name} (${r.rank})${r.itis_tsn !== "" ? ` TSN ${r.itis_tsn}` : ""}`),
        superseded: before.length + rows.length - merged.length,
        file,
        rowsInFile: merged.length,
        next: "review the diff, then pnpm taxon:apply [db]",
      },
      null,
      2,
    ),
  );
}
