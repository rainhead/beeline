/**
 * Why a field number someone typed found nothing, in the catalog's words
 * (beeline-bcq). Kept apart from the grid so it can be tested without a DOM.
 */
import { messagesFor } from "../../messages/index.js";
import type { NumberProblem } from "../../../determination-numbers.js";

const d = messagesFor(null).determine;

/** What a problem with a typed field number says, in the catalog's words. */
export function problemText(p: NumberProblem): string {
  const t = d.problem;
  switch (p.code) {
    case "notNumber":
      return t.notNumber;
    case "ambiguous":
      return t.ambiguous(p.typed, p.count, p.examples);
    case "digits": {
      const newest = p.spans[p.spans.length - 1];
      return newest !== undefined && newest.digits === p.typed.length + 1
        ? t.digitsShort(p.typed, newest.digits, newest.last)
        : t.digits(p.typed, t.spans(p.spans));
    }
    case "notTheirs":
      return t.notTheirs(p.typed, t.spans(p.spans));
    case "rangeStart":
      // Only a shared tail needs the range named: the other problems already say which number they are about.
      return p.problem.code === "ambiguous" ? t.rangeStart(problemText(p.problem)) : problemText(p.problem);
    case "backwards":
      return t.backwards;
    case "tooLong":
      return t.tooLong(p.max);
    case "lengthsDiffer":
      return t.lengthsDiffer(p.start, p.end);
    case "emptyRange": {
      // One digit short of their newest numbers is almost always a dropped digit: say that, not arithmetic.
      const newest = p.spans[p.spans.length - 1];
      return newest !== undefined && newest.digits === p.digits + 1
        ? t.digitMissing(newest.digits, newest.last)
        : t.emptyRange(t.spans(p.spans));
    }
    case "noSpecimens":
      return t.noSpecimens;
  }
}

