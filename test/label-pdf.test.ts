import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import { breakTextIntoLines, PDFDocument } from "pdf-lib";
import {
  dataMatrixModules,
  fitText,
  FONT_PATH,
  LABEL_BOXES,
  renderLabelsPdf,
  sha256,
  type LabelRow,
} from "../src/label-pdf.js";
import { layoutSheets } from "../src/label-text.js";

const PREPARED = new Date("2026-09-21T16:00:00Z");

function label(collector: string, i: number): Omit<LabelRow, "sheet" | "cell"> {
  return {
    location_text: "USA:OR:BentonCo Corvallis",
    coordinates_text: "44.565 -123.262 72m",
    date_text: `14.VII2026-1.${i}`,
    collector_text: collector,
    method_text: "net",
    number_text: String(26000001 + i),
  };
}

/** 249 labels for one collector and 5 for another: the break lands on the sheet boundary. */
function twoSheets(): LabelRow[] {
  const plain = [
    ...Array.from({ length: 249 }, (_, i) => label("A. Ash", i)),
    ...Array.from({ length: 5 }, (_, i) => label("B. Birch", 249 + i)),
  ];
  return layoutSheets(plain, (l) => l.collector_text).map(({ label, sheet, cell }) => ({ ...label, sheet, cell }));
}

describe("rendering labels", () => {
  it("draws one page per sheet and renders byte-identically", async () => {
    const rows = twoSheets();
    const a = await renderLabelsPdf(rows, { preparedAt: PREPARED });
    const b = await renderLabelsPdf(rows, { preparedAt: PREPARED });
    expect(sha256(a)).toBe(sha256(b));
    const doc = await PDFDocument.load(a, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getCreationDate()?.toISOString()).toBe(PREPARED.toISOString());
    expect(doc.getProducer()).toBe("Beeline");
    // The DataMatrix is vector, never a bitmap: viewers and print drivers
    // smooth a tiny image when they scale it, and the first sheets anyone
    // looked at came out blurry for it.
    const images = doc.context
      .enumerateIndirectObjects()
      .filter(([, obj]) => obj.toString().includes("/Subtype /Image"));
    expect(images).toHaveLength(0);
    expect(a.length).toBeLessThan(400_000);
  });

  it("puts the second collector's first label at the top left of sheet two", async () => {
    const rows = twoSheets();
    const first = rows.find((r) => r.sheet === 2 && r.cell === 0);
    expect(first?.collector_text).toBe("B. Birch");
    expect(rows.filter((r) => r.sheet === 1)).toHaveLength(249);
  });

  it("refuses a cell off the sheet", async () => {
    const [row] = twoSheets();
    await expect(renderLabelsPdf([{ ...row!, cell: 250 }], { preparedAt: PREPARED })).rejects.toThrow(/off the sheet/);
  });
});

describe("the font the sheets are set in", () => {
  it("is copied into the runtime image, which names its directories one by one", async () => {
    // The Dockerfile's runtime stage copies src, schema, migrations and
    // ingest by name; assets/ is none of those, and a missing font fails the
    // PDF route on Fly while everything here passes.
    const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toMatch(/^COPY --chown=node:node assets \.\/assets$/m);
    expect(FONT_PATH.pathname).toContain("/assets/fonts/");
    const ignored = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
    expect(ignored).not.toMatch(/^assets\/?$/m);
  });
});

describe("shrinking a line to fit its box", () => {
  it("measures the lines drawText will actually draw, so four collectors stay inside the box", async () => {
    // The reference guessed the line count from the total width; greedy
    // wrapping needs more lines than that, and this reachable collector line
    // was modelled as two and drawn as three (CodeRabbit, #75).
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(await readFile(FONT_PATH));
    const text = "M. O'Loughlin & D. O'Loughlin & S. Sheehy & S. Malaby";
    const box = LABEL_BOXES.collector;
    const fitted = fitText(font, text, box);
    const drawn = breakTextIntoLines(text, [" "], box.width, (t) => font.widthOfTextAtSize(t, fitted.fontSize));
    expect(fitted.lines).toBe(drawn.length);
    expect(drawn.length * fitted.lineHeight).toBeLessThanOrEqual(box.height);
    expect(fitted.fontSize).toBeLessThan(box.fontSize);
    // A line that already fits is left at the size the label was drawn for.
    expect(fitText(font, "A. Ash", box).fontSize).toBe(box.fontSize);
  });
});

describe("the DataMatrix", () => {
  it("is DMRE 8×18 stood on end, finder pattern along the bottom and right", () => {
    const grid = dataMatrixModules("26072094");
    expect([grid.width, grid.height]).toEqual([8, 18]);
    // Upright, the solid L runs down the left and along the bottom; a
    // quarter turn anticlockwise puts it along the bottom and up the right.
    expect(grid.dark[17]!.every(Boolean)).toBe(true);
    expect(grid.dark.every((row) => row[7])).toBe(true);
    // And the clock track alternates along the top.
    expect(grid.dark[0]).toEqual([false, true, false, true, false, true, false, true]);
  });

  it("encodes the digits only, as the reference did, so a scanner reads a number", () => {
    // 'E2000001' and '2000001' encode the same symbol.
    expect(dataMatrixModules("E2000001")).toEqual(dataMatrixModules("2000001"));
    expect(dataMatrixModules("26072094")).not.toEqual(dataMatrixModules("26072095"));
  });
});
