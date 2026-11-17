/**
 * An area's name as a page shows it (beeline-9jd4). `area.name` is the name
 * as the source writes it (schema/038), and two sources write in capitals:
 * the Fish and Wildlife Service's refuges (ANKENY NATIONAL WILDLIFE REFUGE)
 * and BC's parks (E.C. MANNING PARK). A name with no small letter in it is
 * shown in title case; any other is shown as written.
 */
export function areaDisplayName(name: string): string {
  if (name !== name.toUpperCase() || name === name.toLowerCase()) return name;
  return name
    .toLowerCase()
    .replace(/(^|[\s\-(./])([a-z])/g, (_m, before: string, letter: string) => before + letter.toUpperCase())
    .replace(/\bMc([a-z])/g, (_m, letter: string) => `Mc${letter.toUpperCase()}`)
    .replace(/ (Del|De|La|Of|And|The) /g, (word) => word.toLowerCase());
}
