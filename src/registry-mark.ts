import type { DuckDBConnection } from "@duckdb/node-api";
import { open, readFile, rename } from "node:fs/promises";
import { countRegistry, StoreRefused } from "./registry-guard.js";

/**
 * The deployment's own record of how many print runs and minted field
 * numbers its store has held (beeline-l3w7). It lives beside the store, in
 * `data/`, and outside it, which is the point: a store moved over the live
 * one (`mv -f data/beeline-new.duckdb data/beeline.duckdb`, the last step of
 * the runbook's swap) takes its own registry with it, and only something the
 * move does not replace can say that the new one has fewer.
 *
 * The mark also keeps the highest field number minted, which is what the
 * next run counts on from (nextFieldNumber, src/print-run.ts): the counts
 * say a store has lost rows, and the highest number says so even for a
 * different store that happens to hold as many, such as a sandbox copy with
 * rehearsal runs in it.
 *
 * None of the three ever goes down in a healthy store. Cancelling a run keeps the
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

export interface RegistryMark {
  print_run: number;
  minted_field_number: number;
  /** The highest field number minted, as a number; 0 before the first. */
  highest_field_number: number;
}

export interface MarkCheck {
  /** What the store holds now. */
  store: RegistryMark;
  /** The mark as it was before this boot, or null when there was none. */
  before: RegistryMark | null;
}

/** The catalog the connection's unqualified tables are in: `memory` in tests, the file's name in the app. */
export async function currentCatalog(conn: DuckDBConnection): Promise<string> {
  const [[catalog]] = (await (await conn.run("SELECT current_database()")).getRows()) as [[string]];
  return catalog;
}

/** What the store in `catalog` holds, in the mark's terms. */
export async function storeRegistry(conn: DuckDBConnection, catalog: string): Promise<RegistryMark> {
  const counts = await countRegistry(conn, catalog);
  let highest = 0;
  if (counts.minted_field_number > 0) {
    const [[v]] = (await (
      await conn.run(
        `SELECT max(TRY_CAST(field_number AS BIGINT)) FROM "${catalog.replaceAll('"', '""')}".main.minted_field_number`,
      )
    ).getRows()) as [[bigint | number | null]];
    highest = Number(v ?? 0);
  }
  return { ...counts, highest_field_number: highest };
}

/** Thrown for a mark file that is there but cannot be read as one: refused, never taken for no mark. */
export class UnreadableMarkRefused extends StoreRefused {
  constructor(path: string, why: string) {
    super(
      `Refusing to serve this store: ${path} is not a registry mark Beeline can read (${why}). It records how many ` +
        `print runs and field numbers this deployment has held, so it cannot be skipped. Rewrite it from a store ` +
        `known to be the live one, or delete it only if that store is in place. See docs/runbooks/deploy-fly.md.`,
    );
    this.name = "UnreadableMarkRefused";
  }
}

/** The mark at `path`, or null when there is none yet. A file that is there but unreadable is refused. */
export async function readRegistryMark(path: string): Promise<RegistryMark | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UnreadableMarkRefused(path, (err as Error).message);
  }
  let parsed: Partial<Record<keyof RegistryMark, unknown>>;
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch (err) {
    throw new UnreadableMarkRefused(path, (err as Error).message);
  }
  if (parsed === null || typeof parsed !== "object") throw new UnreadableMarkRefused(path, "not an object");
  const count = (key: keyof RegistryMark): number => {
    const v = parsed[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      throw new UnreadableMarkRefused(path, `${key} is ${JSON.stringify(v)}`);
    }
    return v;
  };
  return {
    print_run: count("print_run"),
    minted_field_number: count("minted_field_number"),
    highest_field_number: count("highest_field_number"),
  };
}

const higher = (a: RegistryMark, b: RegistryMark | null): RegistryMark =>
  b === null
    ? a
    : {
        print_run: Math.max(a.print_run, b.print_run),
        minted_field_number: Math.max(a.minted_field_number, b.minted_field_number),
        highest_field_number: Math.max(a.highest_field_number, b.highest_field_number),
      };

// Raises are serialised here: a raise reads the file and writes the higher of
// it and the store, and two interleaved raises could otherwise leave the
// lower one written last.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Raise the mark to what the store in `catalog` holds now, never lowering it.
 * Written to a temporary file, flushed to disk, and renamed over the mark, so
 * a crash leaves the old mark or the new one, never half of one. Called
 * inside a print run's transaction, it counts the run's own uncommitted rows.
 */
export function raiseRegistryMark(conn: DuckDBConnection, catalog: string, path: string): Promise<RegistryMark> {
  const next = queue.then(async () => {
    const mark = higher(await storeRegistry(conn, catalog), await readRegistryMark(path));
    const tmp = `${path}.tmp`;
    const file = await open(tmp, "w");
    try {
      await file.writeFile(`${JSON.stringify(mark)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
    return mark;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** Thrown at boot by a store that holds less than the mark records. */
export class RegistryShrankRefused extends StoreRefused {
  constructor(
    readonly store: RegistryMark,
    readonly mark: RegistryMark,
    message: string,
  ) {
    super(message);
    this.name = "RegistryShrankRefused";
  }
}

const describe = (m: RegistryMark) =>
  `${m.print_run} print run(s) and ${m.minted_field_number} minted field number(s), the highest ` +
  (m.highest_field_number === 0 ? "none" : String(m.highest_field_number));

/**
 * The boot's check: refuse a store that holds fewer print runs or minted
 * field numbers than the mark at `path`, or a lower highest number, and
 * otherwise raise the mark to what it holds. The first boot with no mark
 * writes one.
 */
export async function checkRegistryMark(conn: DuckDBConnection, catalog: string, path: string): Promise<MarkCheck> {
  const store = await storeRegistry(conn, catalog);
  const before = await readRegistryMark(path);
  if (
    before !== null &&
    (store.print_run < before.print_run ||
      store.minted_field_number < before.minted_field_number ||
      store.highest_field_number < before.highest_field_number)
  ) {
    throw new RegistryShrankRefused(
      store,
      before,
      `Refusing to serve this store: it holds ${describe(store)}, and this deployment has held ` +
        `${describe(before)} (${path}). A store that has lost minted numbers would issue them again on the next ` +
        `print run, and they are already on pins. Put back the store that held them. Only if losing them is ` +
        `understood and accepted (for example, restoring a backup after the live store was destroyed), delete ` +
        `${path} and restart. See docs/runbooks/deploy-fly.md.`,
    );
  }
  await raiseRegistryMark(conn, catalog, path);
  return { store, before };
}
