// PROTOTYPE (beeline-7i6) — throwaway. Inlines the three JSON files into the
// page, twice: a local copy with everything, and a copy to share with
// reviewers outside the program, with the coordinates rounded to what a label
// prints and street addresses withheld from the present localities.
import { readFileSync, writeFileSync } from "node:fs";
const [page, out] = process.argv.slice(2);
const read = (f) => JSON.parse(readFileSync(`${out}/${f}.json`, "utf8"));
const places = read("places"), features = read("features"), regions = read("regions"), samples = read("samples");
const STREET = / (road|rd|street|str|st|avenue|ave|av|drive|dr|boulevard|blvd|court|ct|lane|ln|county)( +((ne|nw|se|sw|n|s|e|w)|[^ ]*[0-9][^ ]*))* *(,|$)/;
// A named street, house number or not: 'Corvallis, NW Covey Run'.
const STREET_NAME = /\b(N|S|E|W|NE|NW|SE|SW)\s+\w+|\b[A-Z][a-z]+\.?\s+(Run|Way|Pl|Place|Ter|Terrace|Loop|Cir|Circle|Ct|Court|Dr|Drive|Ln|Lane|Ave|Avenue|Blvd|Boulevard|St|Street|Rd|Road)\b\.?\s*(,|$)/;
const addressy = (loc) => !!loc && (STREET_NAME.test(loc) ||/^\s*\d/.test(loc) || /\d{5}/.test(loc) || /(^|[\s,])\d{3,6}\s+[A-Za-z]/.test(loc)
  || STREET.test(` ${loc.toLowerCase().replaceAll(".", " ").replaceAll(",", " , ")} `));
// A collector's own extra samples, and every collector's name, stay local.
const shared = samples.filter((s) => !s.extra).map(({ who, ...s }) => ({
  ...s, lat: Math.round(s.lat * 1000) / 1000, lon: Math.round(s.lon * 1000) / 1000,
  loc: addressy(s.loc) ? "(street address withheld)" : s.loc,
}));
// Rows as arrays under one list of keys: the same data in two thirds the bytes.
const pack = (rows) => { const k = Object.keys(rows[0]); return { k, r: rows.map((o) => k.map((key) => o[key])) }; };
const template = readFileSync(page, "utf8");
const render = (rows, privacy, collectors) => template
  .replace("/*PRIVACY*/", () => privacy)
  .replace("${COLLECTORS}", collectors ? " or name" : "")
  .replace("/*DATA*/null", () => JSON.stringify({ places, features, regions, samples: pack(rows) }).replaceAll("</", "<\\/"));
const head = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n';
writeFileSync(`${out}/PROTOTYPE-coordinate-locality.html`,
  head + render(samples, "This copy holds exact coordinates and collectors' names: keep it local.", true) + "\n</html>\n");
writeFileSync(`${out}/coordinate-locality-prototype.html`,
  render(shared, `Coordinates are rounded to three decimals, as a label prints them, and ${shared.filter((s) => s.loc === "(street address withheld)").length.toLocaleString("en")} present localities that read as street addresses are withheld. Collectors appear only by their iNaturalist login, as on iNaturalist.`));
if (process.env.LIST_WITHHELD) {
  const w = new Map();
  for (const s of samples) if (!s.extra && addressy(s.loc)) w.set(s.loc, (w.get(s.loc) ?? 0) + 1);
  console.log(`${w.size} localities withheld, on ${[...w.values()].reduce((a, b) => a + b, 0)} samples:\n${[...w.keys()].join(" | ")}`);
}
