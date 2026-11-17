// The first step of making test/fixtures/openpyxl-resaved.xlsx: the file Beeline's own writer makes. See make-openpyxl-resaved.py.
//   node --import tsx test/fixtures/write-for-resave.mts <written.xlsx>
import { writeFileSync } from "node:fs";
import { writeXlsx } from "../../src/app/xlsx.js";

const header = ["specimenId", "locality", "eventDate", "decimalLongitude", "note"];
const rows = [
  ["1001", "Corvallis", "2026-07-14", "-123.45678901234567", "=1+1"],
  ["1002", "Corvallis", "2026-07-14", "-123.45678901234567", null],
];
writeFileSync(process.argv[2]!, writeXlsx({ sheetName: "specimens", header }, rows));
