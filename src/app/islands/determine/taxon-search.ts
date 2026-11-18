/**
 * What the name picker (./picker.ts) lists for what has been typed, apart
 * from any DOM so that the rules can be tested.
 */
import { matchesWords } from "../combobox-model.js";

export interface PickerTaxon {
  /**
   * The tree's entity id; for a name from Ecdysis the tree lacks, its Ecdysis
   * id made negative, which no entity id is. The page keys its names by this
   * (rowTaxa in src/app/determine.ts makes the same keys).
   */
  id: number;
  rank: string;
  name: string;
  family: string | null;
  order: string | null;
  bee: boolean;
  castes: boolean;
  /** Set on a name from Ecdysis the tree does not hold yet: the draft names it by this id. */
  ecdysisTid?: number;
}

/** A name from the server's search of Ecdysis (searchEcdysisNames). */
export interface EcdysisName {
  tid: number;
  rank: string;
  name: string;
  family: string | null;
  order: string | null;
}

/** Lower case, brackets and full stops as spaces, split on whitespace: the words matchesWords compares. */
const words = (s: string) => s.toLowerCase().replace(/[().]/g, " ").split(/\s+/).filter(Boolean);

/** A name from Ecdysis in the picker's shape. Never a bee (the server leaves bees out), so no castes. */
export const fromEcdysis = (e: EcdysisName): PickerTaxon => ({
  id: -e.tid,
  rank: e.rank,
  name: e.name,
  family: e.family,
  order: e.order,
  bee: false,
  castes: false,
  ecdysisTid: e.tid,
});

/**
 * Every word typed must start a word of the name, in order: `bom vos` finds
 * Bombus vosnesenskii, `b vos` too, and `melan` finds the subgenus Andrena
 * (Melandrena). They are listed in this order (beeline-u9u2):
 *
 * 1. the name typed exactly;
 * 2. names whose first word starts with the first word typed, before names
 *    that matched only on a later word, so that `dia` lists Diadasia before
 *    Lasioglossum (Dialictus);
 * 3. shorter names first, so a genus or family comes before the names under it;
 * 4. bees before bycatch;
 * 5. alphabetical.
 *
 * Until beeline-u9u2 the commonest names came first, which a volunteer found
 * hard to read: after Perdita came P. zonalis rather than the next name in
 * the alphabet, and the commoner Lasioglossum came before Diadasia.
 */
export function searchTaxa(taxa: readonly PickerTaxon[], query: string, bycatch: boolean, limit = 10): PickerTaxon[] {
  const q = words(query);
  if (q.length === 0) return [];
  const typed = q.join(" ");
  const found: { t: PickerTaxon; key: string; exact: boolean; first: boolean; length: number }[] = [];
  for (const t of taxa) {
    if (!bycatch && !t.bee) continue;
    if (!matchesWords(query, t.name)) continue;
    const w = words(t.name);
    const key = w.join(" ");
    found.push({ t, key, exact: key === typed, first: w[0]!.startsWith(q[0]!), length: w.length });
  }
  const before = (a: boolean, b: boolean) => Number(b) - Number(a);
  return found
    .sort(
      (a, b) =>
        before(a.exact, b.exact) ||
        before(a.first, b.first) ||
        a.length - b.length ||
        before(a.t.bee, b.t.bee) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .slice(0, limit)
    .map((o) => o.t);
}

/**
 * The tree's matches, then Ecdysis's for the same query once they have come
 * back, leaving out any name the tree's list already has. The tree's come
 * first and stay put, so the option Enter takes does not change under the
 * person's finger when Ecdysis answers.
 */
export function mergeNames(tree: readonly PickerTaxon[], ecdysis: readonly EcdysisName[], limit = 8): PickerTaxon[] {
  const held = new Set(tree.map((t) => t.name));
  return [...tree, ...ecdysis.filter((e) => !held.has(e.name)).slice(0, limit).map(fromEcdysis)];
}
