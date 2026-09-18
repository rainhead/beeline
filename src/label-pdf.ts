import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import fontkit from "@pdf-lib/fontkit";
import bwipjs from "bwip-js/node";
import {
  breakTextIntoLines,
  degrees,
  fill,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingGrayscaleColor,
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
 * vector rectangles from bwip-js's module matrix rather than a PNG it
 * rasterises — sharp at any zoom, and no image to decode, which with fits
 * remembered per render is what makes a 5,000-label run render in a second
 * or two.
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
export const LABEL_BOXES: Record<"location" | "coordinates" | "date" | "collector" | "method" | "number", TextBox> = {
  location: { x: 0.005 * PT, y: 0.18525 * PT, width: 0.46 * PT, height: 0.12075 * PT, fontSize: 3, rotation: 0, offset: { x: 0, y: -2.3 }, fit: false },
  coordinates: { x: 0.005 * PT, y: 0.145 * PT, width: 0.46 * PT, height: 0.04025 * PT, fontSize: 3, rotation: 0, offset: { x: 0, y: -2.3 }, fit: true },
  date: { x: 0.005 * PT, y: 0.075 * PT, width: 0.46 * PT, height: 0.07 * PT, fontSize: 5, rotation: 0, offset: { x: 0, y: -0.056 * PT }, fit: true },
  collector: { x: 0.005 * PT, y: 0.005 * PT, width: 0.335 * PT, height: 0.07 * PT, fontSize: 5, rotation: 0, offset: { x: 0, y: -0.056 * PT }, fit: true },
  method: { x: 0.36 * PT, y: 0.005 * PT, width: 0.105 * PT, height: 0.07 * PT, fontSize: 5, rotation: 0, offset: { x: 0, y: -0.056 * PT }, fit: true },
  number: { x: 0.661 * PT, y: 0.005 * PT, width: LABEL.height - 0.01 * PT, height: 0.07 * PT, fontSize: 4.5, rotation: 90, offset: { x: -0.75, y: -5 }, fit: true },
};
const MATRIX_BOX = { x: 0.476 * PT, y: 0.005 * PT, width: 0.11 * PT, height: LABEL.height - 0.01 * PT };

/**
 * The reference's shrink-to-fit, with one repair: a single line shrinks
 * until it fits the width, a wrapping one until it fits the height, never
 * below 1pt, nudging the offset so the text stays inside the box. The
 * reference guessed the line count from the text's total width, which
 * undercounts — greedy wrapping at spaces wastes the tail of each line, so
 * four collectors' names modelled as two lines were drawn as three and ran
 * out of the box (CodeRabbit, #75). The count here is pdf-lib's own
 * breakTextIntoLines, the function drawText wraps with, so what is measured
 * is what is drawn.
 */
export function fitText(
  font: PDFFont,
  text: string,
  box: Pick<TextBox, "width" | "height" | "fontSize">,
): { fontSize: number; lines: number; lineHeight: number } {
  const measure = (size: number) => {
    const lines = breakTextIntoLines(text, [" "], box.width, (t) => font.widthOfTextAtSize(t, size));
    const widest = Math.max(0, ...lines.map((l) => font.widthOfTextAtSize(l.trimEnd(), size)));
    return { size, lines: lines.length, widest, lineHeight: font.heightAtSize(size, { descender: true }) };
  };
  const fits = (m: ReturnType<typeof measure>) =>
    m.widest <= box.width && (m.lines === 1 || m.lines * m.lineHeight <= box.height);
  // Sizes are hundredths of a point, searched by bisection rather than
  // stepped down 0.01 at a time: the largest size that fits, never below
  // 1pt. A line can still be too wide when one word is — no space to break at.
  let best = measure(box.fontSize);
  if (!fits(best)) {
    let low = 100;
    let high = Math.round(box.fontSize * 100) - 1;
    best = measure(1);
    while (low <= high) {
      const mid = (low + high) >> 1;
      const m = measure(mid / 100);
      if (fits(m)) {
        best = m;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
  }
  return { fontSize: best.size, lines: best.lines, lineHeight: best.lineHeight };
}

/**
 * Fits are remembered for the length of one render: a sheet repeats the same
 * location, coordinates and collector down a column of labels, and measuring
 * each afresh was most of seven seconds on a 5,411-label run.
 */
type FitCache = Map<string, ReturnType<typeof fitText>>;

function drawTextBox(
  page: PDFPage,
  font: PDFFont,
  text: string,
  originX: number,
  originY: number,
  box: TextBox,
  fitCache: FitCache,
): void {
  let fontSize = box.fontSize;
  let xOffset = box.offset.x;
  let yOffset = box.offset.y;
  if (box.fit && text.length > 0) {
    const key = `${box.width}|${box.height}|${box.fontSize}|${text}`;
    let fitted = fitCache.get(key);
    if (fitted === undefined) {
      fitted = fitText(font, text, box);
      fitCache.set(key, fitted);
    }
    if (fitted.fontSize !== box.fontSize) {
      fontSize = fitted.fontSize;
      const textHeight = fitted.lines * fitted.lineHeight;
      if (box.rotation === 0) yOffset = (box.height - textHeight) * -0.5 - fitted.lineHeight * 0.8;
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

/**
 * The DataMatrix as filled rectangles, one per run of dark modules in a row,
 * under a single fill. It was a 1-bit image first, 18 bytes a label, and it
 * came out blurry: PDF viewers and print drivers smooth a tiny bitmap when
 * they scale it up, whatever the image's Interpolate flag says (seen on the
 * first sheets anyone looked at, 2026-09-18). Vector modules are sharp at
 * any zoom and on any printer. Runs rather than single modules keep it to
 * about forty rectangles a symbol, and the content stream is compressed, so
 * a 5,000-label run stays small. Each rectangle is a hair larger than its
 * modules so neighbouring rows leave no seam for an anti-aliaser to find.
 */
function drawDataMatrix(page: PDFPage, text: string, originX: number, originY: number): void {
  const grid = dataMatrixModules(text);
  const scale = Math.min(MATRIX_BOX.width / grid.width, MATRIX_BOX.height / grid.height);
  const left = originX + MATRIX_BOX.x;
  const bottom = originY + MATRIX_BOX.y;
  const bleed = 0.01;
  const ops = [pushGraphicsState(), setFillingGrayscaleColor(0)];
  for (let row = 0; row < grid.height; row++) {
    const cells = grid.dark[row]!;
    for (let x = 0; x < grid.width; x++) {
      if (!cells[x]) continue;
      let run = 1;
      while (x + run < grid.width && cells[x + run]) run += 1;
      // Rows run top to bottom in the grid and PDF's y runs upward.
      ops.push(
        rectangle(
          left + x * scale - bleed,
          bottom + (grid.height - 1 - row) * scale - bleed,
          run * scale + 2 * bleed,
          scale + 2 * bleed,
        ),
      );
      x += run - 1;
    }
  }
  ops.push(fill(), popGraphicsState());
  page.pushOperators(...ops);
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

  const fitCache: FitCache = new Map();
  for (const row of rows) {
    if (row.cell < 0 || row.cell >= LABELS_PER_SHEET) throw new Error(`cell ${row.cell} is off the sheet`);
    const page = pages[row.sheet - 1];
    if (!page) throw new Error(`sheet ${row.sheet} has no page`);
    const { x, y } = cellOrigin(row.cell);
    drawTextBox(page, font, row.location_text, x, y, LABEL_BOXES.location, fitCache);
    drawTextBox(page, font, row.coordinates_text, x, y, LABEL_BOXES.coordinates, fitCache);
    drawTextBox(page, font, row.date_text, x, y, LABEL_BOXES.date, fitCache);
    drawTextBox(page, font, row.collector_text, x, y, LABEL_BOXES.collector, fitCache);
    drawTextBox(page, font, row.method_text, x, y, LABEL_BOXES.method, fitCache);
    drawTextBox(page, font, row.number_text, x, y, LABEL_BOXES.number, fitCache);
    drawDataMatrix(page, row.number_text, x, y);
  }
  return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
