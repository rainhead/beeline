import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { columnIndex, columnName, escapeText } from "./xlsx.js";

/**
 * Adding one column to a person's own workbook, and changing nothing else
 * (beeline-kgyd.7, Peter, 2026-11-18: the notes download is the person's exact
 * file with the note column added). Rewriting the workbook with a library
 * would drop its formatting and its validations, so the file is patched
 * instead: only the XML of the one sheet is edited, and only by adding a cell
 * to rows and a column width. The column goes after the last column the sheet
 * uses, so no cell, formula, merge, validation, conditional format, defined
 * name or table moves. Every other part of the zip is written back with the
 * same contents.
 *
 * What it will not patch, it says, and the caller hands back a copy instead:
 * a file it cannot unzip or find the sheet in, a sheet whose cells or rows do
 * not say where they are, one with a table (whose range could take in the new
 * column), or one written with a namespace prefix it does not expect.
 */

export type Annotated = { ok: true; bytes: Uint8Array } | { ok: false; why: string };

export interface ColumnToAdd {
  /** The tab to add it to, by name. */
  sheetName: string;
  /** The row the headings are in. */
  headerRow: number;
  heading: string;
  /** The text of the column's cell on each row, by row number; "" or absent for none. */
  values: ReadonlyMap<number, string>;
  /** A column already in the sheet to write into instead, its cells replaced (0 for A); null to add one after the last. */
  replace: number | null;
  /** Its width, in characters. */
  width: number;
}

const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-fA-F]+));/g, (_, name: string, dec?: string, hex?: string) =>
    dec !== undefined ? String.fromCodePoint(Number(dec)) : hex !== undefined ? String.fromCodePoint(parseInt(hex, 16)) : ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" } as Record<string, string>)[name]!,
  );

const attrOf = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag) ?? new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m === null ? null : unescapeXml(m[1]!);
};

/** A cell's column from its reference, `C12` → 2. */
const columnOf = (ref: string): number | null => {
  const m = /^([A-Z]{1,3})\d+$/.exec(ref);
  return m === null ? null : columnIndex(m[1]!);
};

/**
 * The most the parts of a file may unpack to, by what the zip says of them, before any is unpacked. The reader has
 * read the sheet in a worker with its own limits, but not every part, and this unpacks every part on the request
 * thread: a small file with one part that unpacks to gigabytes must not (CodeRabbit). Beeline's own download of
 * 20,000 rows unpacks to a few tens of megabytes.
 */
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

/** Every part of the zip, or null for a zip that cannot be read or says it unpacks to more than the limit. */
function unpack(bytes: Uint8Array): Record<string, Uint8Array> | null {
  let total = 0;
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        total += file.originalSize;
        if (total > MAX_UNPACKED_BYTES) throw new Error("too large unpacked");
        return true;
      },
    });
  } catch {
    return null;
  }
}

/** The path of the named sheet's XML inside the zip, or why it cannot be found. */
function sheetPath(files: Record<string, Uint8Array>, sheetName: string): string | { why: string } {
  const workbook = files["xl/workbook.xml"];
  const rels = files["xl/_rels/workbook.xml.rels"];
  if (workbook === undefined || rels === undefined) return { why: "no workbook part where Excel puts it" };
  const sheets = [...strFromU8(workbook).matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0]);
  const tag = sheets.find((t) => attrOf(t, "name") === sheetName);
  if (tag === undefined) return { why: "the sheet is not in the workbook part" };
  const id = attrOf(tag, "r:id");
  if (id === null) return { why: "the sheet has no relationship id" };
  const rel = [...strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => attrOf(t, "Id") === id);
  const target = rel === undefined ? null : attrOf(rel, "Target");
  if (target === null) return { why: "the sheet's relationship has no target" };
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`.replace(/\/\.\//g, "/");
  return files[path] === undefined ? { why: `no part at ${path}` } : path;
}

const CELL = /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
const ROW = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;

/** Whether the sheet can be patched, and the facts patching needs. */
function inspect(xml: string): { lastColumn: number } | { why: string } {
  if (/<\w+:sheetData\b/.test(xml) || /<\w+:row\b/.test(xml)) return { why: "the sheet is written with a namespace prefix" };
  const data = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  if (data === null) return { why: "the sheet has no sheetData" };
  if (/<tablePart\b/.test(xml)) return { why: "the sheet has a table, whose range could take in a new column" };
  let last = -1;
  for (const row of (data[1] ?? "").matchAll(ROW)) {
    if (attrOf(`<row${row[1]}>`, "r") === null) return { why: "a row does not say its number" };
    for (const cell of (row[2] ?? "").matchAll(CELL)) {
      const ref = attrOf(cell[0].slice(0, cell[0].indexOf(">") + 1), "r");
      const column = ref === null ? null : columnOf(ref);
      if (column === null) return { why: "a cell does not say where it is" };
      last = Math.max(last, column);
    }
  }
  const dimension = /<dimension\b[^>]*>/.exec(xml);
  const ref = dimension === null ? null : attrOf(dimension[0], "ref");
  const end = ref?.split(":")[1] ?? ref;
  const endColumn = end === undefined || end === null ? null : columnOf(end);
  return { lastColumn: Math.max(last, endColumn ?? -1) };
}

/** Whether the person's own file can be handed back with a column added, or why not. */
export function canAnnotate(bytes: Uint8Array, sheetName: string): { ok: true } | { ok: false; why: string } {
  const files = unpack(bytes);
  if (files === null) return { ok: false, why: "the file cannot be unzipped, or unpacks to too much" };
  const path = sheetPath(files, sheetName);
  if (typeof path !== "string") return { ok: false, why: path.why };
  const facts = inspect(strFromU8(files[path]!));
  return "why" in facts ? { ok: false, why: facts.why } : { ok: true };
}

const inlineCell = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeText(text)}</t></is></c>`;

/** The person's own file with one column added or rewritten, or why it was not. */
export function annotateWorkbook(bytes: Uint8Array, add: ColumnToAdd): Annotated {
  const files = unpack(bytes);
  if (files === null) return { ok: false, why: "the file cannot be unzipped, or unpacks to too much" };
  const path = sheetPath(files, add.sheetName);
  if (typeof path !== "string") return { ok: false, why: path.why };
  let xml = strFromU8(files[path]!);
  const facts = inspect(xml);
  if ("why" in facts) return { ok: false, why: facts.why };
  const column = add.replace ?? facts.lastColumn + 1;
  if (column > 16383) return { ok: false, why: "the sheet has no column left" };
  const letter = columnName(column);
  const textOf = (row: number) => (row === add.headerRow ? add.heading : (add.values.get(row) ?? ""));

  xml = xml.replace(/(<sheetData\b[^>]*?>)([\s\S]*?)(<\/sheetData>)/, (_, open: string, body: string, close: string) => {
    const patched = body.replace(ROW, (whole: string, attrs: string, content: string | undefined) => {
      const r = Number(attrOf(`<row${attrs}>`, "r"));
      const text = textOf(r);
      const matches = [...(content ?? "").matchAll(CELL)];
      const cells = matches.map((m) => m[0]);
      const others = cells.filter((c) => columnOf(attrOf(c.slice(0, c.indexOf(">") + 1), "r") ?? "") !== column);
      if (text === "" && others.length === cells.length) return whole;
      // Everything between the cells (an extension list, whitespace) is kept after them: the
      // text in the gaps between the matched cells, joined, rather than the row with the cells
      // replaced away.
      let rest = "";
      let from = 0;
      for (const m of matches) {
        rest += (content ?? "").slice(from, m.index);
        from = m.index! + m[0].length;
      }
      rest += (content ?? "").slice(from);
      const at = others.findIndex((c) => (columnOf(attrOf(c.slice(0, c.indexOf(">") + 1), "r") ?? "") ?? -1) > column);
      const added = text === "" ? [] : [inlineCell(`${letter}${r}`, text)];
      const ordered = at === -1 ? [...others, ...added] : [...others.slice(0, at), ...added, ...others.slice(at)];
      // A row's spans are a hint of the columns it uses; the new cell may lie outside them, so the hint goes.
      const openTag = `<row${attrs.replace(/\sspans\s*=\s*"[^"]*"/, "")}>`;
      return `${openTag}${ordered.join("")}${rest}</row>`;
    });
    return `${open}${patched}${close}`;
  });

  // The sheet's stated extent takes in the column.
  xml = xml.replace(/<dimension\b([^>]*?)ref\s*=\s*"([^"]*)"([^>]*)>/, (whole: string, before: string, ref: string, after: string) => {
    const [start, end = start] = ref.split(":");
    const m = /^([A-Z]+)(\d+)$/.exec(end!);
    if (m === null || (columnIndex(m[1]!) ?? 0) >= column) return whole;
    return `<dimension${before}ref="${start}:${letter}${m[2]}"${after}>`;
  });

  // A width for the column, only where no column definition already covers it or comes after it.
  const n = column + 1;
  const cols = /<cols>([\s\S]*?)<\/cols>/.exec(xml);
  const width = `<col min="${n}" max="${n}" width="${add.width}" customWidth="1"/>`;
  if (cols === null) xml = xml.replace(/<sheetData\b/, (m) => `<cols>${width}</cols>${m}`);
  else {
    const maxes = [...cols[1]!.matchAll(/<col\b[^>]*>/g)].map((c) => Number(attrOf(c[0], "max") ?? 0));
    if (maxes.every((max) => max < n)) xml = xml.replace(/<\/cols>/, `${width}</cols>`);
  }

  const out: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) out[name] = name === path ? strToU8(xml) : content;
  return { ok: true, bytes: zipSync(out) };
}
