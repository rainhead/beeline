/**
 * Whether a sample's method names a trap: pan, vane or malaise trap, a trap
 * nest, "pantrap", "6 Vane Traps". The method, not the sample's kind, which
 * promotion sets from whether the old records gave an end date, so a netting
 * trip over several days is a "trap" sample and a trap emptied on the day it
 * was set is a "net" one (237 and 9 such on the backup of 16 November 2026).
 * The associations file of the upload to Ecdysis decides by this too
 * (beeline-lmlh; with the kind as well where the method says nothing of
 * netting), and the word on a label also comes from the method text
 * (`methodText`, src/label-text.ts).
 *
 * A trap catches bees without saying which flower any of them visited, so
 * the plant its observation names is a plant near the trap, never a floral
 * host, and nothing says "visits flowers of" for it (Peter, 2026-11-16,
 * beeline-vjqy). As SQL over the column or expression `method`.
 */
export const methodNamesTrapSql = (method: string) => `regexp_matches(lower(coalesce(${method}, '')), 'trap')`;

/** {@link methodNamesTrapSql}, for a method already read. */
export const methodNamesTrap = (method: string | null | undefined): boolean => /trap/i.test(method ?? "");

/** How Darwin Core's associatedTaxa and relationshipOfResource relate a sample's plant to its bees. */
export const plantRelationship = (method: string | null | undefined): "near" | "visits flowers of" =>
  methodNamesTrap(method) ? "near" : "visits flowers of";
