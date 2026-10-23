// PROTOTYPE (beeline-7i6) — throwaway. Inlines the three JSON files into the page.
import { readFileSync, writeFileSync } from "node:fs";
const [page, out] = process.argv.slice(2);
const read = (f) => readFileSync(`${out}/${f}.json`, "utf8");
const data = `{"places":${read("places")},"regions":${read("regions")},"samples":${read("samples")}}`;
writeFileSync(`${out}/PROTOTYPE-coordinate-locality.html`,
  readFileSync(page, "utf8").replace("/*DATA*/null", () => data.replaceAll("</", "<\\/")));
