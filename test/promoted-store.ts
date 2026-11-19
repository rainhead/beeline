import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { readFile, rename, rm } from "node:fs/promises";
import { createMemoryDb } from "../src/build-db.js";
import { ensureCorrectionsFile } from "../src/corrections.js";
import { loadLegacyStaging } from "../src/load-legacy.js";
import { promoteLegacy, type PromotionInputs } from "../src/promote-legacy.js";
import { FIXTURE_INPUTS } from "./helpers.js";
import { openCopy, templateFile, writeCopy } from "./store-template.js";

/**
 * A store promoted from a legacy fixture, for the tests that only need one to
 * stand on (beeline-vwn4). Production no longer promotes (ADR 0006), but many
 * tests want a store shaped like the one promotion left, and promoting takes
 * about 5 s on Hostess and twice that on CI however small the fixture: the
 * cost is in creating 84 tables, 124 views and 19 macros, not in the six
 * records. Paid by every test of a 45-test file, it made the whole run as long
 * as that one file.
 *
 * So each kind of promoted store is built once per run and written to a file
 * in the run's own folder (test/global-setup.ts), and every test gets its own
 * in-memory copy of it, which takes about 0.2 s. A copy is complete: the
 * promotion SQL reads every input file into a table rather than into a view
 * that would read the file again later, and sets no session state, so the
 * file holds everything a test can see. `test/promoted-store.test.ts` holds
 * the copy to the store it was made from.
 *
 * Tests that are about promotion itself, or that need staging or inputs other
 * than these, still promote for themselves.
 */
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

export const PROMOTED_STORES = {
  /** test/fixtures/legacy-occurrences.jsonl, through FIXTURE_INPUTS. */
  occurrences: { staging: fixture("legacy-occurrences.jsonl"), inputs: FIXTURE_INPUTS },
  /** The same records, with the git-side corrections in test/fixtures/legacy-corrections.csv. */
  corrected: {
    staging: fixture("legacy-occurrences.jsonl"),
    inputs: { ...FIXTURE_INPUTS, legacyCorrections: fixture("legacy-corrections.csv") },
  },
  /** test/fixtures/legacy-skipped.jsonl: the records promotion holds back. */
  skipped: { staging: fixture("legacy-skipped.jsonl"), inputs: FIXTURE_INPUTS },
} satisfies Record<string, { staging: string; inputs: PromotionInputs }>;

export type PromotedStore = keyof typeof PROMOTED_STORES;

/**
 * A fresh in-memory store, as `kind` stood straight after promotion: the same
 * as createMemoryDb, loadLegacyStaging and promoteLegacy with those inputs,
 * without paying for the promotion.
 *
 * Pass `appCorrections` where the test promoted with its own corrections file
 * and reads that file afterwards: promotion created it with its header, and
 * this does the same. That file must hold no corrections yet, since the store
 * was promoted without any; one that holds some needs a real promotion.
 */
export async function promotedStore(
  kind: PromotedStore,
  { appCorrections }: { appCorrections?: string } = {},
): Promise<{ instance: DuckDBInstance; conn: DuckDBConnection }> {
  if (appCorrections !== undefined) {
    await ensureCorrectionsFile(appCorrections);
    const lines = (await readFile(appCorrections, "utf8")).split("\n").filter((l) => l !== "");
    if (lines.length > 1) {
      throw new Error(`${appCorrections} already holds corrections; promote with it rather than copying a store promoted without`);
    }
  }
  return openCopy(await templateFile(kind, (path) => buildTemplate(kind, path)));
}

export { copyDatabase, openCopy, writeCopy } from "./store-template.js";

async function buildTemplate(kind: PromotedStore, path: string): Promise<void> {
  const { staging, inputs } = PROMOTED_STORES[kind];
  const { instance, conn } = await createMemoryDb();
  const partial = `${path}.${process.pid}.partial`;
  try {
    await loadLegacyStaging(conn, staging);
    await promoteLegacy(conn, inputs);
    await writeCopy(conn, partial);
    await rename(partial, path);
  } finally {
    conn.closeSync();
    instance.closeSync();
    await rm(partial, { force: true });
    await rm(`${partial}.wal`, { force: true });
  }
}
