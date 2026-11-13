/**
 * Which rows are selected on Identify your specimens once more are selected.
 *
 * A selection that has been named, or had its sex set, is finished with: the
 * next row selected starts a new selection instead of joining it. Before
 * this, a volunteer named a group, selected a second group and named that,
 * and the first group took the second name too (GitHub #316), most easily by
 * way of "Go to field number", which selects the row it finds while the
 * earlier rows are scrolled out of sight. Taking rows out never starts over:
 * naming a box Bombus and then narrowing to the three that are a species is
 * still one selection.
 */
export interface Selection {
  ids: ReadonlySet<number>;
  /** A name or a sex has been given to these rows since the selection was last added to. */
  used: boolean;
  /**
   * The row a Shift-click's block runs from: the row last clicked or gone to
   * in this selection. It is part of the selection so that a new selection
   * never inherits the old one's: a block run from a row of the selection
   * already named would bring those rows back in.
   */
  anchor: number | null;
}

export const emptySelection: Selection = { ids: new Set(), used: false, anchor: null };

/**
 * Select more rows: into the selection as it stands, or as a new one if that
 * one has been used. `anchor` is the row clicked or gone to, if one was;
 * without it a new selection has none and a continuing one keeps its own.
 */
export function selectMore(selection: Selection, ids: Iterable<number>, anchor?: number): Selection {
  return {
    ids: new Set(selection.used ? ids : [...selection.ids, ...ids]),
    used: false,
    anchor: anchor ?? (selection.used ? null : selection.anchor),
  };
}

/** Whether selecting this row would start a new selection, so that no block may run to it from the old one. */
export const startsNew = (selection: Selection, id: number): boolean => selection.used && !selection.ids.has(id);

/**
 * Take rows out of the selection, which stays the selection it was. A named
 * selection unticked down to nothing leaves no anchor behind, or a Shift-click
 * would run a block back from the row just named.
 */
export function deselect(selection: Selection, ids: Iterable<number>, anchor?: number): Selection {
  const next = new Set(selection.ids);
  for (const id of ids) next.delete(id);
  const left = next.size > 0;
  return { ids: next, used: selection.used && left, anchor: selection.used && !left ? null : (anchor ?? selection.anchor) };
}

/**
 * The selection after a name or a sex was given to all of it from the bar, or
 * to one of its rows in the row's own cell: either way the person has moved
 * on from choosing rows to naming them.
 */
export const markUsed = (selection: Selection): Selection => ({ ...selection, used: selection.ids.size > 0 });

/**
 * The selection after a naming was undone. If it is still the selection that
 * was named, it goes back to how it stood before: added to freely if nothing
 * else had been done to it, finished with if an earlier name still stands.
 * A selection begun or narrowed since is left as it is.
 */
export const undoUse = (selection: Selection, before: Selection): Selection => (selection.ids === before.ids ? before : selection);
