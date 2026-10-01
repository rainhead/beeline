/**
 * Finding specimens by the numbers on their labels (beeline-bcq).
 *
 * A volunteer with a box sorted by genus finds its specimens by typing,
 * pasting or scanning label numbers. The rules are about how people write
 * numbers, not about storage: a whole number; the last few digits of one,
 * when only one of theirs ends that way (412 for 26000412); a range, whose
 * start may itself be such a tail and whose end may be abbreviated
 * (26019685-697, or 9685-697). The candidates are every specimen the person
 * can reach, in every season, so a box can mix years — which is also why
 * numbers of different lengths coexist: before 2025 field numbers had seven
 * digits.
 *
 * Problems come back as codes with their facts, never as sentences: the
 * message catalog says them.
 */

export interface NumberedSpecimen {
  id: number;
  fieldNumber: string | null;
}

/** The lowest and highest of their numbers with this many digits. */
export interface NumberSpan {
  digits: number;
  first: string;
  last: string;
}

export type NumberProblem =
  | { code: "notNumber" }
  /** Several numbers end in what was typed. */
  | { code: "ambiguous"; typed: string; count: number; examples: string[] }
  /** No number of theirs has this many digits. */
  | { code: "digits"; typed: string; spans: NumberSpan[] }
  | { code: "notTheirs"; typed: string; spans: NumberSpan[] }
  | { code: "rangeStart"; problem: NumberProblem }
  | { code: "backwards" }
  | { code: "tooLong"; max: number }
  | { code: "lengthsDiffer"; start: string; end: string }
  /** `digits` is how many the range's numbers have, so a dropped digit can be named. */
  | { code: "emptyRange"; digits: number; spans: NumberSpan[] }
  | { code: "noSpecimens" };

export interface NumberEntry {
  /** What was asked for, written out whole: 26019685–26019697. */
  text: string;
  ids: number[];
  problem: NumberProblem | null;
}

/** The most numbers one range may name: past this it is a typo, not a box. */
export const MAX_RANGE = 2000;

const isDigits = (s: string | null): s is string => s !== null && /^\d+$/.test(s);

/** Split what was typed or pasted into entries: commas, spaces, semicolons and line breaks separate; dashes join. */
export function numberTokens(raw: string): string[] {
  return raw
    .replace(/\s*[-–—]\s*/g, "-")
    .split(/[\s,;]+/)
    .filter(Boolean);
}

/** A column copied from a spreadsheet, as one line a text field can hold. */
export const pastedList = (text: string): string =>
  text
    .split(/[\r\n\t]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .join(", ");

export class NumberIndex {
  readonly #exact = new Map<string, NumberedSpecimen>();
  readonly #numbered: { spec: NumberedSpecimen; digits: string; value: bigint }[];
  readonly #lengths: number[];
  readonly #spans: NumberSpan[];

  constructor(specimens: readonly NumberedSpecimen[]) {
    for (const s of specimens) if (s.fieldNumber !== null) this.#exact.set(s.fieldNumber, s);
    this.#numbered = specimens
      .filter((s): s is NumberedSpecimen & { fieldNumber: string } => isDigits(s.fieldNumber))
      .map((s) => ({ spec: s, digits: s.fieldNumber, value: BigInt(s.fieldNumber) }))
      .sort((a, b) => a.digits.length - b.digits.length || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    this.#lengths = [...new Set(this.#numbered.map((n) => n.digits.length))].sort((a, b) => a - b);
    this.#spans = this.#lengths.map((digits) => {
      const of = this.#numbered.filter((n) => n.digits.length === digits);
      return { digits, first: of[0]!.digits, last: of[of.length - 1]!.digits };
    });
  }

  /** One number: written whole, or the last few digits of exactly one of theirs. */
  single(typed: string): { spec: NumberedSpecimen } | { problem: NumberProblem } {
    if (this.#numbered.length === 0 && this.#exact.size === 0) return { problem: { code: "noSpecimens" } };
    const exact = this.#exact.get(typed);
    if (exact) return { spec: exact };
    if (!/^\d+$/.test(typed)) return { problem: { code: "notNumber" } };
    const tail = typed.length >= 3 ? this.#numbered.filter((n) => n.digits.length > typed.length && n.digits.endsWith(typed)) : [];
    if (tail.length === 1) return { spec: tail[0]!.spec };
    if (tail.length > 1) {
      return { problem: { code: "ambiguous", typed, count: tail.length, examples: tail.slice(0, 3).map((n) => n.digits) } };
    }
    if (!this.#lengths.includes(typed.length) && typed.length > 3) {
      return { problem: { code: "digits", typed, spans: this.#spans } };
    }
    return { problem: { code: "notTheirs", typed, spans: this.#spans } };
  }

  /** One token: a number, a tail, or a range. */
  resolve(token: string): NumberEntry {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (!range) {
      const one = this.single(token);
      return "spec" in one
        ? { text: one.spec.fieldNumber ?? token, ids: [one.spec.id], problem: null }
        : { text: token, ids: [], problem: one.problem };
    }
    const typedStart = range[1]!;
    const rawEnd = range[2]!;
    // A start of a length their numbers have is taken as written: a range
    // may begin in a gap. Anything shorter has to be the tail of one number.
    let start = typedStart;
    if (!this.#lengths.includes(typedStart.length)) {
      const first = this.single(typedStart);
      if ("problem" in first) return { text: `${typedStart}–${rawEnd}`, ids: [], problem: { code: "rangeStart", problem: first.problem } };
      start = first.spec.fieldNumber!;
    }
    const end = rawEnd.length < start.length ? start.slice(0, start.length - rawEnd.length) + rawEnd : rawEnd;
    const text = `${start}–${end}`;
    if (end.length !== start.length) return { text, ids: [], problem: { code: "lengthsDiffer", start, end } };
    const from = BigInt(start);
    const to = BigInt(end);
    if (to < from) return { text, ids: [], problem: { code: "backwards" } };
    if (to - from >= BigInt(MAX_RANGE)) return { text, ids: [], problem: { code: "tooLong", max: MAX_RANGE } };
    const ids = this.#numbered
      .filter((n) => n.digits.length === start.length && n.value >= from && n.value <= to)
      .map((n) => n.spec.id);
    return { text, ids, problem: ids.length === 0 ? { code: "emptyRange", digits: start.length, spans: this.#spans } : null };
  }

  /** Everything typed or pasted at once, entry by entry. */
  resolveAll(raw: string): NumberEntry[] {
    return numberTokens(raw).map((t) => this.resolve(t));
  }
}
