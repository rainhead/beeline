import type { Messages } from "./messages/index.js";
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
