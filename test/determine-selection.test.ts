import { describe, expect, it } from "vitest";
import { deselect, emptySelection, holdsWork, markUsed, selectMore, startsNew, undoUse } from "../src/app/islands/determine/selection.js";

const ids = (s: { ids: ReadonlySet<number> }) => [...s.ids].sort((a, b) => a - b);

describe("the selection on Identify your specimens", () => {
  it("holds work worth asking about before another year opens only while it is ticked and not yet named (beeline-mjml)", () => {
    expect(holdsWork(emptySelection)).toBe(false);
    const ticked = selectMore(emptySelection, [1, 2]);
    expect(holdsWork(ticked)).toBe(true);
    // Named rows stay ticked, but the next row found starts afresh, so nothing is lost by moving.
    expect(holdsWork(markUsed(ticked))).toBe(false);
  });

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

  it("can be added to again after its only naming is undone", () => {
    const before = selectMore(emptySelection, [1, 2]);
    const undone = undoUse(markUsed(before), before);
    expect(ids(selectMore(undone, [3]))).toEqual([1, 2, 3]);
  });

  it("is still finished with when a later change is undone and an earlier name stands", () => {
    const named = markUsed(selectMore(emptySelection, [1, 2]));
    const sexedThenUndone = undoUse(markUsed(named), named);
    expect(ids(selectMore(sexedThenUndone, [3]))).toEqual([3]);
  });

  it("is left alone by an undo if it was begun or narrowed since the naming", () => {
    const before = selectMore(emptySelection, [1, 2]);
    const named = markUsed(before);
    const begun = selectMore(named, [3]);
    expect(undoUse(begun, before)).toBe(begun);
    const narrowed = deselect(named, [1]);
    expect(undoUse(narrowed, before).used).toBe(true);
  });

  it("never hands a new selection the old one's anchor, so no block runs back into the named rows", () => {
    const named = markUsed(selectMore(emptySelection, [1, 2, 3], 1));
    expect(named.anchor).toBe(1);
    // A whole sample ticked at once: no row was clicked, so there is no anchor.
    expect(selectMore(named, [5, 6]).anchor).toBeNull();
    // Gone to by field number: that row is where a block now runs from.
    expect(selectMore(named, [8], 8).anchor).toBe(8);
    // And a Shift-click on a row outside the named selection may not run a block at all.
    expect(startsNew(named, 6)).toBe(true);
    expect(startsNew(named, 2)).toBe(false);
    expect(startsNew(selectMore(named, [8], 8), 10)).toBe(false);
  });

  it("keeps its anchor while it is added to or narrowed without a click on a row", () => {
    const s = selectMore(emptySelection, [1], 1);
    expect(selectMore(s, [5, 6]).anchor).toBe(1);
    expect(deselect(s, [1]).anchor).toBe(1);
  });

  it("leaves no anchor when a named selection is unticked down to nothing", () => {
    const named = markUsed(selectMore(emptySelection, [1], 1));
    // The untick is a click on row 1, which would otherwise become the anchor.
    const emptied = deselect(named, [1], 1);
    expect(emptied.anchor).toBeNull();
    expect(emptied.used).toBe(false);
    // Unticking the only row of a selection nothing was done to is an ordinary click.
    expect(deselect(selectMore(emptySelection, [1], 1), [1], 1).anchor).toBe(1);
  });

  it("is not used when nothing was selected or nothing is left", () => {
    expect(markUsed(emptySelection).used).toBe(false);
    expect(deselect(markUsed(selectMore(emptySelection, [1])), [1]).used).toBe(false);
  });
});
