import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { monthsBefore, oregonToday } from "../oregon-today.js";
import type { Messages } from "./messages/en.js";
import { SPECIMENS_LAYOUT, SPECIMEN_CHOICES, columnRule } from "./upload-plan.js";
import type { ColumnChoices, ExtraSheet, XlsxWriterOptions } from "./xlsx.js";

/**
 * What the specimens Excel download offers a person typing in it, beyond the
 * rows (beeline-kgyd.2): warnings on the columns with a fixed vocabulary,
 * tabs to look names up in, a tab that says what the file is, and a shade on
 * the columns Beeline does not read. The file is for editing specimens
 * (`SPECIMENS_LAYOUT`, src/app/upload-plan.ts). Nothing in it is relied on: the upload checks every cell again. It is built
 * when the file is asked for and is not part of the CSV.
 */

/** Years back that an identifier counts as active. */
export const IDENTIFIER_YEARS = 5;

type Rows = Array<Array<string | null>>;

/**
 * Every name in Beeline's tree that a person may give a specimen: the names
 * the Identify specimens picker offers (`entryTaxa`, src/app/determine.ts),
 * which is every node except kingdom, phylum and class. Nothing in the tree is
 * retired or curated away (a curated synonym is kept in it on purpose), so
 * none is left out. The family is the nearest ancestor of that rank. Sorted by
 * name, then rank.
 */
export async function nameRows(db: Kysely<Database>): Promise<Rows> {
  const nodes = (
    await sql<{ id: number; parent_id: number | null; rank: string; name: string }>`
      SELECT entity_id AS id, parent_id, rank, scientific_name AS name FROM animal`.execute(db)
  ).rows;
  const byId = new Map(nodes.map((n) => [Number(n.id), n]));
  const familyOf = (start: number): string | null => {
    for (let n = byId.get(start); n !== undefined; n = n.parent_id === null ? undefined : byId.get(Number(n.parent_id))) {
      if (n.rank === "family") return n.name;
    }
    return null;
  };
  return nodes
    .filter((n) => !["kingdom", "phylum", "class"].includes(n.rank))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((n) => [n.name, n.rank, familyOf(Number(n.id))]);
}

/**
 * People who identified a specimen in the last five years, written as the
 * download's identifiedBy writes one: the person's display name, else the
 * name text the determination carries. A determination counts when its date
 * (`determined_on`) is in the window; or, where it has no date, when it was
 * recorded in the window by a channel whose recording day means something (not
 * the old system's import, which recorded every determination on the day it
 * was imported); or when its specimen was collected in the window.
 */
export async function identifierRows(db: Kysely<Database>, today: string): Promise<Rows> {
  const since = monthsBefore(today, IDENTIFIER_YEARS * 12);
  const result = await sql<{ name: string }>`
    SELECT DISTINCT coalesce(p.display_name, d.determiner_name) AS name
    FROM determination d
    LEFT JOIN person p ON p.entity_id = d.determiner_id
    WHERE coalesce(p.display_name, d.determiner_name) IS NOT NULL
      AND trim(coalesce(p.display_name, d.determiner_name)) <> ''
      AND (d.determined_on >= CAST(${since} AS DATE)
           OR (d.determined_on IS NULL AND d.channel <> 'legacy_import' AND CAST(d.recorded_at AS DATE) >= CAST(${since} AS DATE))
           OR d.specimen_id IN (SELECT sp.entity_id FROM specimen sp JOIN sample s ON s.entity_id = sp.sample_id
                                WHERE s.date_end >= CAST(${since} AS DATE)))
    ORDER BY name`.execute(db);
  return result.rows.map((r) => [r.name]);
}

/** The tabs' names. The headings of the lookup tabs are the main sheet's own column headings, where a column takes suggestions from one. */
export const NAMES_TAB = "names";
export const IDENTIFIERS_TAB = "identifiers";
export const ABOUT_TAB = "about";

/** What the file says of each column Beeline reads from it, from the comparison's own rule for it and the words the upload page uses. */
function aboutRows(m: Messages): Rows {
  const layout = SPECIMENS_LAYOUT;
  const a = m.workbook.about;
  const p = m.uploads.page;
  const takes = (column: string): string => {
    if (column === "scientificName") return a.scientificName;
    if (column === "identifiedBy") return a.identifiedBy;
    if (column === "occurrenceRemarks") return a.occurrenceRemarks;
    const words = (SPECIMEN_CHOICES as Record<string, readonly string[]>)[column];
    if (words !== undefined) return a.oneOf(words.join(", "));
    switch (columnRule(column)?.reads) {
      case "number":
        return p.heldTodo.number_unreadable!;
      case "moment":
        return a.momentRule;
      default:
        return a.anyText;
    }
  };
  return [
    [a.purposeTopic, a.purpose],
    [a.columnsTopic, a.columns],
    [a.leaveTopic, a.leave],
    ...layout.read.map((c): Array<string | null> => [c, takes(c)]),
    [a.lookupTopic, a.lookup],
    [a.windowsTopic, a.windows],
  ];
}

export interface SpecimenWorkbook {
  /** The headings of the main sheet, in order: a subset of the CSV's. */
  header: readonly string[];
  /** The writer's options for everything beyond the rows. */
  options: Pick<XlsxWriterOptions, "sheets" | "choices" | "shadedColumns" | "boldHeadings">;
}

/** The specimens file, beyond its rows. `today` is a day in Oregon, which a test fixes. */
export async function specimenWorkbook(db: Kysely<Database>, m: Messages, today: string = oregonToday()): Promise<SpecimenWorkbook> {
  const layout = SPECIMENS_LAYOUT;
  const warn = (words: readonly string[], column: string): ColumnChoices => ({
    words,
    title: m.workbook.warning.title,
    message: m.workbook.warning.message(column),
  });
  const sheets: ExtraSheet[] = [];
  const choices: Record<string, ColumnChoices> = {};
  // The four vocabularies warn on whichever file reads the column.
  for (const [column, words] of Object.entries(SPECIMEN_CHOICES)) if (layout.read.includes(column)) choices[column] = warn(words, column);
  const [names, identifiers] = await Promise.all([nameRows(db), identifierRows(db, today)]);
  sheets.push(
    { name: NAMES_TAB, header: ["scientificName", "taxonRank", "family"], rows: names },
    { name: IDENTIFIERS_TAB, header: ["identifiedBy"], rows: identifiers },
  );
  choices.scientificName = { sheet: NAMES_TAB, column: "scientificName" };
  choices.identifiedBy = { sheet: IDENTIFIERS_TAB, column: "identifiedBy" };
  sheets.push({ name: ABOUT_TAB, header: [m.workbook.about.headingTopic, m.workbook.about.headingText], rows: aboutRows(m) });
  return {
    header: layout.headings,
    options: { sheets, choices, shadedColumns: layout.shaded, boldHeadings: layout.read },
  };
}
