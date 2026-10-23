// PROTOTYPE (beeline-7i6) — throwaway. Inlines the three JSON files into the
// page, twice: a local copy with everything, and a copy to share with
// reviewers outside the program, with the coordinates rounded to what a label
// prints and street addresses withheld from the present localities.
import { readFileSync, writeFileSync } from "node:fs";
const [page, out] = process.argv.slice(2);
const read = (f) => JSON.parse(readFileSync(`${out}/${f}.json`, "utf8"));
const places = read("places"), regions = read("regions"), samples = read("samples");
const STREET = / (road|rd|street|str|st|avenue|ave|av|drive|dr|boulevard|blvd|court|ct|lane|ln|county)( +((ne|nw|se|sw|n|s|e|w)|[^ ]*[0-9][^ ]*))* *(,|$)/;
const addressy = (loc) => !!loc && (/^\s*\d/.test(loc) || /\d{5}/.test(loc) || /(^|[\s,])\d{3,6}\s+[A-Za-z]/.test(loc)
  || STREET.test(` ${loc.toLowerCase().replaceAll(".", " ").replaceAll(",", " , ")} `));
const shared = samples.map((s) => ({
  ...s, lat: Math.round(s.lat * 1000) / 1000, lon: Math.round(s.lon * 1000) / 1000,
  loc: addressy(s.loc) ? "(street address withheld)" : s.loc,
}));
const template = readFileSync(page, "utf8");
const render = (rows, privacy) => template
  .replace("/*PRIVACY*/", () => privacy)
  .replace("/*DATA*/null", () => JSON.stringify({ places, regions, samples: rows }).replaceAll("</", "<\\/"));
const head = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n';
writeFileSync(`${out}/PROTOTYPE-coordinate-locality.html`,
  head + render(samples, "This copy holds exact coordinates: keep it local.") + "\n</html>\n");
writeFileSync(`${out}/coordinate-locality-prototype.html`,
  render(shared, `Coordinates are rounded to three decimals, as a label prints them, and ${shared.filter((s, i) => s.loc !== samples[i].loc).length.toLocaleString("en")} present localities that read as street addresses are withheld.`));
