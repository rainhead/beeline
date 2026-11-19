import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * Naming the collectors of a sample, as the trap form, the samples upload and
 * staff's collector correction name them (beeline-kgyd.4.5): one rule, so a
 * name that reaches a person in one place reaches the same person in the
 * others. Each entry is tried in this order:
 *
 *  1. A person's id, all digits, as their page is at `/people/<id>`; or
 *     `inat:` and their iNaturalist login (any case) or user id.
 *  2. A person's display name exactly as Beeline writes it.
 *  3. The name folded to its letters and digits, without case or accents,
 *     against every display name folded the same way, so typography does not
 *     stop a match ("Mary-Jo Mosby" names Mary Jo Mosby).
 *
 * A name two people answer to, exactly or folded, is refused rather than
 * guessed between, and so is a name with no letter or digit in it. Nobody is
 * ever created here: a collector Beeline does not know is added first, on
 * /unclaimed or /people.
 *
 * This is deliberately narrower than the person overlay's resolver
 * (src/apply-person-overlay.ts), which also knows every spelling legacy
 * promotion recorded for a person, and wider than promotion's own key
 * (`legacy_name_key`, ingest/promote-legacy.sql), which keeps only a to z and
 * so drops an accented letter rather than reading it as its base letter. It
 * reads display names alone because they are what staff and collectors see
 * on screen. On production's store of 18 November 2026 no display name holds
 * a letter outside a to z and no two people's names fold together, so the
 * three rules give the same answers there today.
 */

export interface MatchedCollector {
  person_id: number;
  display_name: string;
}

export type CollectorMatch = { collectors: MatchedCollector[] } | { problem: string };

/** A name folded to its letters and digits, lower case, accents taken off their letters. */
export const foldName = (s: string): string => s.normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

async function rows<T>(conn: DuckDBConnection, sql: string, params: unknown[] = []): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql, params as never);
  return reader.getRowObjectsJS() as T[];
}

/**
 * Who one entry names, or why it names nobody. `people` is every person, as
 * display names; read once for a whole list.
 */
async function matchOne(conn: DuckDBConnection, entry: string, people: MatchedCollector[]): Promise<MatchedCollector | string> {
  if (/^\d+$/.test(entry)) {
    const found = people.find((p) => p.person_id === Number(entry));
    return found ?? `Beeline has nobody whose id is ${entry}`;
  }
  const account = /^inat:\s*(.+)$/i.exec(entry);
  if (account !== null) {
    const handle = account[1]!.trim();
    const byId = /^\d+$/.test(handle);
    const found = await rows<{ person_id: number }>(
      conn,
      byId
        ? `SELECT person_id FROM inat_account WHERE inat_user_id = $1::BIGINT`
        : `SELECT person_id FROM inat_account WHERE lower(login) = lower($1)`,
      [handle],
    );
    const person = found[0] === undefined ? undefined : people.find((p) => p.person_id === Number(found[0]!.person_id));
    return person ?? `Beeline knows nobody by the iNaturalist ${byId ? "user id" : "login"} ${handle}`;
  }
  const exact = people.filter((p) => p.display_name === entry);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return `${exact.length} people are called ${entry}; name one by their id or iNaturalist login`;
  const key = foldName(entry);
  if (key === "") return `${JSON.stringify(entry)} is not a name`;
  const folded = people.filter((p) => foldName(p.display_name) === key);
  if (folded.length === 1) return folded[0]!;
  if (folded.length > 1) {
    return `${entry} could be any of ${folded.map((p) => p.display_name).join(", ")}; name one by their id or iNaturalist login`;
  }
  return `Beeline has nobody called ${entry}; add them on /unclaimed or /people first`;
}

/**
 * The people a list of entries names, in its order, the first being the
 * primary collector. Blank entries are left out. Refused: a list naming
 * nobody, an entry that names nobody or several people, and one person named
 * twice. The problem is a sentence for whoever wrote the list.
 */
export async function matchCollectors(conn: DuckDBConnection, entries: readonly string[]): Promise<CollectorMatch> {
  const given = entries.map((e) => e.trim()).filter((e) => e !== "");
  if (given.length === 0) return { problem: "At least one collector is needed." };
  const people = (await rows<{ person_id: number; display_name: string }>(conn, `SELECT entity_id AS person_id, display_name FROM person`)).map(
    (p) => ({ person_id: Number(p.person_id), display_name: p.display_name }),
  );
  const collectors: MatchedCollector[] = [];
  for (const entry of given) {
    const found = await matchOne(conn, entry, people);
    if (typeof found === "string") return { problem: `${found}.` };
    if (collectors.some((c) => c.person_id === found.person_id)) return { problem: `${found.display_name} is named twice.` };
    collectors.push(found);
  }
  return { collectors };
}
