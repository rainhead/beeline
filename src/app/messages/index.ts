import { en, type Messages } from "./en.js";

export type { Messages };

/**
 * Locale → catalog. English is the only catalog until the fr-CA audience
 * question answers (beeline-1a7); the seam exists so adding one is a content
 * change (a sibling of en.ts typed as Messages), not an architecture change.
 * A person's locale preference will come from their session when it exists.
 */
export function messagesFor(_locale: string | null): Messages {
  return en;
}
