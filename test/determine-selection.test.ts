import { describe, expect, it } from "vitest";
import { deselect, emptySelection, markUnused, markUsed, selectMore } from "../src/app/islands/determine/selection.js";

const ids = (s: { ids: ReadonlySet<number> }) => [...s.ids].sort((a, b) => a - b);

describe("the selection on Identify your specimens", () => {
  it("grows as rows are selected, until it is named", () => {
    const s = selectMore(selectMore(emptySelection, [1]), [2, 3]);
    expect(ids(s)).toEqual([1, 2, 3]);
  });

  it("starts over at the next row selected once it has been named (GitHub #316)", () => {
    const named = markUsed(selectMore(emptySelection, [1, 2]));
    const next = selectMore(named, [3]);
    expect(ids(next)).toEqual([3]);
    // The new selection has not been named, so it grows again.
    expect(ids(selectMore(next, [4]))).toEqual([3, 4]);
  });

  it("stays one selection while rows are only taken out of it", () => {
    const named = markUsed(selectMore(emptySelection, [1, 2, 3]));
    const narrowed = deselect(named, [1]);
    expect(ids(narrowed)).toEqual([2, 3]);
    expect(narrowed.used).toBe(true);
  });

  it("can be added to again after the naming is undone", () => {
    const undone = markUnused(markUsed(selectMore(emptySelection, [1, 2])));
    expect(ids(selectMore(undone, [3]))).toEqual([1, 2, 3]);
  });

  it("is not used when nothing was selected or nothing is left", () => {
    expect(markUsed(emptySelection).used).toBe(false);
    expect(deselect(markUsed(selectMore(emptySelection, [1])), [1]).used).toBe(false);
  });
});
