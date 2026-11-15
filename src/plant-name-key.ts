/**
 * A plant name reduced to what two spellings of it share: the rule of
 * plant_name_normal (schema/111), restated for a page that compares two names
 * it already holds and would otherwise read the whole view to do it. Case is
 * ignored, the hybrid sign (and its mangled form 'Ã—', the UTF-8 bytes of ×
 * read as Windows-1252) and var./ssp./subsp. are dropped, and any whitespace
 * becomes one space. test/plant-name-key.test.ts holds the two to the same
 * answers, so a change to one that is not made to the other fails there.
 *
 * Used where a host's name as observed is compared with what iNaturalist calls
 * it now: "Mentha piperita", as old Beeline's records write it, is not
 * renamed by iNaturalist's "Mentha × piperita" (beeline-rfkj.5).
 */
export function plantNameKey(name: string): string {
  return name
    .replace(/×|Ã—/g, " ")
    .toLowerCase()
    .replace(/(^|[ \t\n\v\f\r])(var|ssp|subsp)\./g, " ")
    .replace(/[ \t\n\v\f\r]+/g, " ")
    .replace(/^ +| +$/g, ""); // SQL trim() takes spaces only, where JavaScript trim() takes any whitespace
}
