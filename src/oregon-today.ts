/**
 * Today as Oregon reads it, and days counted back from a day. The program's
 * days are Oregon's, not UTC's: a collector's evening is already tomorrow in
 * Greenwich.
 */

/** A day, `YYYY-MM-DD`, as Oregon reads `now`. */
export const oregonToday = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);

/**
 * The day that many months before a day (`YYYY-MM-DD`), clamped to the end of
 * a shorter month: 31 March less one month is 28 or 29 February.
 */
export function monthsBefore(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) - months;
  const year = Math.floor(index / 12);
  const month = index % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
