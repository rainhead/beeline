/**
 * The kind of a sample made from the old Beeline's records, stated once
 * (beeline-lmlh). Three places use it: legacy promotion
 * (ingest/promote-legacy.sql, through its `{{OLD_SAMPLE_KIND}}` placeholder),
 * the carry-over of held-back records (src/carry-over-legacy.ts), and the
 * staff correction that re-derives one sample's kind (src/app/sample-kind.ts).
 *
 * A sample is a trap sample when some old record gives an end date, unless
 * every end date given equals that record's own start and the method of
 * every record of the sample is a netting method. The old records wrote a
 * netting trip of one day as a range ending on its start day, which is the
 * same date written another way (ingest/legacy-export-rulings.csv), so an
 * end date alone does not make a trap. The method decides where the dates
 * cannot: a trap emptied on the day it was set also has an end equal to its
 * start, and stays a trap sample because its method names a trap. A sample
 * with no method at all stays a trap, since nothing says it was netted.
 * Promotion used to say trap for any end date at all, and 284 netted samples
 * of 2018 and 2020 were made traps by it.
 *
 * Whether `kind` should exist beside the method is a separate question
 * (beeline-ni5m.15).
 */

/** The methods that say the bees were caught by net, compared lower-cased and trimmed. */
export const NETTING_METHODS = ["aerial net", "net"] as const;

/**
 * The SQL expression, to be used in an aggregate over the old records of one
 * sample, that gives 'trap' or 'net'. `end`, `start` and `method` are
 * columns of one old record (a parsed end date, a parsed start date, the
 * method's words).
 */
export function oldSampleKindSql(columns: { end: string; start: string; method: string }): string {
  const { end, start, method } = columns;
  const netting = NETTING_METHODS.map((m) => `'${m}'`).join(", ");
  return `CASE
    WHEN count(${end}) = 0 THEN 'net'
    WHEN count(${end}) = count(*) FILTER (WHERE ${end} = ${start})
     AND count(*) = count(*) FILTER (WHERE lower(trim(${method})) IN (${netting}))
      THEN 'net'
    ELSE 'trap'
  END`;
}
