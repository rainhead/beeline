/**
 * Whether a sample was caught with a trap (pan, vane, bottle or malaise trap,
 * trap nest), which is the `is_trap` of the sample's method in the list in
 * `method` (beeline-ni5m.15, stage two). A sample with no method is not near
 * a trap. Every reader of this question, apart from the legacy export below,
 * asks the method: the listings, the downloads and archives, the record page,
 * the determine and "your bees" pages, and the associations file of the upload
 * to Ecdysis. The sample's kind does not answer it: promotion set the kind
 * from the old records' end dates and methods together
 * (src/old-sample-kind.ts), so a netting trip over several days is a "trap"
 * sample and a trap emptied on the day it was set can be a "net" one.
 *
 * A trap catches bees without saying which flower any of them visited, so
 * the plant its observation names is a plant near the trap, never a floral
 * host, and nothing says "visits flowers of" for it (Peter, 2026-11-16,
 * beeline-vjqy).
 *
 * As SQL, true or false, for the sample whose id is the column or expression
 * `sampleId`. Where a query already joins `method`, read `coalesce(is_trap, false)`
 * from the join instead.
 */
export const nearTrapSql = (sampleId: string) =>
  `coalesce((SELECT md.is_trap FROM sample_method sm JOIN method md ON md.code = sm.method_code WHERE sm.sample_id = ${sampleId}), false)`;

/**
 * Whether a method text names a trap, for the legacy-format export alone
 * (src/legacy-export.ts): that file is compared with old Beeline's nightly,
 * which decided from each old row's own text, so it must keep doing so and
 * not follow the method. As SQL over the column or expression `method`.
 */
export const methodNamesTrapSql = (method: string) => `regexp_matches(lower(coalesce(${method}, '')), 'trap')`;

/** How Darwin Core's associatedTaxa and relationshipOfResource relate a sample's plant to its bees. */
export const plantRelationship = (nearTrap: boolean): "near" | "visits flowers of" =>
  nearTrap ? "near" : "visits flowers of";
