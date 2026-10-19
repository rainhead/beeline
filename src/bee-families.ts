/**
 * Bee families. Everything else in the tree is bycatch: offered only on
 * request when a volunteer names a specimen (src/app/determine.ts), and
 * loaded from Ecdysis under the nearest name the tree holds when its own name
 * is not there yet, where a bee's record waits for a taxonomist
 * (src/load-ecdysis.ts).
 */
export const BEE_FAMILIES: readonly string[] = ["Andrenidae", "Apidae", "Colletidae", "Halictidae", "Megachilidae", "Melittidae"];
