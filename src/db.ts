import type { DuckDBInstance } from "@duckdb/node-api";
import { Kysely, type Dialect } from "kysely";
import { DuckDbDialect } from "kysely-duckdb";
import type { Database } from "./model.js";

/** Kysely over an already-open DuckDB instance (single-writer: share it). */
export function createKysely(instance: DuckDBInstance): Kysely<Database> {
  // kysely-duckdb's published types resolve kysely's CJS declarations while we
  // resolve the ESM ones — structurally identical, nominally incompatible.
  const dialect = new DuckDbDialect({ database: instance, tableMappings: {} }) as unknown as Dialect;
  return new Kysely<Database>({ dialect });
}
