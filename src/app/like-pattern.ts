import { sql, type RawBuilder } from "kysely";

/**
 * Text a person typed, matched as text. In a LIKE pattern `%` stands for any
 * run of characters and `_` for any one, so a term passed in as it was typed
 * made a lone `_` match every row (beeline-2k2s). These helpers escape the two
 * wildcards and the escape character (a backslash) in the term, and the
 * statement names the escape character with ESCAPE, since DuckDB has none by
 * default. Matching stays case-insensitive and in part: the caller passes the
 * column already lowered, as `lower(col)`.
 *
 * Every LIKE whose pattern comes from a person goes through here. A fixed
 * pattern written in the source (`LIKE '%locality%'`) needs nothing.
 */
const escapeLike = (term: string) => term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);

const ESCAPE = sql.raw(`ESCAPE '\\'`);

/** The column, already lowered, holds the typed term anywhere in it. */
export const likeContains = (lowered: RawBuilder<unknown>, term: string): RawBuilder<boolean> =>
  sql<boolean>`${lowered} LIKE ${`%${escapeLike(term)}%`} ${ESCAPE}`;

/** The column, already lowered, starts with the typed term. */
export const likePrefix = (lowered: RawBuilder<unknown>, term: string): RawBuilder<boolean> =>
  sql<boolean>`${lowered} LIKE ${`${escapeLike(term)}%`} ${ESCAPE}`;
