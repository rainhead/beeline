import type { DuckDBConnection } from "@duckdb/node-api";
import { withPrintRunLock } from "./print-run.js";

/**
 * The program calendar's events (beeline-2zej.1.4): the one writer of `event`, `event_place`, `event_online`,
 * `event_registration` and `event_change` (schema/075). The form and the API will both call these functions, so
 * nothing can change an event without leaving a change behind (ADR 0007, the 2026-11-19 addendum). No other code
 * writes these tables; test/event.test.ts holds the event's row and its change log in agreement.
 *
 * Creating an event writes no change: the row says who created it and when. Changing or cancelling one writes the
 * event's row and one `event_change` row for each field that changed, in one transaction.
 *
 * What was changed is worked out by reading the event's fields as text before and after the write and comparing
 * them. That way the log says what the store now holds however the caller spelled a value ('9:30' or '09:30:00'),
 * and a request that changes nothing writes nothing.
 *
 * Every write runs behind the in-process lock the other writers use (`withPrintRunLock`, src/print-run.ts), because
 * the app shares one connection whose transactions are raw BEGIN/COMMIT: two overlapping calls on it would fail at
 * BEGIN or pull one call's statements into the other's transaction. A caller that is already inside that lock must
 * not call these functions, as the lock is not re-entrant.
 *
 * Dates and times are strings here and in the SQL, never JavaScript values: kysely-duckdb reads a DATE as a Date
 * in the machine's zone and a TIME as an object of DuckDB's own, so this module reads them with CAST(... AS TEXT).
 */

/** The general location. A latitude comes with a longitude, or neither is given. */
export interface EventPlaceInput {
  name: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface EventRegistrationInput {
  url: string;
  /** The last day to sign up, `YYYY-MM-DD`. */
  registerBy?: string | null;
}

export interface NewEvent {
  programId: number;
  /** An event_kind code. A code that event_kind does not list is refused. */
  kind: string;
  collecting: boolean;
  name: string;
  series?: string | null;
  details?: string | null;
  /** `YYYY-MM-DD`. */
  dateStart: string;
  /** Defaults to dateStart. */
  dateEnd?: string;
  /** `HH:MM` or `HH:MM:SS`, on the wall clock in timeZone. */
  timeStart?: string | null;
  timeEnd?: string | null;
  /** An IANA zone name. Required with timeStart, and allowed without it. */
  timeZone?: string | null;
  place?: EventPlaceInput | null;
  onlineUrl?: string | null;
  registration?: EventRegistrationInput | null;
}

/**
 * What to change. A key left out is left alone; null clears a field that may be empty (and removes the place, the
 * online link or the registration). The program and the creator are never changed.
 */
export interface EventChanges {
  kind?: string;
  collecting?: boolean;
  name?: string;
  series?: string | null;
  details?: string | null;
  dateStart?: string;
  dateEnd?: string;
  timeStart?: string | null;
  timeEnd?: string | null;
  timeZone?: string | null;
  place?: EventPlaceInput | null;
  onlineUrl?: string | null;
  registration?: EventRegistrationInput | null;
}

/** Where a change was made from: the web form, the events endpoint of the API, or a load of changes made outside Beeline. */
export type EventSource = "form" | "api" | "load";
const SOURCES: readonly string[] = ["form", "api", "load"];

/** Who is making the change, from where, and why. */
export type ChangeBy = {
  reason?: string | null;
} & (
  | { source: "form" | "api"; personId: number }
  /** Only a change made outside Beeline and loaded afterwards may have no author: nobody is known to have made it. */
  | { source: "load"; personId: number | null }
);

export interface EventOptions {
  /** The moment of the write as an ISO string; the time now when left out. For tests. */
  at?: string;
}

/** The fields an event's change log names, in the order a change lists them. */
export const EVENT_CHANGE_FIELDS = [
  "kind",
  "collecting",
  "name",
  "series",
  "details",
  "date_start",
  "date_end",
  "time_start",
  "time_end",
  "time_zone",
  "cancelled_at",
  "place",
  "online",
  "registration",
] as const;
export type EventChangeField = (typeof EVENT_CHANGE_FIELDS)[number];

/** An event's logged fields as text, the form the log keeps them in. */
export type EventState = Record<EventChangeField, string | null>;

async function rows<T>(conn: DuckDBConnection, sql: string, params: unknown[] = []): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql, params as never);
  return reader.getRowObjectsJS() as T[];
}

async function inTransaction<T>(conn: DuckDBConnection, fn: () => Promise<T>): Promise<T> {
  await conn.run("BEGIN TRANSACTION");
  try {
    const result = await fn();
    await conn.run("COMMIT");
    return result;
  } catch (err) {
    // A failed ROLLBACK must not replace the error that made it necessary.
    await conn.run("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

/** The event's fields as the log keeps them, or null when there is no such event. */
export async function readEventState(conn: DuckDBConnection, eventId: number): Promise<EventState | null> {
  const [e] = await rows<Record<string, string | null>>(
    conn,
    `SELECT kind, CAST(collecting AS TEXT) AS collecting, name, series, details,
            CAST(date_start AS TEXT) AS date_start, CAST(date_end AS TEXT) AS date_end,
            CAST(time_start AS TEXT) AS time_start, CAST(time_end AS TEXT) AS time_end, time_zone,
            strftime(cancelled_at, '%Y-%m-%dT%H:%M:%S.%gZ') AS cancelled_at
     FROM event WHERE entity_id = $1`,
    [eventId],
  );
  if (e === undefined) return null;
  const [place] = await rows<{ name: string; latitude: number | null; longitude: number | null }>(
    conn,
    `SELECT name, latitude, longitude FROM event_place WHERE event_id = $1`,
    [eventId],
  );
  const [online] = await rows<{ url: string }>(conn, `SELECT url FROM event_online WHERE event_id = $1`, [eventId]);
  const [registration] = await rows<{ url: string; register_by: string | null }>(
    conn,
    `SELECT url, CAST(register_by AS TEXT) AS register_by FROM event_registration WHERE event_id = $1`,
    [eventId],
  );
  return {
    kind: e.kind!,
    collecting: e.collecting!,
    name: e.name!,
    series: e.series ?? null,
    details: e.details ?? null,
    date_start: e.date_start!,
    date_end: e.date_end!,
    time_start: e.time_start ?? null,
    time_end: e.time_end ?? null,
    time_zone: e.time_zone ?? null,
    cancelled_at: e.cancelled_at ?? null,
    place: place === undefined ? null : JSON.stringify({ name: place.name, latitude: place.latitude, longitude: place.longitude }),
    online: online?.url ?? null,
    registration: registration === undefined ? null : JSON.stringify({ url: registration.url, register_by: registration.register_by }),
  };
}

/** A text field that must not be empty: refused here, and by a CHECK behind it. */
function required(what: string, value: string): string {
  if (value.trim() === "") throw new Error(`An event's ${what} cannot be empty.`);
  return value;
}

/** A text field that may be left out: an empty string is the same as none. */
function optional(value: string | null | undefined): string | null | undefined {
  return typeof value === "string" && value.trim() === "" ? null : value;
}

/** A zone the runtime knows by its IANA name (not an offset such as +01:00). Refused otherwise. */
function checkZone(zone: string): string {
  let known = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(zone);
  if (known) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
    } catch {
      known = false;
    }
  }
  if (!known) throw new Error(`'${zone}' is not a time zone name this server knows (an IANA name such as America/Los_Angeles).`);
  return zone;
}

function checkSource(by: { source: string; personId: number | null }): void {
  const source = by.source;
  if (!SOURCES.includes(source)) throw new Error(`An event change's source is one of ${SOURCES.join(", ")}, not '${source}'.`);
  if (by.personId === null && source !== "load") throw new Error(`A change from the ${source} needs the person who made it; only a load may have no author.`);
}

async function checkKind(conn: DuckDBConnection, kind: string): Promise<void> {
  const known = await rows(conn, `SELECT 1 FROM event_kind WHERE code = $1`, [kind]);
  if (known.length === 0) throw new Error(`'${kind}' is not an event kind (event_kind lists them).`);
}

async function writePlace(conn: DuckDBConnection, eventId: number, place: EventPlaceInput | null): Promise<void> {
  // An UPDATE, an INSERT or a DELETE and never a delete followed by an insert of the same key, which one DuckDB
  // transaction can refuse.
  const [{ n }] = await rows<{ n: bigint }>(conn, `SELECT count(*) AS n FROM event_place WHERE event_id = $1`, [eventId]) as [{ n: bigint }];
  if (place === null) {
    if (n > 0n) await conn.run(`DELETE FROM event_place WHERE event_id = $1`, [eventId] as never);
    return;
  }
  const params = [eventId, place.name, place.latitude ?? null, place.longitude ?? null];
  if (n > 0n) await conn.run(`UPDATE event_place SET name = $2, latitude = $3, longitude = $4 WHERE event_id = $1`, params as never);
  else await conn.run(`INSERT INTO event_place (event_id, name, latitude, longitude) VALUES ($1, $2, $3, $4)`, params as never);
}

async function writeOnline(conn: DuckDBConnection, eventId: number, url: string | null): Promise<void> {
  const [{ n }] = await rows<{ n: bigint }>(conn, `SELECT count(*) AS n FROM event_online WHERE event_id = $1`, [eventId]) as [{ n: bigint }];
  if (url === null) {
    if (n > 0n) await conn.run(`DELETE FROM event_online WHERE event_id = $1`, [eventId] as never);
  } else if (n > 0n) await conn.run(`UPDATE event_online SET url = $2 WHERE event_id = $1`, [eventId, url] as never);
  else await conn.run(`INSERT INTO event_online (event_id, url) VALUES ($1, $2)`, [eventId, url] as never);
}

async function writeRegistration(conn: DuckDBConnection, eventId: number, r: EventRegistrationInput | null): Promise<void> {
  const [{ n }] = await rows<{ n: bigint }>(conn, `SELECT count(*) AS n FROM event_registration WHERE event_id = $1`, [eventId]) as [{ n: bigint }];
  if (r === null) {
    if (n > 0n) await conn.run(`DELETE FROM event_registration WHERE event_id = $1`, [eventId] as never);
    return;
  }
  const params = [eventId, r.url, r.registerBy ?? null];
  if (n > 0n) await conn.run(`UPDATE event_registration SET url = $2, register_by = $3::DATE WHERE event_id = $1`, params as never);
  else await conn.run(`INSERT INTO event_registration (event_id, url, register_by) VALUES ($1, $2, $3::DATE)`, params as never);
}

/**
 * Put an event on the calendar, with its place, online link and registration if it has them; its id. Writes no
 * change. A kind that is not in event_kind, a time zone the server does not know, and an empty name or address are
 * refused; so are a bad date or time, a time without a zone and a latitude without a longitude, by the table's
 * CHECKs. An empty series or details is stored as none. Nothing is written when anything is refused.
 */
export function createEvent(conn: DuckDBConnection, e: NewEvent, createdBy: number, opts: EventOptions = {}): Promise<number> {
  const at = opts.at ?? new Date().toISOString();
  return withPrintRunLock(() =>
    inTransaction(conn, async () => {
      await checkKind(conn, e.kind);
      if (e.timeZone != null) checkZone(e.timeZone);
      const place = e.place == null ? null : { ...e.place, name: required("place name", e.place.name) };
      const online = e.onlineUrl == null ? null : required("online address", e.onlineUrl);
      const registration = e.registration == null ? null : { ...e.registration, url: required("registration address", e.registration.url) };
      const [created] = await rows<{ entity_id: number }>(
        conn,
        `INSERT INTO event (program_id, kind, collecting, name, series, details, date_start, date_end,
                            time_start, time_end, time_zone, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::DATE, $8::DATE, $9::TIME, $10::TIME, $11, $12, $13::TIMESTAMP)
         RETURNING entity_id`,
        [
          e.programId, e.kind, e.collecting, required("name", e.name), optional(e.series) ?? null, optional(e.details) ?? null,
          e.dateStart, e.dateEnd ?? e.dateStart, e.timeStart ?? null, e.timeEnd ?? null, e.timeZone ?? null, createdBy, at,
        ],
      );
      const id = created!.entity_id;
      if (place !== null) await writePlace(conn, id, place);
      if (online !== null) await writeOnline(conn, id, online);
      if (registration !== null) await writeRegistration(conn, id, registration);
      return id;
    }),
  );
}

/** The columns of `event` a change may set, each with the SQL that casts its parameter. */
const COLUMN_CHANGES: { key: keyof EventChanges; column: string; cast: string }[] = [
  { key: "kind", column: "kind", cast: "" },
  { key: "collecting", column: "collecting", cast: "" },
  { key: "name", column: "name", cast: "" },
  { key: "series", column: "series", cast: "" },
  { key: "details", column: "details", cast: "" },
  { key: "dateStart", column: "date_start", cast: "::DATE" },
  { key: "dateEnd", column: "date_end", cast: "::DATE" },
  { key: "timeStart", column: "time_start", cast: "::TIME" },
  { key: "timeEnd", column: "time_end", cast: "::TIME" },
  { key: "timeZone", column: "time_zone", cast: "" },
];

/**
 * Write the change rows for what differs between two states, all under one change_id drawn from the sequence (so
 * the changes of one request share it, and later requests have larger ones); the fields that differ.
 */
async function logChanges(
  conn: DuckDBConnection,
  eventId: number,
  before: EventState,
  after: EventState,
  by: ChangeBy,
  at: string,
): Promise<EventChangeField[]> {
  const changed = EVENT_CHANGE_FIELDS.filter((field) => before[field] !== after[field]);
  if (changed.length === 0) return [];
  const [{ id }] = (await rows<{ id: number }>(conn, `SELECT nextval('entity_id_seq') AS id`)) as [{ id: number }];
  for (const field of changed) {
    await conn.run(
      `INSERT INTO event_change (change_id, event_id, changed_at, author_id, source, field, old_value, new_value, reason)
       VALUES ($1, $2, $3::TIMESTAMP, $4, $5, $6, $7, $8, $9)`,
      [id, eventId, at, by.personId, by.source, field, before[field], after[field], by.reason ?? null] as never,
    );
  }
  return changed;
}

async function mustRead(conn: DuckDBConnection, eventId: number): Promise<EventState> {
  const state = await readEventState(conn, eventId);
  if (state === null) throw new Error(`There is no event ${eventId}.`);
  return state;
}

/**
 * Change an event. The row and one `event_change` row for each field that changed are written in one
 * transaction, under one change_id; the fields that changed, in the order they were logged (none when the request
 * changed nothing, and then nothing is written). Dates and times are checked as a whole, after every change in the
 * request is applied, so moving the start and the end together is one request. A time needs a zone: setting a
 * time on an event with none is refused unless the request sets the zone too. The same refusals as createEvent
 * apply to what the request sets. A cancelled event may still be changed (its name, its details, a date): the
 * cancellation is not undone and is not a field this function changes; see cancelEvent.
 */
export function changeEvent(conn: DuckDBConnection, eventId: number, changes: EventChanges, by: ChangeBy, opts: EventOptions = {}): Promise<EventChangeField[]> {
  const at = opts.at ?? new Date().toISOString();
  return withPrintRunLock(() =>
    inTransaction(conn, async () => {
      checkSource(by);
      const before = await mustRead(conn, eventId);
      if (changes.kind !== undefined) await checkKind(conn, changes.kind);
      if (changes.timeZone != null) checkZone(changes.timeZone);
      const values: EventChanges = {
        ...changes,
        ...(changes.name !== undefined ? { name: required("name", changes.name) } : {}),
        ...(changes.series !== undefined ? { series: optional(changes.series) } : {}),
        ...(changes.details !== undefined ? { details: optional(changes.details) } : {}),
      };
      const place = changes.place == null ? changes.place : { ...changes.place, name: required("place name", changes.place.name) };
      const online = changes.onlineUrl == null ? changes.onlineUrl : required("online address", changes.onlineUrl);
      const registration = changes.registration == null ? changes.registration : { ...changes.registration, url: required("registration address", changes.registration.url) };
      const sets: string[] = [];
      const params: unknown[] = [eventId];
      for (const { key, column, cast } of COLUMN_CHANGES) {
        const value = values[key];
        if (value === undefined) continue;
        params.push(value);
        sets.push(`${column} = $${params.length}${cast}`);
      }
      if (sets.length > 0) await conn.run(`UPDATE event SET ${sets.join(", ")} WHERE entity_id = $1`, params as never);
      if (place !== undefined) await writePlace(conn, eventId, place);
      if (online !== undefined) await writeOnline(conn, eventId, online);
      if (registration !== undefined) await writeRegistration(conn, eventId, registration);
      return logChanges(conn, eventId, before, await mustRead(conn, eventId), by, at);
    }),
  );
}

/**
 * Cancel an event: it keeps its row, with `cancelled_at` set, and one change records who cancelled it and why.
 * Refused for an event that is already cancelled, so the first cancellation is the one on record.
 */
export function cancelEvent(conn: DuckDBConnection, eventId: number, by: ChangeBy, opts: EventOptions = {}): Promise<void> {
  const at = opts.at ?? new Date().toISOString();
  return withPrintRunLock(() =>
    inTransaction(conn, async () => {
      checkSource(by);
      const before = await mustRead(conn, eventId);
      if (before.cancelled_at !== null) throw new Error(`Event ${eventId} is already cancelled.`);
      await conn.run(`UPDATE event SET cancelled_at = $2::TIMESTAMP WHERE entity_id = $1`, [eventId, at] as never);
      await logChanges(conn, eventId, before, await mustRead(conn, eventId), by, at);
    }),
  );
}
