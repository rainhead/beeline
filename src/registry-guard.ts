import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * The two tools that rebuild a store's model refuse a store that has printed
 * (beeline-83b8.13). A print run and the field numbers it minted
 * (schema/035) are the one thing in the store nothing can re-derive: each
 * number is on a pin, and the registry is what stops it being issued twice
 * (ADR 0008 §5). Legacy promotion rebuilds the people, samples and specimens
 * those rows hang off, and a reseed builds a new store without them, after
 * which the next run mints again from the imported ceiling and issues the
 * same numbers a second time. Before production's first run this was a
 * rehearsal cost on the sandbox; from it, it is two pins with one number.
 *
 * There is no override. What replaces a reseed for a promotion-rule change on
 * a store that has printed is not decided (the runbook says so).
 */

export const RUNBOOK =
  'docs/runbooks/deploy-fly.md, "Re-deriving the model after a promotion change"';

export interface RegistryCounts {
  print_run: number;
  minted_field_number: number;
}

const scalar = async (conn: DuckDBConnection, sql: string): Promise<number> => {
  const [[v]] = (await (await conn.run(sql)).getRows()) as [[bigint | number | null]];
  return Number(v ?? 0);
};

/**
 * How many print runs and minted numbers the store in `catalog` holds. A
 * store from before schema/035 has neither table, and so holds none. The
 * catalog is named rather than assumed, because the reseed reads its source
 * as an attached database beside a target that has the same tables.
 */
export async function countRegistry(conn: DuckDBConnection, catalog: string): Promise<RegistryCounts> {
  const quoted = catalog.replaceAll("'", "''");
  const count = async (table: keyof RegistryCounts): Promise<number> => {
    const exists =
      (await scalar(
        conn,
        `SELECT count(*) FROM duckdb_tables()
         WHERE database_name = '${quoted}' AND schema_name = 'main' AND table_name = '${table}'`,
      )) > 0;
    return exists ? scalar(conn, `SELECT count(*) FROM "${catalog.replaceAll('"', '""')}".main.${table}`) : 0;
  };
  return { print_run: await count("print_run"), minted_field_number: await count("minted_field_number") };
}

/** Thrown, before anything is written, by a rebuild pointed at a store that has printed. */
export class PrintedStoreRefused extends Error {
  constructor(
    readonly counts: RegistryCounts,
    message: string,
  ) {
    super(message);
    this.name = "PrintedStoreRefused";
  }
}

const held = ({ print_run, minted_field_number }: RegistryCounts) =>
  `${print_run} print run(s) and ${minted_field_number} minted field number(s)`;

/** Legacy promotion's refusal: it would rebuild the records the runs hang off. */
export async function refusePromotionIntoPrintedStore(conn: DuckDBConnection): Promise<void> {
  const [[catalog]] = (await (await conn.run(`SELECT current_database()`)).getRows()) as [[string]];
  const counts = await countRegistry(conn, catalog);
  if (counts.print_run + counts.minted_field_number === 0) return;
  throw new PrintedStoreRefused(
    counts,
    `Refusing to promote legacy records: this store holds ${held(counts)}. ` +
      `Promotion rebuilds the people, samples and specimens those hang off, and a minted number is on a pin and ` +
      `must never be rebuilt or issued again (ADR 0008). Nothing was changed, and there is no override. See ${RUNBOOK}.`,
  );
}

/** The reseed's refusal: the new store would have no record of numbers already on pins. */
export async function refuseReseedOfPrintedStore(
  conn: DuckDBConnection,
  catalog: string,
  sourcePath: string,
): Promise<void> {
  const counts = await countRegistry(conn, catalog);
  if (counts.print_run + counts.minted_field_number === 0) return;
  throw new PrintedStoreRefused(
    counts,
    `Refusing to reseed from ${sourcePath}: it holds ${held(counts)}, and a reseed carries neither, so the new ` +
      `store's next print run would issue those numbers again. Nothing was built, and there is no override. ` +
      `See ${RUNBOOK}.`,
  );
}
