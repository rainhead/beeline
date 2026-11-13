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
}

export const emptySelection: Selection = { ids: new Set(), used: false };

/** Select more rows: into the selection as it stands, or as a new one if that one has been used. */
export function selectMore(selection: Selection, ids: Iterable<number>): Selection {
  return { ids: new Set(selection.used ? ids : [...selection.ids, ...ids]), used: false };
}

/** Take rows out of the selection, which stays the selection it was. */
export function deselect(selection: Selection, ids: Iterable<number>): Selection {
  const next = new Set(selection.ids);
  for (const id of ids) next.delete(id);
  return { ids: next, used: selection.used && next.size > 0 };
}

/** The selection after a name or a sex was given to all of it. */
export const markUsed = (selection: Selection): Selection => ({ ids: selection.ids, used: selection.ids.size > 0 });

/** The selection after that was undone: the rows are as they were, so it can be added to again. */
export const markUnused = (selection: Selection): Selection => ({ ids: selection.ids, used: false });
