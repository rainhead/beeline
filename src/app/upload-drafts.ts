import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database, DraftCaste, DraftSex } from "../model.js";
import { entryRowsFor, type EntryRow } from "./determine.js";
import { ownIdentifications } from "./own-identification.js";
import type { CellValue, HeldItem, HoldReason, SpecimenDifference, UploadPlan } from "./upload-plan.js";

/**
 * A volunteer's identifications from their file, as drafts (beeline-kgyd.7).
 * The comparison (src/app/upload-plan.ts) says which identifications differ
 * from what the person's own download wrote; this says what each would be as
 * a draft on Identify specimens, or why it is held instead.
 *
 * A draft is written by saveDrafts (src/app/determine.ts), the page's own
 * writer, so the overnight commit, the undo until 1am and the caste rules are
 * the page's. But saveDrafts quietly fixes what it is given: a sex it does not
 * take becomes none, a caste the taxon does not have is dropped, a male of a
 * bee with castes becomes a drone. On the page a person sees the result at
 * once. From a file they would not, so each of those is held here, with words
 * saying what to write, and a write reaches saveDrafts only when saveDrafts
 * would keep it as it is.
 *
 * Who is who follows the page: the specimens are those of the person being
 * acted for, when a delegate has the switch on, and the drafts are credited to
 * whoever is signed in.
 */

export interface DraftWho {
  /** Whose specimens: the person acted for, else the person signed in. */
  personId: number;
  /** Who the drafts are credited to: the person signed in. */
  determinerId: number;
}

/** One identification from the file, as the draft it becomes. Every part is given, so nothing is taken from elsewhere. */
export interface DraftLine {
  difference: SpecimenDifference;
  write: { specimenId: number; animalId: number | null; ecdysisTid: number | null; sex: DraftSex | null; caste: DraftCaste | null };
  /** The person has a draft of this specimen on Identify specimens, which this replaces. */
  replacesDraft: boolean;
}

export interface DraftPlan {
  /** The comparison, with what cannot become a draft moved to its held list. */
  plan: UploadPlan;
  lines: DraftLine[];
  /** Rows of the file for specimens the person may not name, whether or not they differ. Those that differ are held. */
  notYours: number;
  /** What saving would write, as a short hash: the preview's form carries it, and saving refuses a plan that changed since. */
  digest: string;
}

const CHUNK = 1000;
/** The ranks the Identify specimens picker leaves out (entryTaxa): nobody names a pinned insect Insecta. */
const SCAFFOLDING = ["kingdom", "phylum", "class"];
/** The columns a volunteer's identification is made of. A file must have all three to say one. */
const COLUMNS = ["scientificName", "sex", "caste"] as const;

const textOf = (v: CellValue | undefined): string =>
  v === undefined ? "" : v.kind === "text" ? v.text : v.kind === "word" ? v.word : "";

/** The page's rows for these specimens, in chunks: only those the person may name. */
async function reachable(db: Kysely<Database>, who: DraftWho, ids: readonly number[]): Promise<Map<number, EntryRow>> {
  const out = new Map<number, EntryRow>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    for (const row of await entryRowsFor(db, who.personId, who.determinerId, ids.slice(i, i + CHUNK))) out.set(row.id, row);
  }
  return out;
}

/** Every node of the tree a person may give, by its exact name, with whether it takes castes. */
async function nodesNamed(db: Kysely<Database>, names: readonly string[]): Promise<Map<string, Array<{ id: number; castes: boolean }>>> {
  const out = new Map<string, Array<{ id: number; castes: boolean }>>();
  for (let i = 0; i < names.length; i += CHUNK) {
    const found = await sql<{ id: number; name: string; castes: boolean }>`
      SELECT a.entity_id AS id, a.scientific_name AS name, c.has_castes AS castes
      FROM animal a JOIN animal_castes c ON c.animal_id = a.entity_id
      WHERE a.scientific_name IN (${sql.join(names.slice(i, i + CHUNK))})
        AND a.rank NOT IN (${sql.join(SCAFFOLDING)})`.execute(db);
    for (const r of found.rows) (out.get(r.name) ?? out.set(r.name, []).get(r.name)!).push({ id: Number(r.id), castes: r.castes === true });
  }
  return out;
}

async function castesOf(db: Kysely<Database>, ids: readonly number[]): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const found = await sql<{ id: number; castes: boolean }>`
      SELECT animal_id AS id, has_castes AS castes FROM animal_castes WHERE animal_id IN (${sql.join(ids.slice(i, i + CHUNK))})`.execute(db);
    for (const r of found.rows) out.set(Number(r.id), r.castes === true);
  }
  return out;
}

export async function draftPlan(db: Kysely<Database>, compared: UploadPlan, who: DraftWho): Promise<DraftPlan> {
  const entries = await reachable(db, who, compared.matched);
  const yours = (id: number | null) => id !== null && entries.has(id);
  const held: HeldItem[] = compared.held.filter((h) => h.specimenId === null || yours(h.specimenId));

  // A row for a specimen the page would not let the person name is not theirs to change. It is listed only where
  // it differs; the rest are counted.
  const notYours = compared.matched.filter((id) => !entries.has(id)).length;
  const others = new Map<number, HeldItem>();
  const notYoursAt = (row: number, specimenId: number, fieldNumber: string | null, cells: HeldItem["cells"]) => {
    const was = others.get(row);
    if (was !== undefined) {
      was.cells.push(...cells);
      was.columns.push(...cells.map((c) => c.column));
      return;
    }
    others.set(row, {
      reason: "not_yours",
      row,
      rows: [row],
      moreRows: 0,
      specimenId,
      fieldNumber,
      sampleNumber: null,
      sample: null,
      unit: null,
      column: cells[0]?.column ?? null,
      columns: cells.map((c) => c.column),
      cells: [...cells],
      detail: "",
    });
  };
  for (const h of compared.held) if (h.specimenId !== null && !yours(h.specimenId)) notYoursAt(h.row, h.specimenId, h.fieldNumber, h.cells);
  for (const d of compared.differences) {
    if (!yours(d.specimenId)) notYoursAt(d.row, d.specimenId, d.fieldNumber, d.cells.filter((c) => c.differs).map(({ column, was, fileSays }) => ({ column, was, fileSays })));
  }
  for (const c of compared.notApplied) {
    if (!yours(c.specimenId)) notYoursAt(c.row, c.specimenId, c.fieldNumber, [{ column: c.column, was: c.was, fileSays: c.fileSays }]);
  }

  const mine = compared.differences.filter((d) => yours(d.specimenId) && d.unit === "determination");
  const own = await ownIdentifications(db, who.determinerId, mine.map((d) => d.specimenId));
  const cellOf = (d: SpecimenDifference, column: string) => d.cells.find((c) => c.column === column);
  const newNames = [...new Set(mine.filter((d) => cellOf(d, "scientificName")?.differs === true).map((d) => textOf(cellOf(d, "scientificName")?.value)))].filter((n) => n !== "");
  const named = await nodesNamed(db, newNames);
  const castes = await castesOf(db, [...new Set([...own.values()].map((o) => o.animalId).filter((id): id is number => id !== null))]);

  const lines: DraftLine[] = [];
  for (const d of mine) {
    const hold = (reason: HoldReason, column: string) => {
      held.push({
        reason,
        row: d.row,
        rows: [d.row],
        moreRows: 0,
        specimenId: d.specimenId,
        fieldNumber: d.fieldNumber,
        sampleNumber: null,
        sample: null,
        unit: "determination",
        column,
        columns: d.cells.map((c) => c.column),
        cells: d.cells.map(({ column: c, was, fileSays }) => ({ column: c, was, fileSays })),
        detail: cellOf(d, column)?.fileSays ?? column,
      });
    };
    // A file without one of the three cannot say an identification whole: the part left out would come from
    // whatever the store has, which may be another volunteer's.
    const missing = COLUMNS.find((c) => cellOf(d, c) === undefined);
    if (missing !== undefined) {
      hold("column_missing", missing);
      continue;
    }
    const name = cellOf(d, "scientificName")!;
    let animalId: number | null;
    let ecdysisTid: number | null;
    let social: boolean;
    if (!name.differs) {
      // The name the person's own download gave, which may be one from Ecdysis that the tree does not hold yet.
      const mineNow = own.get(d.specimenId);
      animalId = mineNow?.animalId ?? null;
      ecdysisTid = mineNow?.ecdysisTid ?? null;
      social = animalId !== null && castes.get(animalId) === true;
    } else {
      const nodes = named.get(textOf(name.value)) ?? [];
      if (nodes.length === 0) {
        hold("name_not_in_tree", "scientificName");
        continue;
      }
      if (nodes.length > 1) {
        hold("name_ambiguous", "scientificName");
        continue;
      }
      animalId = nodes[0]!.id;
      ecdysisTid = null;
      social = nodes[0]!.castes;
    }
    const sexWord = textOf(cellOf(d, "sex")!.value);
    const casteWord = textOf(cellOf(d, "caste")!.value);
    if (sexWord !== "" && sexWord !== "female" && sexWord !== "male") {
      hold("sex_not_draft", "sex");
      continue;
    }
    if (casteWord !== "" && !social) {
      hold("caste_not_taken", "caste");
      continue;
    }
    if (casteWord !== "" && sexWord === "") {
      hold("caste_no_sex", "caste");
      continue;
    }
    // saveDrafts makes a male of a bee with castes a drone; the file should say so itself.
    if (social && sexWord === "male" && casteWord === "") {
      hold("drone_unsaid", "caste");
      continue;
    }
    const write: DraftLine["write"] = {
      specimenId: d.specimenId,
      animalId,
      ecdysisTid,
      sex: sexWord === "" ? null : (sexWord as DraftSex),
      caste: casteWord === "" ? null : (casteWord as DraftCaste),
    };
    const entry = entries.get(d.specimenId)!;
    // saveDrafts keeps no draft that says what the newest volunteer identification already says, so with no draft
    // to replace, saving would change nothing, and the file would say the same again next time.
    const prior = entry.prior;
    if (
      entry.draft === null &&
      prior !== null &&
      prior.animalId === write.animalId &&
      write.ecdysisTid === null &&
      prior.sex === write.sex &&
      prior.caste === write.caste
    ) {
      hold("already_said", "scientificName");
      continue;
    }
    lines.push({ difference: d, write, replacesDraft: entry.draft !== null });
  }

  const order = (a: HeldItem, b: HeldItem) => a.row - b.row;
  const plan: UploadPlan = {
    ...compared,
    differences: lines.map((l) => l.difference),
    held: [...held, ...others.values()].sort(order),
    notApplied: compared.notApplied.filter((c) => yours(c.specimenId)),
  };
  return { plan, lines, notYours, digest: digestOf(lines) };
}

/** A short hash of what saving would write, in the file's order. */
export const digestOf = (lines: readonly DraftLine[]): string =>
  createHash("sha256")
    .update(JSON.stringify(lines.map((l) => [l.write.specimenId, l.write.animalId, l.write.ecdysisTid, l.write.sex, l.write.caste, l.replacesDraft])))
    .digest("hex")
    .slice(0, 32);
