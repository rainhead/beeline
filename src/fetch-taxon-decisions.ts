import type { DuckDBConnection } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";
import { openDuckDb } from "./db.js";
import { accessToken, fileMeta, sheetTabs } from "./google-drive.js";
import { DEFAULT_DB } from "./person-change.js";
import {
  CURATED_TAXON_CURATION,
  curationKey,
  readTaxonCuration,
  rowProblem,
  writeTaxonCuration,
  type TaxonCurationRow,
} from "./taxon-curation.js";

/**
 * A taxonomist's answers, from the Google Sheet they were asked in, into
 * ingest/taxon-curation.csv (beeline-45v.1).
 *
 * The sheet is the worklist built from the store on 2026-10-02 — names ITIS
 * does not have, names ITIS would rename, two names at one spelling, and the
 * wasps for whoever determines bycatch — with a yellow column per row for the
 * decision, who made it, a reference and notes. This reads those columns by
 * their headings and turns each decision into a curation row, or holds it
 * with the reason it could not:
 *
 *   "Keep" on a name ITIS lacks            → an addition
 *   "Keep the program's name" on a rename  → a departure, with what ITIS says
 *   "Follow ITIS" on a rename              → nothing: ITIS is the default
 *   a choice between two authors           → a homonym resolution, by TSN
 *
 * A decision with nobody in "Decided by" is held: every row credits a
 * taxonomist, and this transcribes rather than decides. A misspelling or
 * "use ITIS's name" is a spelling alias (ingest/taxon-aliases.csv) or a
 * rename rather than a curation claim, so it is reported for a hand to do,
 * never written here. Tabs 3 and 5 are about the program's own checklist and
 * are summarised, not loaded.
 *
 * What ITIS said at the time comes from the store's ITIS tables rather than
 * from the sheet, since the sheet's columns were written for a reader and the
 * row records a TSN; `decided_on` is the sheet's last-modified date, the
 * only clock it has. The file is merged, not replaced: a decision already in
 * it for the same name is superseded, every other row kept — and nothing is
 * applied to the store here, which is promotion's job and `pnpm taxon:apply`.
 */

export interface SheetTab {
  title: string;
  rows: string[][];
}

export interface ItisAnswer {
  /** absent | valid | synonym | homonym — by the ITIS tables alone, so a name not yet in the tree still answers. */
  standing: "absent" | "valid" | "synonym" | "homonym";
  /** The one TSN, where there is one. */
  tsn: string | null;
  /** For a synonym, what ITIS accepts instead ('; '-joined). */
  currentName: string | null;
  /** Every ITIS name at this rank and spelling. */
  candidates: { tsn: string; author: string | null; usage: string }[];
}

export interface DecisionContext {
  itisRelease: string;
  decidedOn: string;
  itis: (rank: string, name: string) => Promise<ItisAnswer>;
}

export interface Held {
  tab: string;
  rank: string;
  name: string;
  problem: string;
}

export interface DecisionsResult {
  rows: TaxonCurationRow[];
  held: Held[];
  /** Renames the taxonomist told us to follow: no row, counted so the report says they were read. */
  followed: number;
  /** Lines for ingest/taxon-aliases.csv, for a hand to review and paste. */
  aliasCandidates: string[];
  /** Everything else said that is not a curation row: morphospecies, removals, checklist answers. */
  notes: string[];
}

const header = (tab: SheetTab) => tab.rows[0] ?? [];
const col = (tab: SheetTab, heading: string): number => {
  const i = header(tab).findIndex((h) => h.trim().toLowerCase() === heading.toLowerCase());
  if (i < 0) throw new Error(`tab '${tab.title}' has no column headed '${heading}'`);
  return i;
};
const cell = (row: string[], i: number) => (row[i] ?? "").trim();

/** Which worklist a tab is: by its leading number, so a retitled tab still reads. */
export function tabKind(title: string): "absent" | "rename" | "checklist" | "homonym" | "spelling" | "wasps" | null {
  const m = /^(\d)\b/.exec(title.trim());
  switch (m?.[1]) {
    case "1": return "absent";
    case "2": return "rename";
    case "3": return "checklist";
    case "4": return "homonym";
    case "5": return "spelling";
    case "6": return "wasps";
    default: return null;
  }
}

/**
 * The one TSN a free-text answer names among the candidates: a TSN written
 * out, or an author's surname — "Cresson" — that exactly one candidate has.
 */
export function chooseCandidate(text: string, candidates: ItisAnswer["candidates"]): string | null {
  const byTsn = candidates.filter((c) => new RegExp(`\\b${c.tsn}\\b`).test(text));
  if (byTsn.length === 1) return byTsn[0]!.tsn;
  const lower = text.toLowerCase();
  const byAuthor = candidates.filter((c) => {
    const surname = (c.author ?? "").replace(/^\(/, "").split(/[,\s]/)[0]?.toLowerCase();
    return surname !== undefined && surname !== "" && lower.includes(surname);
  });
  return byAuthor.length === 1 ? byAuthor[0]!.tsn : null;
}

export async function decisionsFromTabs(tabs: readonly SheetTab[], ctx: DecisionContext): Promise<DecisionsResult> {
  const out: DecisionsResult = { rows: [], held: [], followed: 0, aliasCandidates: [], notes: [] };
  const base = (rank: string, name: string, kind: TaxonCurationRow["kind"], decidedBy: string, reference: string, reason: string): TaxonCurationRow => ({
    kind, rank, name, parent_rank: "", parent_name: "", itis_tsn: "", itis_current_name: "",
    itis_release: ctx.itisRelease, taxonomist: decidedBy, decided_on: ctx.decidedOn, reference, reason,
  });
  const emit = (tab: SheetTab, row: TaxonCurationRow) => {
    const bad = rowProblem(row);
    if (bad === null) out.rows.push(row);
    else out.held.push({ tab: tab.title, rank: row.rank, name: row.name, problem: bad });
  };
  const hold = (tab: SheetTab, rank: string, name: string, problem: string) => out.held.push({ tab: tab.title, rank, name, problem });

  for (const tab of tabs) {
    const kind = tabKind(tab.title);
    if (kind === null || tab.rows.length < 2) continue;
    const rank = col(tab, "Rank");
    const name = col(tab, kind === "rename" ? "Program's name" : "Name");
    const decidedBy = col(tab, "Decided by");
    const notes = col(tab, "Notes");
    const reference = kind === "checklist" || kind === "spelling" ? -1 : col(tab, "Reference (DOI or link)");
    const decision =
      kind === "homonym" ? col(tab, "Which one does the program mean?")
      : kind === "checklist" ? col(tab, "Add to the checklist?")
      : kind === "spelling" ? col(tab, "Spelled right?")
      : col(tab, "Your decision");
    const itisSaid = kind === "wasps" ? col(tab, "ITIS") : -1;

    for (const r of tab.rows.slice(1)) {
      const rk = cell(r, rank), nm = cell(r, name), said = cell(r, decision), who = cell(r, decidedBy), note = cell(r, notes);
      const ref = reference < 0 ? "" : cell(r, reference);
      if (rk === "" || nm === "" || said === "") continue;
      const reason = note !== "" ? note : said;
      const lower = said.toLowerCase();

      // The question each tab asked, with the wasps tab asking all three by
      // what its ITIS column says.
      const question: "absent" | "rename" | "homonym" | "checklist" | "spelling" =
        kind !== "wasps" ? kind
        : cell(r, itisSaid).startsWith("Calls it") ? "rename"
        : cell(r, itisSaid).startsWith("Two authors") ? "homonym"
        : "absent";

      if (question === "checklist") {
        out.notes.push(`checklist: ${nm} (${rk}) — ${said}${note !== "" ? `: ${note}` : ""}`);
        continue;
      }
      if (question === "spelling") {
        if (lower.startsWith("no")) {
          if (note === "") hold(tab, rk, nm, "says the spelling is wrong but Notes does not give the right one");
          else out.aliasCandidates.push(`${rk},${nm},${note},spelling`);
        } else if (lower.startsWith("remove")) out.notes.push(`remove from the checklist: ${nm} (${rk})${note !== "" ? ` — ${note}` : ""}`);
        continue;
      }
      if (who === "") {
        hold(tab, rk, nm, "no name in Decided by: every row credits a taxonomist");
        continue;
      }
      const itis = await ctx.itis(rk, nm);

      if (question === "absent") {
        if (lower.startsWith("keep")) {
          if (itis.standing !== "absent") {
            hold(tab, rk, nm, `ITIS now has this name (${itis.standing}); nothing to add`);
            continue;
          }
          emit(tab, base(rk, nm, "addition", who, ref, reason));
        } else if (lower.startsWith("misspelling")) {
          if (note === "") hold(tab, rk, nm, "a misspelling, but Notes does not say of what");
          else out.aliasCandidates.push(`${rk},${nm},${note},spelling`);
        } else if (lower.startsWith("use itis")) {
          hold(tab, rk, nm, `use ITIS's name instead — by hand, as an alias or a rename: ${note !== "" ? note : "Notes does not say which"}`);
        } else if (lower.startsWith("not a taxon")) {
          out.notes.push(`not a taxon (beeline-8g7): ${nm} (${rk})${note !== "" ? ` — ${note}` : ""}`);
        } else if (lower.startsWith("remove")) {
          out.notes.push(`remove: ${nm} (${rk})${note !== "" ? ` — ${note}` : ""}`);
        } else hold(tab, rk, nm, `decision '${said}' is not one this reader knows`);
      } else if (question === "rename") {
        if (lower.startsWith("follow")) {
          out.followed += 1;
        } else if (lower.startsWith("keep")) {
          if (itis.standing !== "synonym" || itis.tsn === null) {
            hold(tab, rk, nm, `ITIS no longer calls this outdated (${itis.standing}); there is nothing to depart from`);
            continue;
          }
          const row = base(rk, nm, "departure", who, ref, reason);
          row.itis_tsn = itis.tsn;
          row.itis_current_name = itis.currentName ?? "";
          emit(tab, row);
        } else hold(tab, rk, nm, `decision '${said}' is not one this reader knows`);
      } else {
        if (itis.candidates.filter((c) => c.usage === "valid").length < 2) {
          hold(tab, rk, nm, `ITIS now has ${itis.candidates.length} name(s) at this spelling; no longer a choice`);
          continue;
        }
        const chosen = chooseCandidate(said, itis.candidates);
        if (chosen === null) {
          hold(tab, rk, nm, `'${said}' does not name exactly one of ITIS's: ${itis.candidates.map((c) => `${c.author ?? "?"} [TSN ${c.tsn}]`).join(" | ")}`);
          continue;
        }
        const row = base(rk, nm, "homonym", who, ref, reason);
        row.itis_tsn = chosen;
        emit(tab, row);
      }
    }
  }
  return out;
}

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** ITIS as the store holds it, asked by rank and spelling. */
export function itisFromStore(conn: DuckDBConnection): DecisionContext["itis"] {
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

/** The file with these decisions in it: a row for a name already decided is superseded, the rest kept. */
export function mergeDecisions(existing: readonly TaxonCurationRow[], incoming: readonly TaxonCurationRow[]): TaxonCurationRow[] {
  const byKey = new Map(existing.map((r) => [curationKey(r), r]));
  for (const r of incoming) byKey.set(curationKey(r), r);
  return [...byKey.values()];
}

// CLI: pnpm taxon:decisions <sheet-id> [db]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [sheetId, dbArg] = process.argv.slice(2);
  if (sheetId === undefined) {
    console.error("usage: pnpm taxon:decisions <sheet-id> [db]");
    process.exit(2);
  }
  const token = accessToken();
  const meta = await fileMeta(token, sheetId);
  const tabs = await sheetTabs(token, sheetId);
  const instance = await openDuckDb(dbArg ?? DEFAULT_DB);
  const conn = await instance.connect();
  let result: DecisionsResult;
  try {
    result = await decisionsFromTabs(tabs, {
      itisRelease: await itisRelease(conn),
      decidedOn: meta.modifiedTime.slice(0, 10),
      itis: itisFromStore(conn),
    });
  } finally {
    conn.closeSync();
  }
  const before = await readTaxonCuration(CURATED_TAXON_CURATION);
  const merged = mergeDecisions(before, result.rows);
  await writeTaxonCuration(CURATED_TAXON_CURATION, merged);
  console.log(
    JSON.stringify(
      {
        sheet: meta.name,
        modified: meta.modifiedTime,
        decisions: result.rows.length,
        superseded: before.length + result.rows.length - merged.length,
        file: merged.length,
        followedItis: result.followed,
        held: result.held,
        aliasCandidates: result.aliasCandidates,
        notes: result.notes,
        next: `review the diff, then pnpm taxon:apply [db] — nothing was applied to the store`,
      },
      null,
      2,
    ),
  );
}
