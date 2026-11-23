/**
 * Bee families. Everything else in the tree is bycatch: offered only on
 * request when a volunteer names a specimen (src/app/determine.ts), and
 * loaded from Ecdysis under the nearest name the tree holds when its own name
 * is not there yet, where a bee's record waits for a taxonomist
 * (src/load-ecdysis.ts).
 *
 * Stenotritidae (Australian) and Paleomelittidae (known only as fossils) are
 * here because Ecdysis files them under Apoidea with the rest, and the
 * picker's search of Ecdysis must not offer one as a non-bee (beeline-4wx3).
 * Nobody here collects either.
 */
export const BEE_FAMILIES: readonly string[] = [
  "Andrenidae",
  "Apidae",
  "Colletidae",
  "Halictidae",
  "Megachilidae",
  "Melittidae",
  "Paleomelittidae",
  "Stenotritidae",
];

/**
 * SQL that holds for a row of ecdysis_adoptable (schema/025), under `alias`,
 * that is not a bee: its family is not a bee family, and it is not a subfamily,
 * tribe, subtribe, genus or species Ecdysis files straight under Apoidea with
 * no family between, which could be a bee. What the picker's search, a draft's check and the
 * overnight commit all leave out, so the three cannot disagree.
 */
export const notABee = (alias: string): string =>
  `((${alias}.family IS NULL OR ${alias}.family NOT IN (${BEE_FAMILIES.map((f) => `'${f}'`).join(", ")}))` +
  ` AND NOT (${alias}.family IS NULL AND ${alias}.superfamily = 'Apoidea' AND ${alias}.rank IN ('subfamily', 'tribe', 'subtribe', 'genus', 'species')))`;
