import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { monthsBefore, oregonToday } from "../oregon-today.js";
import { trapCountOf } from "../trap-sample.js";
import { SAMPLE_CSV_HEADER, sampleCsvRow, textCell, type Page, type SampleRow } from "./listings.js";
import type { Messages } from "./messages/en.js";
import { SAMPLES_LAYOUT, SAMPLES_READ } from "./upload-plan.js";
import type { ExtraSheet, XlsxWriterOptions } from "./xlsx.js";

/**
 * The samples Excel download (beeline-kgyd.4.9): one row for each sample, in
 * the columns of `SAMPLES_LAYOUT` (src/app/upload-plan.ts), with the values the
 * samples CSV writes (`sampleCsvRow`) wherever the CSV has the column, so the
 * comparison and the download cannot drift. Like the specimens file
 * (src/app/specimen-workbook.ts) every cell is text and nothing in it is
 * relied on: the upload checks every cell again.
 */

/** Years back that a collector counts as active, for the collectors tab. */
export const COLLECTOR_MONTHS = 24;

/** `sampleVersion` of this file starts with a letter no other version does (`s`, `v` and `o` are taken), so a spreadsheet leaves it as text. */
const VERSION_PREFIX = "f";

/**
 * What the file says of one sample, as text, aligned to `SAMPLES_LAYOUT.headings`. The version is a hash of the sample's
 * id and the text of every white cell as written here: the file's own, not the listings' (`sampleVersion` in
 * src/app/listings.ts), which covers fewer cells. Two rows with the same version said the same things.
 */
export function samplesFileRow(r: SampleRow, page: Page<SampleRow>): Array<string | null> {
  const written = sampleCsvRow(r, page);
  const white = SAMPLES_READ.map((column): string | null => {
    // The leading number of the effort, as the trap form writes it; none for a net sample or an effort in other words.
    if (column === "trapCount") {
      const count = trapCountOf(r.sampling_effort);
      return count === null ? null : String(count);
    }
    return textCell(written[SAMPLE_CSV_HEADER.indexOf(column)]);
  });
  const version = `${VERSION_PREFIX}${createHash("sha256")
    .update(JSON.stringify([r.sample_id, ...white.map((t) => t ?? "")]))
    .digest("hex")
    .slice(0, 12)}`;
  return [...white, String(r.sample_id), version];
}

/**
 * Everyone who collected a sample whose last day of collecting is in the
 * last 24 months, by display name as `recordedBy` writes one, once each,
 * sorted. For looking a name up: `recordedBy` takes no list, since a spreadsheet may mark a name that is
 * not on it "Invalid" and a collector Beeline has not met is ordinary.
 */
export async function collectorRows(db: Kysely<Database>, today: string): Promise<Array<Array<string | null>>> {
  const since = monthsBefore(today, COLLECTOR_MONTHS);
  const result = await sql<{ name: string }>`
    SELECT DISTINCT p.display_name AS name
    FROM sample_collector c
    JOIN person p ON p.entity_id = c.person_id
    JOIN sample s ON s.entity_id = c.sample_id
    WHERE s.date_end >= CAST(${since} AS DATE) AND trim(p.display_name) <> ''
    ORDER BY name`.execute(db);
  return result.rows.map((r) => [r.name]);
}

export const COLLECTORS_TAB = "collectors";
export const SAMPLES_ABOUT_TAB = "about";

/** Columns whose text can be long, so wrapped (see WRAPPED_COLUMNS in src/app/specimen-workbook.ts for why). */
export const SAMPLES_WRAPPED_COLUMNS: readonly string[] = ["recordedBy", "samplingProtocol", "county", "locality"];
export const SAMPLES_COLUMN_WIDTHS: Readonly<Record<string, number>> = {
  recordedBy: 28,
  eventDate: 22,
  samplingProtocol: 18,
  county: 18,
  locality: 32,
};

function aboutRows(m: Messages): Array<Array<string | null>> {
  const a = m.workbook.about;
  const s = m.workbook.samples;
  return [
    [s.purposeTopic, s.purpose],
    [a.columnsTopic, s.columns],
    [s.leaveTopic, s.leave],
    [s.newTopic, s.newRows],
    ...SAMPLES_READ.map((column): Array<string | null> => [column, s.column[column] ?? null]),
    [s.lookupTopic, s.lookup],
  ];
}

export interface SamplesWorkbook {
  /** The headings of the main sheet, in order. */
  header: readonly string[];
  /** The writer's options for everything beyond the rows. */
  options: Pick<XlsxWriterOptions, "sheets" | "shadedColumns" | "boldHeadings" | "widths" | "wrappedColumns">;
}

/** The samples file beyond its rows. `today` is a day in Oregon, which a test fixes. */
export async function samplesWorkbook(db: Kysely<Database>, m: Messages, today: string = oregonToday()): Promise<SamplesWorkbook> {
  const sheets: ExtraSheet[] = [
    { name: COLLECTORS_TAB, header: ["recordedBy"], rows: await collectorRows(db, today) },
    { name: SAMPLES_ABOUT_TAB, header: [m.workbook.about.headingTopic, m.workbook.about.headingText], rows: aboutRows(m) },
  ];
  return {
    header: SAMPLES_LAYOUT.headings,
    options: {
      sheets,
      shadedColumns: SAMPLES_LAYOUT.shaded,
      boldHeadings: SAMPLES_LAYOUT.read,
      widths: SAMPLES_COLUMN_WIDTHS,
      wrappedColumns: SAMPLES_WRAPPED_COLUMNS,
    },
  };
}
