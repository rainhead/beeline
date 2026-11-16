import type { DuckDBConnection } from "@duckdb/node-api";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { adoptEcdysisNames } from "./adopt-ecdysis.js";

/**
 * File determinations made under one name under another, as new events
 * (`pnpm taxon:refile`). The first use: Lincoln Best determined two
 * specimens as Protohalonia venusta in the old system, a name Ecdysis does
 * not hold; Ecdysis files the species as Eucera venusta, and Peter decided
 * on 2026-11-15 to follow Ecdysis.
 *
 * Nothing is edited. Each specimen whose determination of record names the
 * old node gets a new determination naming the new one, recorded now so it
 * becomes the record, and otherwise saying what the old one said: the same
 * determiner, whether an expert, sex, caste, qualifier, the date and its
 * precision, and the channel it came through, since the assertion is the
 * determiner's and only the name it is filed under changes. The name the
 * determiner wrote is kept as the verbatim identification, and the notes say
 * why, who decided and where it was asked. Both events stay in the
 * specimen's history, which the record page shows (Peter, 2026-11-15: every
 * change is to be visible). The old node stays too: determinations still
 * point at it.
 *
 * The new name must be in the tree already or be one Ecdysis's thesaurus
 * lets adoption add (src/adopt-ecdysis.ts), with its missing ancestors. A
 * bee's name is allowed here, unlike from the volunteers' picker: running
 * this is a staff decision. One transaction; --dry-run rolls it back after
 * reporting.
 */

export interface RefileResult {
  /** The specimens given a new determination. */
  specimens: number[];
  /** Names added to the tree to file them under. */
  adopted: string[];
}

export class RefileRefused extends Error {}

const one = async (conn: DuckDBConnection, sql: string, params: unknown[] = []): Promise<unknown[][]> =>
  (await conn.run(sql, params as never)).getRows();

export async function refileDeterminations(
  conn: DuckDBConnection,
  opts: { from: string; to: string; reason: string; dryRun?: boolean },
): Promise<RefileResult> {
  if (opts.reason.trim() === "") throw new RefileRefused("a reason is required: it is what the specimen's history will say");
  await conn.run("BEGIN TRANSACTION");
  try {
    const from = await one(conn, "SELECT entity_id FROM animal WHERE scientific_name = $1", [opts.from]);
    if (from.length !== 1) throw new RefileRefused(`the tree has ${from.length} nodes named ${opts.from}; give a name it holds once`);
    const fromId = Number(from[0]![0]);
    let adopted: string[] = [];
    if ((await one(conn, "SELECT 1 FROM animal WHERE scientific_name = $1", [opts.to])).length === 0) {
      adopted = (await adoptEcdysisNames(conn, [opts.to])).flatMap((a) => [a.name, ...a.ancestors]);
    }
    const to = await one(conn, "SELECT entity_id FROM animal WHERE scientific_name = $1", [opts.to]);
    if (to.length !== 1) {
      throw new RefileRefused(`${opts.to} is not in the tree, and Ecdysis's thesaurus does not let it be added (one accepted name at that spelling, reaching the tree)`);
    }
    const toId = Number(to[0]![0]);
    if (toId === fromId) throw new RefileRefused("the two names are the same node");
    const specimens = (
      await one(conn, "SELECT specimen_id FROM determination_of_record WHERE animal_id = $1 ORDER BY specimen_id", [fromId])
    ).map((r) => Number(r[0]));
    await conn.run(
      `INSERT INTO determination (specimen_id, animal_id, qualifier, verbatim_identification, sex, caste,
                                  determiner_id, determiner_name, is_expert, channel, determined_on, determined_on_precision, notes)
       SELECT d.specimen_id, $1, d.qualifier, coalesce(d.verbatim_identification, $2), d.sex, d.caste,
              d.determiner_id, d.determiner_name, d.is_expert, d.channel, d.determined_on, d.determined_on_precision, $3
       FROM determination_of_record d
       WHERE d.animal_id = $4
       ORDER BY d.specimen_id`,
      [toId, opts.from, opts.reason, fromId] as never,
    );
    await conn.run(opts.dryRun ? "ROLLBACK" : "COMMIT");
    return { specimens, adopted };
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

// CLI: pnpm taxon:refile "<from name>" "<to name>" --reason "<why, who decided, where asked>" [--dry-run] [db]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { reason: { type: "string" }, "dry-run": { type: "boolean" } },
  });
  const [from, to, dbArg] = positionals;
  if (from === undefined || to === undefined || values.reason === undefined) {
    console.error('usage: pnpm taxon:refile "<from name>" "<to name>" --reason "<why, who decided, where asked>" [--dry-run] [db]');
    process.exit(2);
  }
  const { openDuckDb } = await import("./db.js");
  const { DEFAULT_DB } = await import("./person-change.js");
  const instance = await openDuckDb(dbArg ?? process.env.BEELINE_DB ?? DEFAULT_DB);
  const conn = await instance.connect();
  try {
    const result = await refileDeterminations(conn, { from, to, reason: values.reason, dryRun: values["dry-run"] === true });
    if (values["dry-run"] !== true) await conn.run("CHECKPOINT");
    console.log(
      `${values["dry-run"] === true ? "would file" : "filed"} ${result.specimens.length} specimen(s) under ${to}` +
        (result.adopted.length > 0 ? `, adding ${result.adopted.join(", ")} to the tree` : "") +
        (result.specimens.length > 0 ? `: specimen ids ${result.specimens.join(", ")}` : ""),
    );
  } catch (err) {
    if (err instanceof RefileRefused) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  } finally {
    conn.closeSync();
  }
}
