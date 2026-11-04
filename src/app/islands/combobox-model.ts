/**
 * What a combobox does, apart from drawing it (beeline-wn2): which options a
 * query shows, and what each key does to the open list. No DOM and no Lit,
 * so the rules are tested directly (test/combobox-model.test.ts) and the
 * element (combobox.ts) only draws the state these functions return.
 */

/** One choice. `value` is what fills the text box and is submitted; `label` is shown instead where given; `note` sits beside it in secondary text. */
export interface ComboboxOption<T = unknown> {
  value: string;
  label?: string;
  note?: string;
  /** Whatever the caller needs back from a pick: a taxon, an id. */
  data?: T;
}

/** Lower case, brackets and full stops as spaces, split on whitespace. */
const words = (s: string) => s.toLowerCase().replace(/[().]/g, " ").split(/\s+/).filter(Boolean);

/**
 * Whether every word typed starts a word of `text`, in order: `bom vos` and
 * `b vos` both find Bombus vosnesenskii, `fin` finds Finley NWR. A query of
 * no words matches nothing; whether to show everything then is the
 * caller's choice.
 */
export function matchesWords(query: string, text: string): boolean {
  const q = words(query);
  if (q.length === 0) return false;
  let i = 0;
  for (const w of words(text)) if (i < q.length && w.startsWith(q[i]!)) i++;
  return i === q.length;
}

/**
 * The options a fixed list shows for what is in the box. All of them when
 * the box is empty or holds one of them exactly, which is what someone
 * opening the list to change a value wants to see; otherwise those whose
 * value or label the query matches.
 */
export function filterOptions<T>(options: readonly ComboboxOption<T>[], query: string): ComboboxOption<T>[] {
  const q = query.trim();
  if (q === "" || options.some((o) => o.value === q)) return [...options];
  return options.filter((o) => matchesWords(q, o.value) || (o.label !== undefined && matchesWords(q, o.label)));
}

/** The list's state as the keys see it. */
export interface KeyState {
  open: boolean;
  /** The highlighted option, or -1 for none. */
  active: number;
  /** How many options the list shows now. */
  count: number;
  /** Whether text that is no option may stand: false on a picker, which must yield one of its options. */
  free: boolean;
}

/**
 * What a key does. `open` and `active` are the new state; `pick` means the
 * active option is taken; `revert` puts back the value the box had when it
 * was focused; `cancel` tells the page the person backed out; `prevent`
 * means the browser must not do its own thing with the key (Enter
 * submitting the form while a choice is being made, arrows moving the
 * caret). Keys not listed return the state unchanged and are left to the
 * browser.
 */
export interface KeyResult {
  open: boolean;
  active: number;
  pick: boolean;
  revert: boolean;
  cancel: boolean;
  prevent: boolean;
}

export function keyAction(state: KeyState, key: string, alt = false): KeyResult {
  const same = { open: state.open, active: state.active, pick: false, revert: false, cancel: false, prevent: false };
  switch (key) {
    case "ArrowDown":
      // Alt+Down only opens, as a <select> does; Down opens on the first
      // option, or moves down, stopping at the last.
      if (!state.open) return { ...same, open: true, active: alt ? state.active : Math.max(state.active, 0), prevent: true };
      if (alt) return { ...same, prevent: true };
      return { ...same, active: Math.min(state.active + 1, state.count - 1), prevent: true };
    case "ArrowUp":
      if (!state.open) return { ...same, open: true, prevent: true };
      if (alt) return { ...same, open: false, prevent: true };
      return { ...same, active: Math.max(state.active - 1, 0), prevent: true };
    case "Enter":
      if (state.open && state.active >= 0 && state.active < state.count) {
        return { ...same, open: false, pick: true, prevent: true };
      }
      // Nothing highlighted: free text submits the form as typed; a picker
      // has nothing to submit.
      return { ...same, open: false, prevent: !state.free };
    case "Escape":
      // The first Escape closes the list; with it closed, the box goes back
      // to what it held. Either way the page hears that the person backed out.
      if (state.open) return { ...same, open: false, active: -1, cancel: true, prevent: true };
      return { ...same, revert: true, cancel: true, prevent: true };
    case "Tab":
      // Moving on never picks: a highlighted option is not a choice.
      return { ...same, open: false };
    default:
      return same;
  }
}
