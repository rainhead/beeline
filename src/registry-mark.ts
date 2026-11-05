import type { DuckDBConnection } from "@duckdb/node-api";
import { readFile, rename, writeFile } from "node:fs/promises";
import { countRegistry, type RegistryCounts, StoreRefused } from "./registry-guard.js";

/**
 * The deployment's own record of how many print runs and minted field
 * numbers its store has held (beeline-l3w7). It lives beside the store, in
 * `data/`, and outside it, which is the point: a store moved over the live
 * one (`mv -f data/beeline-new.duckdb data/beeline.duckdb`, the last step of
 * the runbook's swap) takes its own registry with it, and only something the
 * move does not replace can say that the new one has fewer.
 *
 * Neither count ever goes down in a healthy store. Cancelling a run keeps the
 * run and burns its numbers rather than deleting them (schema/035), and
 * nothing deletes a row from either table. So a store that holds fewer than
 * the mark has lost numbers that are on pins, and the next print run on it
 * would mint them again from the imported ceiling.
 *
 * The mark is not in the nightly backup, on purpose: it records what this
 * volume has seen, and a backup restored over a store that printed since is
 * exactly the loss it exists to catch. An operator who means to accept that
 * loss deletes the file, which the refusal says.
 */

export interface MarkCheck {
  /** What the store holds now. */
  store: RegistryCounts;
  /** The mark as it was before this boot, or null when there was none. */
  before: RegistryCounts | null;
}

/** The catalog the connection's unqualified tables are in: `memory` in tests, the file's name in the app. */
export async function currentCatalog(conn: DuckDBConnection): Promise<string> {
  const [[catalog]] = (await (await conn.run("SELECT current_database()")).getRows()) as [[string]];
  return catalog;
}

/** The mark at `path`, or null when there is none yet. A file that is there but unreadable throws. */
export async function readRegistryMark(path: string): Promise<RegistryCounts | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(text) as Partial<Record<keyof RegistryCounts, unknown>>;
  const count = (key: keyof RegistryCounts): number => {
    const v = parsed[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      throw new Error(`${path} is not a registry mark: ${key} is ${JSON.stringify(v)}`);
    }
    return v;
  };
  return { print_run: count("print_run"), minted_field_number: count("minted_field_number") };
}

const higher = (a: RegistryCounts, b: RegistryCounts | null): RegistryCounts =>
  b === null
    ? a
    : {
        print_run: Math.max(a.print_run, b.print_run),
        minted_field_number: Math.max(a.minted_field_number, b.minted_field_number),
      };

// Raises are serialised here rather than by the print-run lock: a raise reads
// the file and writes the higher of it and the store, and two interleaved
// raises could otherwise leave the lower count written last.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Raise the mark to what the store in `catalog` holds now, never lowering it.
 * Written to a temporary file and renamed over the mark, so a crash leaves
 * the old mark or the new one, never half of one.
 */
export function raiseRegistryMark(conn: DuckDBConnection, catalog: string, path: string): Promise<RegistryCounts> {
  const next = queue.then(async () => {
    const mark = higher(await countRegistry(conn, catalog), await readRegistryMark(path));
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(mark)}\n`);
    await rename(tmp, path);
    return mark;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** Thrown at boot by a store that holds fewer print runs or minted numbers than the mark. */
export class RegistryShrankRefused extends StoreRefused {
  constructor(
    readonly store: RegistryCounts,
    readonly mark: RegistryCounts,
    message: string,
  ) {
    super(message);
    this.name = "RegistryShrankRefused";
  }
}

/**
 * The boot's check: refuse a store that holds fewer print runs or minted
 * field numbers than the mark at `path`, and otherwise raise the mark to what
 * it holds. The first boot with no mark writes one.
 */
export async function checkRegistryMark(conn: DuckDBConnection, catalog: string, path: string): Promise<MarkCheck> {
  const store = await countRegistry(conn, catalog);
  const before = await readRegistryMark(path);
  if (before !== null && (store.print_run < before.print_run || store.minted_field_number < before.minted_field_number)) {
    throw new RegistryShrankRefused(
      store,
      before,
      `Refusing to serve this store: it holds ${store.print_run} print run(s) and ${store.minted_field_number} ` +
        `minted field number(s), and this deployment has held ${before.print_run} and ${before.minted_field_number} ` +
        `(${path}). A store that has lost minted numbers would issue them again on the next print run, and they ` +
        `are already on pins. Put back the store that held them. Only if losing them is understood and accepted ` +
        `(for example, restoring a backup after the live store was destroyed), delete ${path} and restart. ` +
        `See docs/runbooks/deploy-fly.md.`,
    );
  }
  await raiseRegistryMark(conn, catalog, path);
  return { store, before };
}
