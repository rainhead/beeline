import type { Messages } from "./messages/index.js";
import type { HostProblem } from "./host-override.js";
import type { LocalitySuggestion } from "./record.js";

/**
 * The reasons that two corrections write for themselves, built in one place so
 * that a correction made through a page and one made through the API store the
 * same words in the sample overlay and in the sample's history
 * (beeline-pnqr.6). Each takes the message catalogue: a page passes the one
 * for its reader, and the API passes `messagesFor(null)`, since a key has no
 * language of its own.
 */

/** The reason stored with a locality adopted from the names Beeline offers, from how the rule named it. */
export const localityReasonFor =
  (m: Messages) =>
  (basis: LocalitySuggestion["basis"]): string =>
    m.suggestedLocality.reason(m.suggestedLocality.basis[basis]);

/** The reason stored when staff take the observation's location and give no note. */
export const takeLocationDefaultReason = (m: Messages): string => m.record.sample.takeObservationLocation.reason;

/** The sentence for each way a trap count is refused, in the catalogue's words. */
export const trapCountProblemFor =
  (m: Messages) =>
  (problem: "count" | "net" | "method"): string =>
    m.record.sample.trapCount.problems[problem];

/** The sentence for each way a specimen count is refused, in the catalogue's words; `numbered` takes the highest place already numbered. */
export const specimenCountProblemFor =
  (m: Messages) =>
  (problem: "count" | "net" | "follows" | "numbered", number?: number): string => {
    const sentences = m.record.sample.specimenCount.problems;
    return problem === "numbered" ? sentences.numbered(number ?? 0) : sentences[problem];
  };

/** The sentence for each way a floral host is refused, in the catalogue's words; `inactive` takes the names iNaturalist gives in its place. */
export const hostProblemFor =
  (m: Messages) =>
  (problem: HostProblem, replacedBy: readonly string[] = []): string => {
    const sentences = m.record.sample.staffHost.problems;
    return problem === "inactive" ? sentences.inactive(replacedBy) : sentences[problem];
  };

/** The sentence for each way a method or the dates of a sample are refused, in the catalogue's words; an unlisted method names the methods that may be chosen. */
export const methodProblemFor =
  (m: Messages) =>
  (problem: keyof Messages["record"]["sample"]["methodEdit"]["problems"] | "unlisted_method", methods: readonly string[]): string =>
    problem === "unlisted_method" ? m.record.sample.methodEdit.unlistedMethod(methods.join(", ")) : m.record.sample.methodEdit.problems[problem];

/** The sentence for a method that is not on the list, naming the methods that are, in the catalogue's words. */
export const unlistedMethodFor =
  (m: Messages) =>
  (methods: readonly string[]): string =>
    m.record.sample.methodEdit.unlistedMethod(methods.join(", "));
