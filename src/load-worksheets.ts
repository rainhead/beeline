import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolver } from "./apply-person-overlay.js";
import { csvCell } from "./app/listings.js";
import { parseCsv } from "./corrections.js";
import { DEFAULT_DB } from "./person-change.js";

/**
 * Volunteer determinations from worksheets (beeline-pbk): the `worksheet_import`
 * channel.
 *
 * Before Beeline, a volunteer determined their specimens in a copy of a Google
 * Sheet — OBA Number, Sex/Caste, Family, Genus, Species, the last four from
 * dropdowns — kept in a shared Drive folder, and staff were to transcribe the
 * sheets into the old database. Mostly that never happened: on the
 * 2026-10-01 export, 18,704 determined rows from settled seasons fall on
 * specimens with no determination of any kind (docs/research/volunteer-worksheets.md).
 * `pnpm worksheets:fetch` exports the folder; this reads the export.
 *
 * Three things a sheet does not say, and how each is answered:
 *
 * WHO. A sheet records no determiner. Its title usually names a person and
 * its numbers usually belong to one collector, but households, helpers and
 * the "Vol Set N" copies break both, and Drive's last editor is mostly the
 * staff member who made the copy. So the determiner is decided per file, by a
 * person, in a manifest (data/worksheet-files.csv — gitignored, since it is a
 * list of names). Each load refreshes it: a new file arrives with the
 * collector of most of its specimens proposed, and nothing loads from a file
 * until somebody writes a person reference (the overlay's `name:`/`inat:`)
 * or `skip` beside it.
 *
 * WHICH VERSION. A sheet is a working document, and volunteers copy one
 * under a new name and keep going, so a specimen can stand in three files
 * with three answers. Copies that agree are one entry. Copies that disagree
 * are held, naming each other, because no clock says which is the later
 * thinking: the first version took the most recently modified file, and on
 * the 2026-10-01 export that was an old copy someone had touched in January,
 * whose Lasioglossum stood against the revised copy's Halictus confusus;
 * creation time gets that pair right and three others wrong. A person
 * settles it by marking the stale copy `skip`, and the entry loads on the
 * next run. Rows in one file which disagree about a specimen are held too.
 * So is a row that disagrees with the determiner's own identification in
 * the old system, which had a Determinations page of its own and kept no
 * date either: one that would contradict it, say less than it, or change
 * its sex is held; one that refines it loads (beeline-wuwm).
 *
 * WHETHER THE NUMBER IS RIGHT. Numbers were typed by hand with no validation,
 * and a slip lands the name on someone else's bee — where, with nothing else
 * recorded, it would become the determination of record. A row whose
 * specimen the determiner did not collect is held, unless the manifest says
 * the file is somebody determining for others. Held rows are written to
 * held.csv in the export, with the numbers either side of them in the sheet,
 * which is usually enough to see the typo.
 *
 * Names resolve against the curated tree by rank and spelling, through the
 * taxon alias file for genus misspellings; one that does not resolve is a
 * curation task and is reported, never minted. Sex/Caste maps onto the
 * vocabulary in-app entry writes (schema/045): queen is a female gyne, a
 * drone a male, and a caste on a taxon without castes is dropped and kept in
 * the notes. The sheets say nothing about when a row was entered, so
 * determined_on is left empty; the file's modification time is kept as
 * provenance (worksheet_determination), an upper bound on when it was.
 *
 * Loading again records nothing new: an entry is skipped when the
 * determiner's newest volunteer determination of the specimen already says
 * it — which also covers the ones staff did transcribe into the old database —
 * or was entered in Beeline after the sheet was last changed, or when a file
 * at least as new has already been loaded for them.
 */

export const DEFAULT_DIR = "data/worksheets";
export const DEFAULT_MANIFEST = "data/worksheet-files.csv";
/** The tab the template tells volunteers to fill in. */
export const DEFAULT_SHEET = "USE THIS SHEET";
export const DEFAULT_TAXON_ALIASES = new URL("../ingest/taxon-aliases.csv", import.meta.url).pathname;

/** One entry of the export's files.json (src/fetch-worksheets.ts). */
export interface WorksheetFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  /** The exported .xlsx, relative to the export directory; null when the file is not a spreadsheet the loader can read. */
  file: string | null;
}

export const MANIFEST_COLUMNS = [
  "file_id",
  "file_name",
  "modified_at",
  "determined_rows",
  "proposed",
  "proposed_covers",
  "determiner",
  "for_others",
  "sheet",
  "note",
] as const;
export type ManifestRow = Record<(typeof MANIFEST_COLUMNS)[number], string>;

export type WorksheetStatus =
  /** Recorded as a new determination. */
  | "recorded"
  /** The determiner's newest volunteer determination already says this. */
  | "already_recorded"
  /** The determiner changed it in Beeline after the sheet was last edited. */
  | "newer_in_beeline"
  /** A file at least as new has already been loaded for this determiner and specimen. */
  | "already_loaded"
  /** Two of the determiner's files say different things about the specimen. */
  | "versions_disagree"
  /**
   * The determiner's identification in the old system says something the row
   * would contradict, leave out, or change the sex of. Refining it loads.
   */
  | "old_system_disagrees"
  /** The row names a taxon but its number cell is empty or not a label number. */
  | "no_number"
  | "no_specimen"
  | "several_specimens"
  | "not_theirs"
  | "conflicting_rows"
  | "unresolved_name"
  /** The file has no determiner in the manifest yet, or one that names nobody. */
  | "undecided";

const HELD: readonly WorksheetStatus[] = [
  "no_number",
  "no_specimen",
  "several_specimens",
  "not_theirs",
  "conflicting_rows",
  "versions_disagree",
  "old_system_disagrees",
  "unresolved_name",
  "undecided",
];

export interface LoadWorksheetsOptions {
  /** The export directory: files.json and the .xlsx files it names. */
  dir: string;
  manifestPath?: string;
  taxonAliases?: string;
  /** Count and report, write the manifest and held.csv, record nothing. */
  dryRun?: boolean;
  /** For tests: the moment the load is recorded as. */
  now?: Date;
}

export interface LoadWorksheetsResult {
  files: number;
  /** Files holding determinations with no decision in the manifest yet; nothing loads from them. */
  undecided: number;
  skipped: number;
  /** Files that could not be read, and why. */
  unreadable: Array<{ file: string; problem: string }>;
  /** Manifest references that name nobody, or two people. */
  unresolvedDeterminers: Array<{ file: string; determiner: string; problem: string }>;
  /** Rows with a name, from the files that load. */
  rows: number;
  /** Rows with a number and nothing else: numbers filled in ahead and never determined. */
  undetermined: number;
  /** Each status, split by the season the specimen's sample belongs to. */
  statuses: Array<{ status: WorksheetStatus; season: "open" | "settled" | "none"; rows: number }>;
  unresolvedNames: Array<{ name: string; rows: number }>;
  recorded: number;
  held: number;
}

const rows = async (conn: DuckDBConnection, sql: string, params: unknown[] = []) =>
  (await (await conn.run(sql, params as never)).getRows()) as unknown[][];
const scalar = async (conn: DuckDBConnection, sql: string, params: unknown[] = []) =>
  Number((await rows(conn, sql, params))[0]?.[0] ?? 0);
const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;
const sqlValue = (v: string | number | null) => (v === null ? "NULL" : typeof v === "number" ? String(v) : sqlString(v));

// ── The manifest ────────────────────────────────────────────────────────

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

export function formatManifest(manifest: readonly ManifestRow[]): string {
  const body = manifest.map((r) => MANIFEST_COLUMNS.map((c) => cell(r[c])).join(","));
  return `${[MANIFEST_COLUMNS.join(","), ...body].join("\n")}\n`;
}

/** Refuse, don't repair: the loader rewrites the file, and a row dropped for being malformed would take its decision with it. */
export function parseManifest(text: string, where: string): ManifestRow[] {
  const records = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (records.length === 0) return [];
  const header = records[0]!.join(",");
  if (header !== MANIFEST_COLUMNS.join(",")) throw new Error(`${where}: header is '${header}', expected '${MANIFEST_COLUMNS.join(",")}'`);
  return records.slice(1).map((r, i) => {
    if (r.length !== MANIFEST_COLUMNS.length) throw new Error(`${where} line ${i + 2}: ${r.length} fields, expected ${MANIFEST_COLUMNS.length}`);
    const row = Object.fromEntries(MANIFEST_COLUMNS.map((c, j) => [c, r[j]!])) as ManifestRow;
    if (!["", "yes"].includes(row.for_others)) throw new Error(`${where} line ${i + 2}: for_others is '${row.for_others}', expected 'yes' or nothing`);
    return row;
  });
}

async function readManifest(path: string): Promise<ManifestRow[]> {
  try {
    return parseManifest(await readFile(path, "utf8"), path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

// ── Reading a sheet ─────────────────────────────────────────────────────

export interface SheetRow {
  rowNumber: number;
  number: string | null;
  /** What the number cell held, when it held something that is not a label number. */
  numberText: string | null;
  sex: string | null;
  family: string | null;
  genus: string | null;
  species: string | null;
}

/**
 * A label number as the sheet holds it. Google's export writes a number cell
 * as a double, which read as text is `2.5000001E7`; a cell somebody typed as
 * text is `25000001`. Anything else — a date that strayed into the column, a
 * note — is not a number.
 */
export function labelNumber(raw: string | null): string | null {
  const s = (raw ?? "").trim();
  if (/^\d+$/.test(s)) return s;
  if (/^\d+\.0+$/.test(s)) return s.replace(/\.0+$/, "");
  if (/^\d(\.\d+)?E\d+$/i.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return String(n);
  }
  return null;
}

const blank = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s === "" ? null : s;
};

/**
 * The rows of one tab. The header is found by its Genus or Species heading in
 * the first five rows, since some sheets lost it to a blank row or a title;
 * columns are found by heading, and a sheet with none is read as the
 * template's order. The number is the first column whatever it is called —
 * "OBA Number", "OBA ID", "WBA Number", or a collector's name.
 */
export function readSheetRows(grid: readonly (readonly unknown[])[], rowNumbers?: readonly number[]): SheetRow[] {
  let headerAt = -1;
  for (let i = 0; i < Math.min(5, grid.length); i++) {
    const cells = (grid[i] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
    if (cells.includes("genus") || cells.includes("species")) {
      headerAt = i;
      break;
    }
  }
  const heads = headerAt < 0 ? [] : (grid[headerAt] ?? []).map((c) => String(c ?? "").trim().toLowerCase());
  // Found by heading; failing that, the template's position — unless
  // another heading stands there. One export has '250' typed over its
  // Genus heading, and its genera are still in column D.
  const HEADINGS = { sex: ["sex/caste", "sex", "sex and caste", "caste"], family: ["family"], genus: ["genus"], species: ["species"] };
  const known = new Set(Object.values(HEADINGS).flat());
  const col = (names: string[], fallback: number) => {
    if (headerAt < 0) return fallback;
    const at = heads.findIndex((h) => names.includes(h));
    return at >= 0 ? at : known.has(heads[fallback] ?? "") ? -1 : fallback;
  };
  const sexAt = col(HEADINGS.sex, 1);
  const familyAt = col(HEADINGS.family, 2);
  const genusAt = col(HEADINGS.genus, 3);
  const speciesAt = col(HEADINGS.species, 4);
  const out: SheetRow[] = [];
  for (let i = headerAt + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    out.push({
      rowNumber: rowNumbers?.[i] ?? i + 1,
      number: labelNumber(blank(r[0])),
      numberText: labelNumber(blank(r[0])) === null ? blank(r[0]) : null,
      sex: (sexAt < 0 ? null : blank(r[sexAt]))?.toLowerCase() ?? null,
      family: familyAt < 0 ? null : blank(r[familyAt]),
      genus: genusAt < 0 ? null : blank(r[genusAt]),
      species: speciesAt < 0 ? null : blank(r[speciesAt]),
    });
  }
  return out;
}

// ── The load ────────────────────────────────────────────────────────────

/** The tabs to read: the manifest's, semicolon-separated, or the template's. */
const sheetsOf = (row: ManifestRow | undefined): string[] => {
  const named = (row?.sheet ?? "").split(";").map((s) => s.trim()).filter((s) => s !== "");
  return named.length > 0 ? named : [DEFAULT_SHEET];
};

/**
 * A deployed store keeps the channel CHECK it was built with (ADR 0006), and
 * one built before this channel existed refuses every row the load would
 * write. Asked first, so the answer is a sentence rather than a failed INSERT.
 */
async function assertChannelAdmitted(conn: DuckDBConnection): Promise<void> {
  const checks = await rows(
    conn,
    `SELECT expression FROM duckdb_constraints()
     WHERE table_name = 'determination' AND constraint_type = 'CHECK' AND expression LIKE '%ecdysis_import%'`,
  );
  if (checks.length > 0 && !checks.some(([e]) => String(e).includes("worksheet_import"))) {
    throw new Error(
      "this store's determination.channel CHECK predates 'worksheet_import' and DuckDB cannot change it; reseed the store (ADR 0006) before loading worksheets",
    );
  }
}

export async function loadWorksheets(conn: DuckDBConnection, opts: LoadWorksheetsOptions): Promise<LoadWorksheetsResult> {
  const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST;
  const aliases = opts.taxonAliases ?? DEFAULT_TAXON_ALIASES;
  const now = opts.now ?? new Date();
  await assertChannelAdmitted(conn);
  // read_xlsx autoloads, but say so: a store opened offline without the
  // extension should fail here, before any file is read.
  await conn.run("INSTALL excel; LOAD excel");

  const files = JSON.parse(await readFile(join(opts.dir, "files.json"), "utf8")) as WorksheetFile[];
  const decisions = new Map((await readManifest(manifestPath)).map((r) => [r.file_id, r]));

  // Every file is read, decided or not: the proposal for an undecided one
  // comes from its numbers.
  const unreadable: LoadWorksheetsResult["unreadable"] = [];
  const parsed: Array<{ file: WorksheetFile; sheet: string; rows: SheetRow[] }> = [];
  for (const file of files) {
    if (file.file === null) {
      unreadable.push({ file: file.name, problem: `not a spreadsheet the loader reads (${file.mimeType})` });
      continue;
    }
    // The manifest can name the tab, or several separated by semicolons:
    // a few volunteers renamed the template's or kept going on a second one.
    const sheets = sheetsOf(decisions.get(file.id));
    for (const sheet of sheets) {
      try {
        // An explicit range, because without one read_xlsx stops at the
        // first empty row and starts at the first column with a value in
        // row 1: on the export it read one row of a 92-row sheet whose A1 is
        // blank, and 232 of a 576-row one with a gap in it. Empty rows are
        // dropped here, numbered first so a held row can be found again.
        const numbered = await rows(
          conn,
          `SELECT ordinality, * EXCLUDE (ordinality)
           FROM read_xlsx(${sqlString(join(opts.dir, file.file))}, sheet = ${sqlString(sheet)}, header = false,
                          all_varchar = true, stop_at_empty = false, range = 'A1:Z100000') WITH ORDINALITY
           WHERE coalesce(A, B, C, D, E) IS NOT NULL
           ORDER BY ordinality`,
        );
        parsed.push({ file, sheet, rows: readSheetRows(numbered.map((r) => r.slice(1)), numbered.map((r) => Number(r[0]))) });
      } catch (err) {
        const problem = (err as Error).message.split("\n")[0]!;
        unreadable.push({
          file: file.name,
          problem: /not found in xlsx/.test(problem) ? `no tab named '${sheet}': name the tab in the manifest's sheet column` : problem,
        });
      }
    }
  }

  await conn.run("BEGIN TRANSACTION");
  try {
    await conn.run(`CREATE OR REPLACE TEMP TABLE ws_file (
      file_id TEXT, file_name TEXT, modified_at TIMESTAMPTZ, decision TEXT, determiner_id INTEGER, for_others BOOLEAN)`);
    await conn.run(`CREATE OR REPLACE TEMP TABLE ws_row (
      file_id TEXT, sheet TEXT, row_number INTEGER, number TEXT, number_text TEXT, sex_text TEXT, family TEXT, genus TEXT, species TEXT)`);

    const { resolve } = await resolver(conn);
    const unresolvedDeterminers: LoadWorksheetsResult["unresolvedDeterminers"] = [];
    for (const file of new Map(parsed.map((p) => [p.file.id, p.file])).values()) {
      const decision = (decisions.get(file.id)?.determiner ?? "").trim();
      let determinerId: number | null = null;
      if (decision !== "" && decision !== "skip") {
        const found = resolve(decision);
        if ("id" in found) determinerId = found.id;
        else unresolvedDeterminers.push({ file: file.name, determiner: decision, problem: found.problem });
      }
      await conn.run(
        `INSERT INTO ws_file VALUES (${sqlValue(file.id)}, ${sqlValue(file.name)}, ${sqlValue(file.modifiedTime)}::TIMESTAMPTZ,
          ${sqlValue(decision)}, ${sqlValue(determinerId)}, ${decisions.get(file.id)?.for_others === "yes"})`,
      );
    }
    const values = parsed.flatMap(({ file, sheet, rows: rs }) =>
      rs
        // A row with a name and no usable number is kept, to be held: it is
        // a determination that cannot be placed, and dropping it would be silent.
        .filter((r) => r.number !== null || r.family !== null || r.genus !== null || r.species !== null)
        .map((r) => `(${[file.id, sheet, r.rowNumber, r.number, r.numberText, r.sex, r.family, r.genus, r.species].map(sqlValue).join(", ")})`),
    );
    for (let i = 0; i < values.length; i += 1000) {
      await conn.run(`INSERT INTO ws_row VALUES ${values.slice(i, i + 1000).join(", ")}`);
    }
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ws_alias AS
       SELECT trim(alias) AS alias, trim(name) AS name FROM read_csv(${sqlString(aliases)}, header = true, all_varchar = true)
       WHERE trim(rank) = 'genus'`,
    );

    // Each row with a name, matched to its specimen and its node. A genus
    // cell can carry a subgenus, as the template's 'Epimelissodes (Svastra)'
    // does: alone it is that subgenus node, under an epithet it is spelled
    // without it, the way the tree spells species.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ws_named AS
      WITH r AS (
        SELECT r.*, f.file_name, f.modified_at, f.decision, f.determiner_id, f.for_others,
               trim(regexp_replace(r.genus, '\\s*\\(.*$', '')) AS genus_base,
               nullif(trim(regexp_extract(r.genus, '\\(([^)]*)\\)', 1)), '') AS subgenus
        FROM ws_row r JOIN ws_file f USING (file_id)
        WHERE r.family IS NOT NULL OR r.genus IS NOT NULL OR r.species IS NOT NULL
      ), g AS (
        SELECT r.*, coalesce((SELECT a.name FROM ws_alias a WHERE a.alias = r.genus_base), r.genus_base) AS genus_name
        FROM r
      )
      SELECT g.*,
             CASE WHEN species IS NOT NULL THEN 'species' WHEN genus IS NOT NULL AND subgenus IS NOT NULL THEN 'subgenus'
                  WHEN genus IS NOT NULL THEN 'genus' ELSE 'family' END AS target_rank,
             CASE WHEN species IS NOT NULL THEN
                    CASE WHEN genus_name IS NOT NULL AND regexp_full_match(species, '[a-z][a-z-]*') THEN concat(genus_name, ' ', species) END
                  WHEN genus IS NOT NULL AND subgenus IS NOT NULL THEN concat(genus_name, ' (', subgenus, ')')
                  WHEN genus IS NOT NULL THEN genus_name
                  ELSE family END AS target_name,
             concat_ws(' ', genus, species) AS written,
             coalesce(nullif(concat_ws(' ', genus, species), ''), family) AS verbatim
      FROM g`);

    // Proposals: the collector of most of a file's specimens, referred to
    // the way the overlay refers to people.
    const proposals = new Map(
      (
        await rows(
          conn,
          `WITH m AS (
             SELECT n.file_id, sc.person_id, count(*) AS n, sum(count(*)) OVER (PARTITION BY n.file_id) AS total
             FROM ws_named n
             JOIN specimen sp ON sp.field_number = n.number
             JOIN sample_collector sc ON sc.sample_id = sp.sample_id AND sc.position = 1
             GROUP BY n.file_id, sc.person_id
             QUALIFY row_number() OVER (PARTITION BY n.file_id ORDER BY count(*) DESC, sc.person_id) = 1
           )
           SELECT m.file_id,
                  CASE WHEN (SELECT count(*) FROM person q WHERE q.display_name = p.display_name) = 1 THEN concat('name:', p.display_name)
                       ELSE (SELECT concat('inat:', min(a.inat_user_id)) FROM inat_account a WHERE a.person_id = p.entity_id) END,
                  concat(CAST(round(100.0 * m.n / m.total) AS INTEGER), '%')
           FROM m JOIN person p ON p.entity_id = m.person_id`,
        )
      ).map(([id, ref, covers]) => [String(id), { ref: ref === null ? "" : String(ref), covers: String(covers) }]),
    );
    const determinedRows = new Map(
      (await rows(conn, `SELECT file_id, count(*) FROM ws_named GROUP BY 1`)).map(([id, n]) => [String(id), String(n)]),
    );

    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ws_candidate AS
      WITH m AS (
        SELECT n.*,
               (SELECT count(*) FROM specimen sp WHERE sp.field_number = n.number) AS specimens,
               (SELECT min(sp.entity_id) FROM specimen sp WHERE sp.field_number = n.number) AS specimen_id,
               (SELECT min(a.entity_id) FROM animal a WHERE a.rank = n.target_rank AND a.scientific_name = n.target_name) AS animal_id
        FROM ws_named n
        WHERE n.determiner_id IS NOT NULL
      ), c AS (
        SELECT m.*, sp.sample_id,
               EXISTS (SELECT 1 FROM sample_collector sc WHERE sc.sample_id = sp.sample_id AND sc.person_id = m.determiner_id) AS theirs
        FROM m LEFT JOIN specimen sp ON sp.entity_id = m.specimen_id AND m.specimens = 1
      ), placed AS (
        -- Where the row lands, before anything about its content: a row that
        -- reaches no specimen, or someone else's, says nothing about this
        -- determiner's view of any specimen of theirs.
        SELECT c.*, CASE WHEN number IS NULL THEN 'no_number' WHEN specimens = 0 THEN 'no_specimen' WHEN specimens > 1 THEN 'several_specimens'
                         WHEN NOT theirs AND NOT for_others THEN 'not_theirs' END AS placement
        FROM c
      ), read AS (
        SELECT p.*, concat_ws('|', target_rank, target_name, written, sex_text) AS reading
        FROM placed p WHERE placement IS NULL
      ), versions AS (
        SELECT r.*,
               count(DISTINCT reading) OVER (PARTITION BY determiner_id, specimen_id, file_id) AS in_file,
               count(DISTINCT reading) OVER (PARTITION BY determiner_id, specimen_id) AS in_files,
               -- Copies that agree are one entry, carried by the most recently
               -- changed of them, so a later load compares against that file.
               row_number() OVER (PARTITION BY determiner_id, specimen_id ORDER BY modified_at DESC, file_id, sheet, row_number) AS nth
        FROM read r
      )
      SELECT n.*, an.has_castes,
             CASE n.sex_text WHEN 'female' THEN 'female' WHEN 'queen' THEN 'female' WHEN 'worker' THEN 'female'
                             WHEN 'male' THEN 'male' WHEN 'drone' THEN 'male' END AS sex,
             CASE WHEN an.has_castes THEN CASE n.sex_text WHEN 'queen' THEN 'gyne' WHEN 'worker' THEN 'worker' WHEN 'drone' THEN 'drone' END END AS caste,
             CASE WHEN NOT coalesce(an.has_castes, false) AND n.sex_text IN ('queen', 'worker', 'drone')
                  THEN concat('the worksheet says ', n.sex_text) END AS notes,
             CASE WHEN n.in_file > 1 THEN 'conflicting_rows'
                  WHEN n.in_files > 1 THEN 'versions_disagree'
                  WHEN n.nth > 1 THEN 'duplicate'
                  WHEN n.animal_id IS NULL THEN 'unresolved_name' END AS status
      FROM versions n LEFT JOIN animal_castes an ON an.animal_id = n.animal_id
      UNION ALL BY NAME
      SELECT p.*, p.placement AS status FROM placed p WHERE placement IS NOT NULL
      -- A file nobody has decided about is held whole, so a list of what did
      -- not load is a list of everything that did not (Peter, 2026-10-01).
      UNION ALL BY NAME
      SELECT n.*, 'undecided' AS status,
             (SELECT CASE WHEN count(*) = 1 THEN min(sp.sample_id) END FROM specimen sp WHERE sp.field_number = n.number) AS sample_id
      FROM ws_named n WHERE n.determiner_id IS NULL AND n.decision IS DISTINCT FROM 'skip'`);

    // What the store already holds for this determiner and specimen. The old
    // system had its own Determinations page, saved with no date, so a
    // volunteer could identify a specimen there and on a sheet; neither says
    // which came later (beeline-wuwm, sandbox 2026-10-04: none of the old
    // values appears in any of 34 Drive revisions of the sheets that disagree
    // with them). A row that would contradict the determiner's old-system
    // identification, say less than it, or change its sex is held (Peter,
    // 2026-10-04); a row that refines it is new information and loads.
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ws_ancestry AS
      WITH RECURSIVE up(node_id, anc_id) AS (
        SELECT entity_id, entity_id FROM animal
        UNION ALL
        SELECT up.node_id, a.parent_id FROM up JOIN animal a ON a.entity_id = up.anc_id WHERE a.parent_id IS NOT NULL
      ) SELECT * FROM up`);
    await conn.run(`
      CREATE OR REPLACE TEMP TABLE ws_old_system AS
      SELECT d.specimen_id, d.determiner_id, d.animal_id, d.sex, d.caste
      FROM determination d
      WHERE d.channel = 'legacy_import' AND NOT d.is_expert
      QUALIFY row_number() OVER (PARTITION BY d.specimen_id, d.determiner_id ORDER BY d.recorded_at DESC, d.entity_id DESC) = 1`);
    await conn.run(`
      UPDATE ws_candidate c SET status = CASE
        WHEN EXISTS (
          SELECT 1 FROM worksheet_determination w JOIN determination d ON d.entity_id = w.determination_id
          WHERE d.specimen_id = c.specimen_id AND d.determiner_id = c.determiner_id AND w.file_modified_at >= c.modified_at) THEN 'already_loaded'
        WHEN EXISTS (
          SELECT 1 FROM determination d
          WHERE d.specimen_id = c.specimen_id AND d.determiner_id = c.determiner_id AND d.channel = 'in_app' AND d.recorded_at > c.modified_at) THEN 'newer_in_beeline'
        WHEN (SELECT d.animal_id = c.animal_id AND d.sex IS NOT DISTINCT FROM c.sex AND d.caste IS NOT DISTINCT FROM c.caste
              FROM determination d
              WHERE d.specimen_id = c.specimen_id AND d.determiner_id = c.determiner_id AND NOT d.is_expert
              ORDER BY d.recorded_at DESC, d.entity_id DESC LIMIT 1) THEN 'already_recorded'
        WHEN EXISTS (
          SELECT 1 FROM ws_old_system o
          WHERE o.specimen_id = c.specimen_id AND o.determiner_id = c.determiner_id
            AND NOT (EXISTS (SELECT 1 FROM ws_ancestry x WHERE x.node_id = c.animal_id AND x.anc_id = o.animal_id)
                     AND (o.sex IS NULL OR o.sex IS NOT DISTINCT FROM c.sex)
                     AND (o.caste IS NULL OR o.caste IS NOT DISTINCT FROM c.caste))) THEN 'old_system_disagrees'
        ELSE 'recorded' END
      WHERE c.status IS NULL`);

    const statuses = (
      await rows(
        conn,
        `SELECT c.status, CASE WHEN c.sample_id IS NULL THEN 'none' WHEN st.sample_id IS NULL THEN 'open' ELSE 'settled' END, count(*)
         FROM ws_candidate c LEFT JOIN settled_sample st ON st.sample_id = c.sample_id
         WHERE c.status <> 'duplicate' GROUP BY ALL ORDER BY 1, 2`,
      )
    ).map(([status, season, n]) => ({ status: status as WorksheetStatus, season: season as "open" | "settled" | "none", rows: Number(n) }));
    const unresolvedNames = (
      await rows(
        conn,
        `SELECT verbatim, count(*) FROM ws_candidate WHERE status = 'unresolved_name' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 40`,
      )
    ).map(([name, n]) => ({ name: String(name), rows: Number(n) }));

    // Held rows, for whoever is checking them: where they are, what they
    // say, and the numbers either side, which is usually enough to see the slip.
    const held = await rows(
      conn,
      `SELECT c.file_name, c.sheet, c.row_number, coalesce(c.number, c.number_text), c.status, c.verbatim, c.sex_text,
              (SELECT string_agg(o.number, ' ' ORDER BY o.row_number) FROM ws_row o
               WHERE o.file_id = c.file_id AND o.sheet = c.sheet AND o.row_number BETWEEN c.row_number - 2 AND c.row_number + 2 AND o.row_number <> c.row_number) AS neighbours,
              coalesce(
                (SELECT string_agg(DISTINCT concat_ws(' ', concat(o.file_name, ':'), o.verbatim, o.sex_text), '; ') FROM ws_candidate o
                 WHERE c.status = 'versions_disagree' AND o.determiner_id = c.determiner_id AND o.specimen_id = c.specimen_id
                   AND o.file_id <> c.file_id AND o.reading <> c.reading),
                (SELECT concat_ws(' ', 'old system:', a.scientific_name, o.sex, o.caste) FROM ws_old_system o JOIN animal a ON a.entity_id = o.animal_id
                 WHERE c.status = 'old_system_disagrees' AND o.specimen_id = c.specimen_id AND o.determiner_id = c.determiner_id)) AS other_copies
       FROM ws_candidate c WHERE c.status IN (${HELD.map(sqlString).join(", ")})
       ORDER BY c.file_name, c.sheet, c.row_number`,
    );
    await writeAtomically(
      join(opts.dir, "held.csv"),
      `${["file", "sheet", "row", "number", "reason", "name", "sex_caste", "neighbours", "other_copies"].join(",")}\n` +
        // Guarded against formulas, unlike the manifest: these are volunteers'
        // cells, written for a person to open in a spreadsheet, never read back.
        held.map((r) => r.map((v) => csvCell(v === null ? "" : String(v))).join(",")).join("\n") +
        (held.length > 0 ? "\n" : ""),
    );

    const recorded = await scalar(conn, `SELECT count(*) FROM ws_candidate WHERE status = 'recorded'`);
    const namedRows = await scalar(conn, `SELECT count(*) FROM ws_named WHERE determiner_id IS NOT NULL`);
    const undetermined = await scalar(
      conn,
      `SELECT count(*) FROM ws_row r JOIN ws_file f USING (file_id)
       WHERE f.determiner_id IS NOT NULL AND r.family IS NULL AND r.genus IS NULL AND r.species IS NULL`,
    );
    if (!opts.dryRun) {
      const before = await scalar(conn, `SELECT coalesce(max(entity_id), 0) FROM determination`);
      await conn.run(
        `CREATE OR REPLACE TEMP TABLE ws_insert AS
         SELECT c.*, $1::TIMESTAMPTZ + INTERVAL (row_number() OVER (ORDER BY c.specimen_id, c.determiner_id)) MICROSECOND AS recorded_at
         FROM ws_candidate c WHERE c.status = 'recorded'`,
        [now.toISOString()],
      );
      await conn.run(`
        INSERT INTO determination (specimen_id, animal_id, verbatim_identification, sex, caste,
                                   determiner_id, is_expert, channel, recorded_at, notes)
        SELECT specimen_id, animal_id, verbatim, sex, caste, determiner_id, false, 'worksheet_import', recorded_at, notes
        FROM ws_insert`);
      await conn.run(
        `INSERT INTO worksheet_determination (determination_id, file_id, file_name, file_modified_at, sheet, row_number, loaded_at)
         SELECT d.entity_id, i.file_id, i.file_name, i.modified_at, i.sheet, i.row_number, $1::TIMESTAMPTZ
         FROM ws_insert i
         JOIN determination d ON d.specimen_id = i.specimen_id AND d.recorded_at = i.recorded_at
                              AND d.channel = 'worksheet_import' AND d.entity_id > $2`,
        [now.toISOString(), before],
      );
    }
    await conn.run(opts.dryRun ? "ROLLBACK" : "COMMIT");

    // The manifest, refreshed: every file in the export, decisions kept,
    // what the loader knows about each brought up to date.
    const inExport = new Set(files.map((f) => f.id));
    const manifest: ManifestRow[] = [
      ...files.map((f): ManifestRow => {
        const kept = decisions.get(f.id);
        return {
          file_id: f.id,
          file_name: f.name,
          modified_at: f.modifiedTime,
          determined_rows: determinedRows.get(f.id) ?? "0",
          proposed: proposals.get(f.id)?.ref ?? "",
          proposed_covers: proposals.get(f.id)?.covers ?? "",
          determiner: kept?.determiner ?? "",
          for_others: kept?.for_others ?? "",
          sheet: kept?.sheet ?? "",
          note: kept?.note ?? "",
        };
      }),
      // A decision about a file no longer in the export is kept: it is still
      // a decision, and the file may come back.
      ...[...decisions.values()].filter((r) => !inExport.has(r.file_id)),
    ];
    await writeAtomically(manifestPath, formatManifest(manifest));

    const decided = new Set(parsed.map((p) => p.file.id).filter((id) => (decisions.get(id)?.determiner ?? "").trim() !== ""));
    const total = (s: WorksheetStatus) => statuses.filter((x) => x.status === s).reduce((a, x) => a + x.rows, 0);
    return {
      files: files.length,
      undecided: files.filter((f) => Number(determinedRows.get(f.id) ?? 0) > 0 && (decisions.get(f.id)?.determiner ?? "").trim() === "").length,
      skipped: [...decided].filter((id) => decisions.get(id)!.determiner.trim() === "skip").length,
      unreadable,
      unresolvedDeterminers,
      rows: namedRows,
      undetermined,
      statuses,
      unresolvedNames,
      recorded: opts.dryRun ? 0 : recorded,
      held: HELD.reduce((a, s) => a + total(s), 0),
    };
  } catch (err) {
    await conn.run("ROLLBACK").catch(() => {});
    throw err;
  }
}

// CLI: pnpm worksheets:load [export-dir] [db] [--manifest path] [--dry-run]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const manifestAt = args.indexOf("--manifest");
  const manifestPath = manifestAt >= 0 ? args[manifestAt + 1] : undefined;
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a, i) => a !== "--dry-run" && a !== "--manifest" && (manifestAt < 0 || i !== manifestAt + 1));
  const { openDuckDb } = await import("./db.js");
  const instance = await openDuckDb(positional[1] ?? process.env.BEELINE_DB ?? DEFAULT_DB);
  const conn = await instance.connect();
  const result = await loadWorksheets(conn, { dir: positional[0] ?? DEFAULT_DIR, manifestPath, dryRun });
  await conn.run("CHECKPOINT");
  conn.closeSync();
  console.log(JSON.stringify(result, null, 2));
}
