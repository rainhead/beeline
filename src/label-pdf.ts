import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import fontkit from "@pdf-lib/fontkit";
import bwipjs from "bwip-js/node";
import {
  concatTransformationMatrix,
  degrees,
  drawObject,
  PDFDocument,
  PDFName,
  PDFRawStream,
  popGraphicsState,
  pushGraphicsState,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { LABELS_PER_SHEET } from "./label-text.js";

/**
 * Renders a print run's labels to PDF sheets, from printed_label rows only
 * (schema/035): nothing live is read, so a run re-renders byte-identical
 * later — the creation and modification dates are the run's prepared_at,
 * the producer is fixed, and pdf-lib writes no random ID.
 *
 * The geometry is the reference implementation's, verbatim
 * (LabelsSubtaskHandler.js): 25 rows of 10 on US Letter, 0.25" and 0.5"
 * margins, labels 0.666" × 0.311", the six text boxes where it put them with
 * its shrink-to-fit rule, an 8×18 DataMatrix of the field number rotated to
 * stand on end at the right. Arthur asked that the new sheet match the old
 * one (2026-09-08, gh-17) — the extra rows the page could hold are not worth
 * a change collectors would have to absorb — and the labels in the drawers
 * are the ones a new one is compared against.
 *
 * One departure in mechanism, not in appearance: the DataMatrix is drawn as
 * a 1-bit image built from bwip-js's module matrix rather than a PNG it
 * rasterises — 18 bytes per label instead of a decode, which is what makes a
 * 5,000-label run render in seconds.
 */

export interface LabelRow {
  sheet: number;
  cell: number;
  location_text: string;
  coordinates_text: string;
  date_text: string;
  collector_text: string;
  method_text: string;
  number_text: string;
}

export interface RenderOptions {
  /** Stamped as the document's creation and modification date, so re-renders hash equal. */
  preparedAt: Date;
  /** The font file; defaults to the vendored Oxygen Mono. */
  fontPath?: string;
}

const PT = 72; // PostScript points per inch
const ROWS = 25;
const COLUMNS = 10;
const PAGE = { width: 8.5 * PT, height: 11 * PT };
const MARGIN = { x: 0.25 * PT, y: 0.5 * PT };
const LABEL = { width: 0.666 * PT, height: 0.311 * PT };
const GAP = {
  x: (PAGE.width - 2 * MARGIN.x - COLUMNS * LABEL.width) / (COLUMNS - 1),
  y: (PAGE.height - 2 * MARGIN.y - ROWS * LABEL.height) / (ROWS - 1),
};

export const FONT_PATH = new URL("../assets/fonts/OxygenMono-Regular.ttf", import.meta.url);

interface TextBox {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  rotation: 0 | 90;
  offset: { x: number; y: number };
  fit: boolean;
}

/** The reference's six boxes, in inches converted to points. */
const BOXES: Record<"location" | "coordinates" | "date" | "collector" | "method" | "number", TextBox> = {
  location: { x: 0.005 * PT, y: 0.18525 * PT, width: 0.46 * PT, height: 0.12075 * PT, fontSize: 3, rotation: 0, offset: { x: 0, y: -2.3 }, fit: false },
  coordinates: { x: 0.005 * PT, y: 0.145 * PT, width: 0.46 * PT, height: 0.04025 * PT, fontSize: 3, rotation: 0, offset: { x: 0, y: -2.3 }, fit: true },
  date: { x: 0.005 * PT, y: 0.075 * PT, width: 0.46 * PT, height: 0.07 * PT, fontSize: 5, rotation: 0, offset: { x: 0, y: -0.056 * PT }, fit: true },
  collector: { x: 0.005 * PT, y: 0.005 * PT, width: 0.335 * PT, height: 0.07 * PT, fontSize: 5, rotation: 0, offset: { x: 0, y: -0.056 * PT }, fit: true },
  method: { x: 0.36 * PT, y: 0.005 * PT, width: 0.105 * PT, height: 0.07 * PT, fontSize: 5, rotation: 0, offset: { x: 0, y: -0.056 * PT }, fit: true },
  number: { x: 0.661 * PT, y: 0.005 * PT, width: LABEL.height - 0.01 * PT, height: 0.07 * PT, fontSize: 4.5, rotation: 90, offset: { x: -0.75, y: -5 }, fit: true },
};
const MATRIX_BOX = { x: 0.476 * PT, y: 0.005 * PT, width: 0.11 * PT, height: LABEL.height - 0.01 * PT };

/**
 * The reference's shrink-to-fit: a single line shrinks until it fits the
 * width, a wrapping one until it fits the height, never below 1pt, nudging
 * the offset so the text stays inside the box.
 */
function drawTextBox(page: PDFPage, font: PDFFont, text: string, originX: number, originY: number, box: TextBox): void {
  let fontSize = box.fontSize;
  let xOffset = box.offset.x;
  let yOffset = box.offset.y;
  if (box.fit && text.length > 0) {
    const spaces = text.match(/ /g)?.length ?? 0;
    let lineWidth = font.widthOfTextAtSize(text, fontSize);
    let lines = Math.min(spaces + 1, Math.ceil(lineWidth / box.width));
    let lineHeight = font.heightAtSize(fontSize, { descender: true });
    let textHeight = lines * lineHeight;
    while (((lines === 1 && lineWidth > box.width) || (lines > 1 && textHeight > box.height)) && fontSize > 1) {
      fontSize -= 0.01;
      lineWidth = font.widthOfTextAtSize(text, fontSize);
      lines = spaces > 0 ? Math.ceil(lineWidth / box.width) : 1;
      lineHeight = font.heightAtSize(fontSize, { descender: true });
      textHeight = lines * lineHeight;
      if (box.rotation === 0) yOffset = (box.height - textHeight) * -0.5 - lineHeight * 0.8;
      else xOffset = (box.height - textHeight) * -0.5;
    }
  }
  page.drawText(text, {
    x: originX + box.x + xOffset,
    y: originY + box.y + box.height + yOffset,
    font,
    size: fontSize,
    lineHeight: fontSize,
    rotate: degrees(box.rotation),
    maxWidth: box.width,
  });
}

/**
 * The DataMatrix as bwip-js lays it out — DMRE 8×18, the reference's
 * choice, ten digits of numeric capacity — rotated a quarter turn
 * anticlockwise to stand on end (the reference's `rotate: 'L'`), as a grid
 * of dark cells, rows top to bottom.
 */
export function dataMatrixModules(text: string): { width: number; height: number; dark: boolean[][] } {
  // The reference encodes only the digits of the number, so a scanner reads
  // 26072094 and not a string; Beeline mints digits, so this is the number.
  const digits = text.replace(/\D/g, "");
  // `version` is a BWIPP option bwip-js's typings omit; the string form of
  // raw() takes it as a symbology option and is typed as accepting one.
  const [symbol] = bwipjs.raw(
    "datamatrixrectangularextension",
    digits.length > 0 ? digits : text,
    "version=8x18",
  ) as Array<{ pixs: number[]; pixx: number; pixy: number }>;
  if (!symbol) throw new Error(`no DataMatrix for ${JSON.stringify(text)}`);
  const { pixs, pixx, pixy } = symbol;
  // Rotate left: the cell at (x, y) in the upright symbol lands at
  // (y, pixx - 1 - x) in the rotated one, which is pixy wide and pixx tall.
  const dark: boolean[][] = Array.from({ length: pixx }, () => Array<boolean>(pixy).fill(false));
  for (let y = 0; y < pixy; y++) {
    for (let x = 0; x < pixx; x++) {
      if (pixs[y * pixx + x]) dark[pixx - 1 - x]![y] = true;
    }
  }
  return { width: pixy, height: pixx, dark };
}

/** Packs the grid as a 1-bit DeviceGray image: 1 is white, rows padded to a byte. */
function packBits(grid: { width: number; height: number; dark: boolean[][] }): Uint8Array {
  const stride = Math.ceil(grid.width / 8);
  const bytes = new Uint8Array(stride * grid.height).fill(0xff);
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (grid.dark[y]![x]) bytes[y * stride + (x >> 3)]! &= ~(0x80 >> (x & 7));
    }
  }
  return bytes;
}

function drawDataMatrix(doc: PDFDocument, page: PDFPage, text: string, originX: number, originY: number): void {
  const grid = dataMatrixModules(text);
  const dict = doc.context.obj({
    Type: "XObject",
    Subtype: "Image",
    Width: grid.width,
    Height: grid.height,
    ColorSpace: "DeviceGray",
    BitsPerComponent: 1,
    Interpolate: false,
  });
  const ref = doc.context.register(PDFRawStream.of(dict, packBits(grid)));
  const name = page.node.newXObject("DM", ref);
  // Scale to fit the box, as the reference's image.scaleToFit did, and
  // anchor at the box's lower-left corner.
  const scale = Math.min(MATRIX_BOX.width / grid.width, MATRIX_BOX.height / grid.height);
  const width = grid.width * scale;
  const height = grid.height * scale;
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(width, 0, 0, height, originX + MATRIX_BOX.x, originY + MATRIX_BOX.y),
    drawObject(PDFName.of(name.asString().slice(1))),
    popGraphicsState(),
  );
}

function cellOrigin(cell: number): { x: number; y: number } {
  const row = ROWS - Math.floor(cell / COLUMNS) - 1;
  const column = cell % COLUMNS;
  return {
    x: MARGIN.x + column * (LABEL.width + GAP.x),
    y: MARGIN.y + row * (LABEL.height + GAP.y),
  };
}

/** Renders the rows to a PDF, one page per sheet, in the order given. */
export async function renderLabelsPdf(rows: LabelRow[], opts: RenderOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await readFile(opts.fontPath ?? FONT_PATH), { subset: true });
  doc.setTitle("Beeline labels");
  doc.setProducer("Beeline");
  doc.setCreator("Beeline");
  doc.setCreationDate(opts.preparedAt);
  doc.setModificationDate(opts.preparedAt);

  const sheets = Math.max(0, ...rows.map((r) => r.sheet));
  const pages: PDFPage[] = [];
  for (let i = 0; i < sheets; i++) pages.push(doc.addPage([PAGE.width, PAGE.height]));

  for (const row of rows) {
    if (row.cell < 0 || row.cell >= LABELS_PER_SHEET) throw new Error(`cell ${row.cell} is off the sheet`);
    const page = pages[row.sheet - 1];
    if (!page) throw new Error(`sheet ${row.sheet} has no page`);
    const { x, y } = cellOrigin(row.cell);
    drawTextBox(page, font, row.location_text, x, y, BOXES.location);
    drawTextBox(page, font, row.coordinates_text, x, y, BOXES.coordinates);
    drawTextBox(page, font, row.date_text, x, y, BOXES.date);
    drawTextBox(page, font, row.collector_text, x, y, BOXES.collector);
    drawTextBox(page, font, row.method_text, x, y, BOXES.method);
    drawTextBox(page, font, row.number_text, x, y, BOXES.number);
    drawDataMatrix(doc, page, row.number_text, x, y);
  }
  return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
