import { Zip, ZipDeflate } from "fflate";
import { sql, type Kysely } from "kysely";
import {
  dateIdentified,
  OUTSIDE,
  pagedStream,
  SPECIMEN_DWC_COLUMNS,
  SPECIMEN_OWN_COLUMNS,
  specimenCsvRow,
  type Page,
  type SpecimenRow,
} from "./listings.js";
import type { CsvTiming } from "./request-timing.js";
import type { Database, DeterminationQualifier } from "../model.js";

/**
 * One program's specimens as a Darwin Core archive (https://dwc.tdwg.org/text/),
 * offered to admins on /exports: the columns of the specimens CSV, zipped with
 * a `meta.xml` that maps each to its Darwin Core term, and with what a flat
 * file cannot carry — every determination of every specimen, in the
 * Identification extension. `determination` is append-only and the CSV holds
 * only the determination of record; Ecdysis (Symbiota) and GBIF both read an
 * archive's identification history.
 *
 * It is for operations and for validating against GBIF's and Symbiota's
 * readers, and the page says not to upload it anywhere: what each program
 * publishes is undecided — which `occurrenceID` an imported specimen carries
 * (ADR 0008, beeline-1kb.14, beeline-1kb.22), the licence and metadata, and
 * each atlas's answer on taxon-obscured coordinates (beeline-1kb.7.1). Which
 * volunteer determinations go downstream is the atlas staff's call after
 * downloading (beeline-pyr), so every determination is in the file.
 *
 * - `occurrence.txt`, the core: one row per specimen, the CSV's columns in the
 *   CSV's order behind an `id`. Only the Darwin Core columns are declared in
 *   `meta.xml`; Beeline's own (geoprivacy, coordinate provenance, the atlas)
 *   follow them undeclared, so a reader of the archive ignores them and a
 *   person opening the file still sees them.
 * - `identification.txt`, the extension: one row per determination, oldest
 *   first, joined to the core by `coreid`; its sex and caste, whether it is
 *   the record, and whether an expert made it follow undeclared.
 *
 * `id` is the specimen's `entity_id`. It joins the two files and means nothing
 * outside the archive: a rebuild redraws it (ADR 0002), and neither
 * `occurrenceID` (minted only by a print run) nor `catalogNumber` (absent
 * before field numbering, and not unique across the identifier eras) is on
 * every row.
 *
 * Tab-separated with nothing quoted, as GBIF's IPT writes archives: a tab or a
 * line break inside a value becomes a space, and nothing is formula-guarded,
 * since an archive is read by programs rather than opened in a spreadsheet.
 * No `eml.xml` yet: the metadata names a publisher and a contact, which is
 * the program's to say.
 */

/**
 * A program as the archive sees it: the listing scope that selects its
 * specimens, or null where none can yet.
 *
 * A sample's program is stated, not derived (CONTEXT.md, Program): its
 * collecting event's program where it belongs to one, else the atlas it fell
 * in, else Master Melittology. No sample belongs to an event yet, so an
 * atlas's specimens are the ones collected on its ground and Master
 * Melittology's are those no atlas covers — the listing's `outside`. The BLM
 * surveys are the program that rule leaves out on purpose: their samples will
 * arrive through their own pipeline (field entry, and a collecting event that
 * says whose day it was), and a BLM sample taken in New Mexico is BLM's and
 * not the New Mexico Bee Atlas's, though it fell on that atlas's ground. Until
 * that pipeline exists Beeline holds none of them and offers no archive; when
 * it does, the archives must select by the sample's program, never by where it
 * fell, or BLM's samples land in the atlas archives.
 */
export interface ProgramArchive {
  code: string;
  name: string;
  scope: string | null;
}

/** Master Melittology: the program a sample belongs to when no atlas and no event claims it. */
const CATCH_ALL_PROGRAM = "MM";

/** Every program, atlases first, with the scope its archive reads. */
export async function programArchives(db: Kysely<Database>): Promise<ProgramArchive[]> {
  const rows = await db
    .selectFrom("program as p")
    .leftJoin("atlas as a", "a.entity_id", "p.atlas_id")
    .select(["p.code", "p.name", "a.code as atlas_code"])
    .orderBy(sql`p.atlas_id IS NULL`)
    .orderBy("p.name")
    .execute();
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    scope: r.atlas_code ?? (r.code === CATCH_ALL_PROGRAM ? OUTSIDE : null),
  }));
}

const DWC = "http://rs.tdwg.org/dwc/terms/";

/** One determination, as the Identification extension carries it. */
export interface IdentificationRow {
  specimen_id: number;
  scientific_name: string;
  authorship: string | null;
  rank: string;
  qualifier: DeterminationQualifier | null;
  verbatim_identification: string | null;
  determiner: string | null;
  determined_on: Date | string | null;
  determined_on_precision: "month" | "year" | null;
  sex: string | null;
  caste: string | null;
  is_expert: boolean;
  of_record: boolean;
}

export const IDENTIFICATION_DWC_COLUMNS = [
  "scientificName",
  "scientificNameAuthorship",
  "taxonRank",
  "identificationQualifier",
  "verbatimIdentification",
  "identifiedBy",
  "dateIdentified",
] as const;

/**
 * Beeline's own, with no Darwin Core term. Sex and caste are a determination's
 * too, and an earlier one may have said something else; Darwin Core has `sex`
 * only on the occurrence, which carries the determination of record's.
 */
export const IDENTIFICATION_OWN_COLUMNS = ["sex", "caste", "identificationOfRecord", "identifiedByExpert"] as const;

/** Every determination of these specimens, each specimen's oldest first. */
export async function identificationsOf(db: Kysely<Database>, specimenIds: number[]): Promise<IdentificationRow[]> {
  if (specimenIds.length === 0) return [];
  const rows = await db
    .selectFrom("determination as d")
    .innerJoin("animal as an", "an.entity_id", "d.animal_id")
    .leftJoin("person as p", "p.entity_id", "d.determiner_id")
    .leftJoin("determination_of_record as dor", "dor.entity_id", "d.entity_id")
    .where("d.specimen_id", "in", specimenIds)
    .select((eb) => [
      "d.specimen_id",
      "an.scientific_name",
      "an.authorship",
      "an.rank",
      "d.qualifier",
      "d.verbatim_identification",
      eb.fn.coalesce("p.display_name", "d.determiner_name").as("determiner"),
      "d.determined_on",
      "d.determined_on_precision",
      "d.sex",
      "d.caste",
      "d.is_expert",
      eb("dor.entity_id", "is not", null).as("of_record"),
    ])
    .orderBy("d.specimen_id")
    .orderBy("d.recorded_at")
    .orderBy("d.entity_id")
    .execute();
  return rows.map((r) => ({
    ...r,
    specimen_id: Number(r.specimen_id),
    is_expert: Boolean(r.is_expert),
    of_record: Boolean(r.of_record),
  })) as IdentificationRow[];
}

const identificationRow = (r: IdentificationRow): unknown[] => [
  r.specimen_id,
  r.scientific_name,
  r.authorship,
  r.rank,
  r.qualifier,
  r.verbatim_identification,
  r.determiner,
  dateIdentified(r.determined_on, r.determined_on_precision),
  r.sex,
  r.caste,
  String(r.of_record),
  String(r.is_expert),
];

/** One cell: empty for nothing, and no tab or line break to end it early. */
export function tabCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return text.replace(/[\t\r\n]+/g, " ");
}

const tabLine = (row: readonly unknown[]) => `${row.map(tabCell).join("\t")}\n`;

const fields = (columns: readonly string[]) =>
  columns.map((term, i) => `    <field index="${i + 1}" term="${DWC}${term}"/>`).join("\n");

/** The descriptor: which file is which, and which column holds which term. */
export const META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<archive xmlns="http://rs.tdwg.org/dwc/text/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://rs.tdwg.org/dwc/text/ http://rs.tdwg.org/dwc/text/tdwg_dwc_text.xsd">
  <core encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n" fieldsEnclosedBy="" ignoreHeaderLines="1" rowType="${DWC}Occurrence">
    <files><location>occurrence.txt</location></files>
    <id index="0"/>
${fields(SPECIMEN_DWC_COLUMNS)}
    <!-- Columns ${SPECIMEN_DWC_COLUMNS.length + 1} onwards are Beeline's own and have no Darwin Core term: ${SPECIMEN_OWN_COLUMNS.join(", ")}. -->
  </core>
  <extension encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n" fieldsEnclosedBy="" ignoreHeaderLines="1" rowType="${DWC}Identification">
    <files><location>identification.txt</location></files>
    <coreid index="0"/>
${fields(IDENTIFICATION_DWC_COLUMNS)}
    <!-- Columns ${IDENTIFICATION_DWC_COLUMNS.length + 1} onwards are Beeline's own and have no Darwin Core term: ${IDENTIFICATION_OWN_COLUMNS.join(", ")}. -->
  </extension>
</archive>
`;

/** A page of specimens with every determination of each. */
export interface ArchivePage extends Page<SpecimenRow> {
  identifications: IdentificationRow[];
}

/**
 * The archive as a stream, a page of the listing at a time. A ZIP holds its
 * files one after another, so the core streams out as it is written while
 * the identifications wait, compressed, until the core is finished. That
 * wait is held in memory, and it is small: every determination in the dev
 * store (272,906 of them, all programs at once) compresses to 1.6 MB, where
 * a second pass over the listing to avoid it would cost the ~20 s the first
 * one does.
 */
export function specimenArchiveStream(
  fetch: (limit: number, offset: number) => Promise<ArchivePage>,
  timing?: CsvTiming,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const out: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    out.push(chunk);
  });
  const take = () => out.splice(0);
  let core: ZipDeflate;
  let identifications: ZipDeflate;
  const file = (name: string) => {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    return f;
  };
  return pagedStream(
    "specimens archive",
    fetch,
    {
      head: () => {
        file("meta.xml").push(encoder.encode(META_XML), true);
        core = file("occurrence.txt");
        core.push(encoder.encode(tabLine(["id", ...SPECIMEN_DWC_COLUMNS, ...SPECIMEN_OWN_COLUMNS])));
        identifications = file("identification.txt");
        identifications.push(
          encoder.encode(tabLine(["coreid", ...IDENTIFICATION_DWC_COLUMNS, ...IDENTIFICATION_OWN_COLUMNS])),
        );
        return take();
      },
      page: (page) => {
        core.push(encoder.encode(page.rows.map((r) => tabLine([r.specimen_id, ...specimenCsvRow(r, page)])).join("")));
        identifications.push(encoder.encode(page.identifications.map((r) => tabLine(identificationRow(r))).join("")));
        return take();
      },
      tail: () => {
        core.push(new Uint8Array(0), true);
        identifications.push(new Uint8Array(0), true);
        zip.end();
        return take();
      },
    },
    timing,
  );
}
