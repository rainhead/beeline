import { beforeEach, describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import {
  cancelEvent,
  changeEvent,
  createEvent,
  EVENT_CHANGE_FIELDS,
  readEventState,
  type EventChangeField,
  type ChangeBy,
  type EventState,
  type NewEvent,
} from "../src/event.js";
import { createMemoryDb, CURRENT_SEASON, currentSeasonDate, rows } from "./helpers.js";

/**
 * The program calendar's events (beeline-2zej.1.4). The fixture is synthetic, with the variety of the 2026
 * calendar the sketch was checked against: a talk in a series with a time and a zone, an online event, a
 * multi-day field day, a cancelled event, a moved one, a deadline with no place, and a whole-program event. The
 * real 2026 events came from a members' list and stay out of the public repo.
 */

let conn: DuckDBConnection;
let ada: number;
let bea: number;
const programs: Record<string, number> = {};

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  const created = await rows(conn, "INSERT INTO person (display_name) VALUES ('Ada Organizer'), ('Bea Coordinator') RETURNING entity_id");
  [ada, bea] = created.map(([id]) => id as number) as [number, number];
  for (const [code, id] of (await rows(conn, "SELECT code, entity_id FROM program")) as [string, number][]) programs[code] = id;
});

const d = (m: number, day: number) => currentSeasonDate(m, day);
const by = (reason?: string): ChangeBy => ({ personId: ada, source: "form", reason: reason ?? null });
let tick = 0;
/** A distinct, increasing moment for each write, in the current season's November, so a sequence has an order. */
const at = () => new Date(Date.UTC(CURRENT_SEASON, 10, 1, 8, 0, tick++)).toISOString();
/** An instant on a given day of that November, with its milliseconds, as the log writes it. */
const instant = (day: number, time: string) => `${CURRENT_SEASON}-11-${String(day).padStart(2, "0")}T${time}Z`;

const talk = (): NewEvent => ({
  programId: programs.MM!,
  kind: "talk",
  collecting: false,
  name: "Catch a Buzz: bumble bee nests",
  series: "Catch a Buzz",
  dateStart: d(11, 10),
  timeStart: "18:00",
  timeEnd: "19:00",
  timeZone: "America/Los_Angeles",
  onlineUrl: "https://example.org/zoom/catch-a-buzz",
});
const microscope = (): NewEvent => ({
  programId: programs.WaBA!,
  kind: "microscope session",
  collecting: false,
  name: "Microscope session, Vancouver",
  dateStart: d(11, 13),
  place: { name: "A university lab" },
  registration: { url: "https://example.org/register/microscope", registerBy: d(11, 8) },
});
const fieldDays = (): NewEvent => ({
  programId: programs.ID!,
  kind: "field day",
  collecting: true,
  name: "West central Idaho field days",
  dateStart: d(6, 12),
  dateEnd: d(6, 15),
  details: "Bring a net and a lunch.",
  place: { name: "A canyon state park", latitude: 45.1, longitude: -116.4 },
});
const oregonFieldDay = (): NewEvent => ({
  programId: programs.OBA!,
  kind: "field day",
  collecting: true,
  name: "Oregon field day",
  dateStart: d(7, 9),
  timeStart: "09:30:00",
  timeZone: "America/Los_Angeles",
  place: { name: "A county park", latitude: 44.0, longitude: -123.1 },
});
const deadline = (): NewEvent => ({
  programId: programs.MM!,
  kind: "deadline",
  collecting: false,
  name: "Master Level proposals due",
  dateStart: d(10, 30),
});
const wholeProgram = (): NewEvent => ({
  programId: programs.MM!,
  kind: "meeting",
  collecting: false,
  name: "All-program meeting",
  dateStart: d(9, 20),
  timeStart: "12:00",
  timeEnd: "13:30",
  timeZone: "America/Los_Angeles",
  onlineUrl: "https://example.org/zoom/all-program",
});

const changes = async (eventId?: number) =>
  (await rows(
    conn,
    `SELECT event_id, field, old_value, new_value, author_id, source, reason FROM event_change
     ${eventId === undefined ? "" : `WHERE event_id = ${eventId}`} ORDER BY change_id, field`,
  )) as [number, string, string | null, string | null, number, string, string | null][];

describe("creating events", () => {
  it("stores each kind of event as given and writes no change", async () => {
    const ids: Record<string, number> = {};
    for (const [name, e] of Object.entries({ talk: talk(), microscope: microscope(), fieldDays: fieldDays(), oregonFieldDay: oregonFieldDay(), deadline: deadline(), wholeProgram: wholeProgram() })) {
      ids[name] = await createEvent(conn, e, ada, { at: at() });
    }
    expect(await changes()).toEqual([]);

    const state = (name: string) => readEventState(conn, ids[name]!);
    expect(await state("talk")).toMatchObject({
      kind: "talk", collecting: "false", series: "Catch a Buzz", date_start: d(11, 10), date_end: d(11, 10),
      time_start: "18:00:00", time_end: "19:00:00", time_zone: "America/Los_Angeles", online: "https://example.org/zoom/catch-a-buzz",
      place: null, registration: null, cancelled_at: null,
    });
    // A multi-day event keeps its range, and its place its coordinates.
    expect(await state("fieldDays")).toMatchObject({ collecting: "true", date_start: d(6, 12), date_end: d(6, 15), time_start: null, time_zone: null, online: null });
    expect(JSON.parse((await state("fieldDays"))!.place!)).toEqual({ name: "A canyon state park", latitude: 45.1, longitude: -116.4 });
    // A deadline has no place, no online link and no registration.
    expect(await state("deadline")).toMatchObject({ place: null, online: null, registration: null });
    expect(JSON.parse((await state("microscope"))!.registration!)).toEqual({ url: "https://example.org/register/microscope", register_by: d(11, 8) });
    // A whole-program event is on the program MM's calendar.
    expect(await rows(conn, `SELECT p.code FROM event e JOIN program p ON p.entity_id = e.program_id WHERE e.entity_id = ${ids.wholeProgram}`)).toEqual([["MM"]]);
  });

  it("records who created it and when, and takes its id from the one entity sequence", async () => {
    const id = await createEvent(conn, deadline(), bea, { at: instant(1, "08:00:00.000") });
    expect(await rows(conn, `SELECT created_by, CAST(created_at AS TEXT) FROM event WHERE entity_id = ${id}`)).toEqual([[bea, `${CURRENT_SEASON}-11-01 08:00:00`]]);
    const [[next]] = (await rows(conn, "SELECT nextval('entity_id_seq')")) as [[number]];
    expect(next).toBeGreaterThan(id);
  });

  it("lists no event whose kind is not an event kind, and lists one that is not", async () => {
    for (const e of [talk(), microscope(), fieldDays(), oregonFieldDay(), deadline(), wholeProgram()]) await createEvent(conn, e, ada);
    expect(await rows(conn, "SELECT * FROM event_kind_unlisted")).toEqual([]);
    // The module refuses an unlisted kind, so the table is written to directly, as a repair or a load might.
    const odd = await createEvent(conn, deadline(), ada);
    await conn.run(`UPDATE event SET kind = 'bake sale' WHERE entity_id = ${odd}`);
    expect(await rows(conn, "SELECT event_id, kind FROM event_kind_unlisted")).toEqual([[odd, "bake sale"]]);
    await conn.run("INSERT INTO event_kind (code, name) VALUES ('bake sale', 'Bake sale')");
    expect(await rows(conn, "SELECT * FROM event_kind_unlisted")).toEqual([]);
  });

  it("seeds the nine kinds", async () => {
    expect((await rows(conn, "SELECT code FROM event_kind ORDER BY code")).flat()).toEqual([
      "conference", "course", "deadline", "field day", "meeting", "microscope session", "other", "outreach", "talk",
    ]);
  });
});

describe("the CHECKs", () => {
  const refuses = (e: Partial<NewEvent>, message: RegExp) => expect(createEvent(conn, { ...deadline(), ...e }, ada)).rejects.toThrow(message);

  it("refuse an event that ends before it starts", async () => {
    await refuses({ dateStart: d(6, 12), dateEnd: d(6, 11) }, /CHECK constraint/);
  });
  it("refuse a time with no zone, but allow a zone with no time, for a deadline that ends in one", async () => {
    await refuses({ timeStart: "18:00" }, /CHECK constraint/);
    const id = await createEvent(conn, { ...deadline(), timeZone: "America/Los_Angeles" }, ada);
    expect(await readEventState(conn, id)).toMatchObject({ time_start: null, time_zone: "America/Los_Angeles" });
  });
  it("refuse an end time with no start time", async () => {
    await refuses({ timeEnd: "19:00" }, /CHECK constraint/);
  });
  it("refuse a place with a latitude and no longitude", async () => {
    await refuses({ place: { name: "A park", latitude: 44.1 } }, /CHECK constraint/);
    await refuses({ place: { name: "A park", longitude: -123.1 } }, /CHECK constraint/);
  });
  it("refuse a latitude outside -90 to 90 and a longitude outside -180 to 180, and pass a place with neither", async () => {
    await refuses({ place: { name: "A park", latitude: 91, longitude: 0 } }, /CHECK constraint/);
    await refuses({ place: { name: "A park", latitude: 0, longitude: -181 } }, /CHECK constraint/);
    await createEvent(conn, { ...deadline(), place: { name: "A park" } }, ada);
    await createEvent(conn, { ...deadline(), place: { name: "The pole", latitude: -90, longitude: 180 } }, ada);
  });
  it("refuse an empty name or address on the table itself, not only in the module", async () => {
    const id = await createEvent(conn, deadline(), ada);
    await expect(conn.run(`UPDATE event SET name = '' WHERE entity_id = ${id}`)).rejects.toThrow(/CHECK constraint/);
    await expect(conn.run(`INSERT INTO event_place (event_id, name) VALUES (${id}, '')`)).rejects.toThrow(/CHECK constraint/);
    await expect(conn.run(`INSERT INTO event_online (event_id, url) VALUES (${id}, '')`)).rejects.toThrow(/CHECK constraint/);
    await expect(conn.run(`INSERT INTO event_registration (event_id, url) VALUES (${id}, '')`)).rejects.toThrow(/CHECK constraint/);
  });
  it("leave nothing behind when a create is refused after the event, a place and an online link were written", async () => {
    // The registration date is the last thing written, and it is not a date.
    await refuses(
      { place: { name: "A park" }, onlineUrl: "https://example.org", registration: { url: "https://example.org/r", registerBy: "not a date" } },
      /Conversion Error|Could not convert/,
    );
    expect(await rows(conn, "SELECT count(*) FROM event")).toEqual([[0n]]);
    expect(await rows(conn, "SELECT count(*) FROM event_place")).toEqual([[0n]]);
    expect(await rows(conn, "SELECT count(*) FROM event_online")).toEqual([[0n]]);
  });
  it("hold on the table itself, not only in the module", async () => {
    await expect(
      conn.run(`INSERT INTO event (program_id, kind, collecting, name, date_start, date_end, created_by)
                VALUES (${programs.MM}, 'talk', false, 'Backwards', DATE '${d(6, 12)}', DATE '${d(6, 1)}', ${ada})`),
    ).rejects.toThrow(/CHECK constraint/);
  });
});

describe("what DuckDB refuses, which is why the tables are shaped as they are (checked on 2.0.0, 2026-11-19)", () => {
  it("will not update a column that refers to another table on an event that other rows refer to", async () => {
    const id = await createEvent(conn, microscope(), ada, { at: at() });
    await expect(conn.run(`UPDATE event SET program_id = ${programs.OBA} WHERE entity_id = ${id}`)).rejects.toThrow(/still referenced by a foreign key/);
    // A column that refers to nothing can be updated on the same row.
    await conn.run(`UPDATE event SET name = 'Renamed' WHERE entity_id = ${id}`);
  });
  it("will not add a column with a REFERENCES to a table, so a later pointer is a table beside the event", async () => {
    await expect(conn.run("ALTER TABLE event ADD COLUMN site_id INTEGER REFERENCES program(entity_id)")).rejects.toThrow(/FOREIGN KEY constraints is not supported/);
  });
});

describe("changing events", () => {
  it("logs a moved event: the date, who moved it, and why", async () => {
    const id = await createEvent(conn, oregonFieldDay(), ada, { at: at() });
    expect(await changeEvent(conn, id, { dateStart: d(7, 16), dateEnd: d(7, 16) }, by("smoke"), { at: at() })).toEqual(["date_start", "date_end"]);
    expect(await changes(id)).toEqual([
      [id, "date_end", d(7, 9), d(7, 16), ada, "form", "smoke"],
      [id, "date_start", d(7, 9), d(7, 16), ada, "form", "smoke"],
    ]);
    expect(await readEventState(conn, id)).toMatchObject({ date_start: d(7, 16), date_end: d(7, 16) });
  });

  it("logs a cancelled event, which keeps its row, and refuses to cancel it twice", async () => {
    const id = await createEvent(conn, oregonFieldDay(), ada, { at: at() });
    await cancelEvent(conn, id, { personId: bea, source: "api", reason: "no permit" }, { at: instant(2, "09:15:00.250") });
    expect(await changes(id)).toEqual([[id, "cancelled_at", null, instant(2, "09:15:00.250"), bea, "api", "no permit"]]);
    expect(await rows(conn, `SELECT count(*) FROM event WHERE entity_id = ${id}`)).toEqual([[1n]]);
    await expect(cancelEvent(conn, id, by(), { at: at() })).rejects.toThrow(/already cancelled/);
    expect(await changes(id)).toHaveLength(1);
  });

  it("logs a change to the place, the online link and the registration under those names", async () => {
    const id = await createEvent(conn, microscope(), ada, { at: at() });
    await changeEvent(
      conn,
      id,
      {
        place: { name: "A different lab", latitude: 45.6, longitude: -122.6 },
        onlineUrl: "https://example.org/zoom/microscope",
        registration: null,
      },
      by("room change"),
      { at: at() },
    );
    const log = await changes(id);
    expect(log.map(([, field]) => field)).toEqual(["online", "place", "registration"]);
    const [online, place, registration] = log;
    expect(online!.slice(2, 4)).toEqual([null, "https://example.org/zoom/microscope"]);
    expect(JSON.parse(place![2]!)).toEqual({ name: "A university lab", latitude: null, longitude: null });
    expect(JSON.parse(place![3]!)).toEqual({ name: "A different lab", latitude: 45.6, longitude: -122.6 });
    expect(JSON.parse(registration![2]!)).toEqual({ url: "https://example.org/register/microscope", register_by: d(11, 8) });
    expect(registration![3]).toBeNull();
    expect(await rows(conn, `SELECT count(*) FROM event_registration WHERE event_id = ${id}`)).toEqual([[0n]]);
  });

  it("changes a time and its zone together, and clears them together", async () => {
    const id = await createEvent(conn, talk(), ada, { at: at() });
    await changeEvent(conn, id, { timeStart: "17:30", timeEnd: "18:30", timeZone: "America/Denver" }, by(), { at: at() });
    expect(await readEventState(conn, id)).toMatchObject({ time_start: "17:30:00", time_end: "18:30:00", time_zone: "America/Denver" });
    await changeEvent(conn, id, { timeStart: null, timeEnd: null, timeZone: null }, by(), { at: at() });
    expect(await readEventState(conn, id)).toMatchObject({ time_start: null, time_end: null, time_zone: null });
    expect((await changes(id)).filter(([, f]) => f === "time_zone").map(([, , o, n]) => [o, n])).toEqual([
      ["America/Los_Angeles", "America/Denver"],
      ["America/Denver", null],
    ]);
  });

  it("writes nothing for a request that changes nothing, however a value is spelled", async () => {
    const id = await createEvent(conn, talk(), ada, { at: at() });
    expect(await changeEvent(conn, id, { name: talk().name, timeStart: "18:00:00", onlineUrl: talk().onlineUrl, series: "Catch a Buzz" }, by(), { at: at() })).toEqual([]);
    expect(await changes()).toEqual([]);
  });

  it("refuses a change that breaks a CHECK, and writes neither the event nor its change", async () => {
    const id = await createEvent(conn, fieldDays(), ada, { at: at() });
    const before = await readEventState(conn, id);
    await expect(
      changeEvent(conn, id, { name: "Renamed", dateEnd: d(6, 1), place: null, onlineUrl: "https://example.org" }, by("typo"), { at: at() }),
    ).rejects.toThrow(/CHECK constraint/);
    expect(await readEventState(conn, id)).toEqual(before);
    expect(await changes()).toEqual([]);
  });

  it("rolls back a change whose first statements succeeded", async () => {
    const id = await createEvent(conn, fieldDays(), ada, { at: at() });
    const before = await readEventState(conn, id);
    // The name is updated, then the place write fails on a latitude with no longitude.
    await expect(changeEvent(conn, id, { name: "Renamed", place: { name: "X", latitude: 44 } }, by(), { at: at() })).rejects.toThrow(/CHECK constraint/);
    expect(await readEventState(conn, id)).toEqual(before);
    expect(await rows(conn, `SELECT name FROM event WHERE entity_id = ${id}`)).toEqual([["West central Idaho field days"]]);
    expect(await changes()).toEqual([]);
  });

  it("writes nothing when a place or a registration is sent again unchanged", async () => {
    const id = await createEvent(conn, { ...microscope(), place: { name: "A lab", latitude: 45.6, longitude: -122.6 } }, ada, { at: at() });
    expect(await changeEvent(conn, id, { place: { name: "A lab", latitude: 45.6, longitude: -122.6 }, registration: microscope().registration }, by(), { at: at() })).toEqual([]);
    expect(await changes()).toEqual([]);
  });

  it("allows a change to an event that is cancelled, which stays cancelled", async () => {
    const id = await createEvent(conn, oregonFieldDay(), ada, { at: at() });
    await cancelEvent(conn, id, by("no permit"), { at: at() });
    expect(await changeEvent(conn, id, { details: "Cancelled for lack of a permit." }, by(), { at: at() })).toEqual(["details"]);
    expect(await readEventState(conn, id)).toMatchObject({ details: "Cancelled for lack of a permit." });
    expect((await readEventState(conn, id))!.cancelled_at).not.toBeNull();
  });

  it("refuses a time on an event with no zone, and accepts it with a zone in the same request", async () => {
    const id = await createEvent(conn, deadline(), ada, { at: at() });
    await expect(changeEvent(conn, id, { timeStart: "09:00" }, by(), { at: at() })).rejects.toThrow(/CHECK constraint/);
    expect(await changes()).toEqual([]);
    expect(await changeEvent(conn, id, { timeStart: "09:00", timeZone: "America/Boise" }, by(), { at: at() })).toEqual(["time_start", "time_zone"]);
  });

  it("refuses a kind that is not listed, and a time zone the server does not know, when creating and when changing", async () => {
    await expect(createEvent(conn, { ...deadline(), kind: "bake sale" }, ada)).rejects.toThrow(/not an event kind/);
    await expect(createEvent(conn, { ...deadline(), timeStart: "09:00", timeZone: "Mars/Olympus" }, ada)).rejects.toThrow(/not a time zone/);
    await expect(createEvent(conn, { ...deadline(), timeStart: "09:00", timeZone: "+01:00" }, ada)).rejects.toThrow(/not a time zone/);
    expect(await rows(conn, "SELECT count(*) FROM event")).toEqual([[0n]]);
    const id = await createEvent(conn, talk(), ada, { at: at() });
    await expect(changeEvent(conn, id, { kind: "bake sale" }, by(), { at: at() })).rejects.toThrow(/not an event kind/);
    await expect(changeEvent(conn, id, { timeZone: "Mars/Olympus" }, by(), { at: at() })).rejects.toThrow(/not a time zone/);
    await expect(changeEvent(conn, id, { name: "" }, by(), { at: at() })).rejects.toThrow(/cannot be empty/);
    await expect(changeEvent(conn, id, { onlineUrl: "  " }, by(), { at: at() })).rejects.toThrow(/cannot be empty/);
    expect(await changes()).toEqual([]);
  });

  it("stores an empty series or details as none, and refuses an empty name or address on create", async () => {
    const id = await createEvent(conn, { ...talk(), series: "", details: " " }, ada, { at: at() });
    expect(await readEventState(conn, id)).toMatchObject({ series: null, details: null });
    await expect(createEvent(conn, { ...talk(), name: "" }, ada)).rejects.toThrow(/cannot be empty/);
    await expect(createEvent(conn, { ...talk(), onlineUrl: "" }, ada)).rejects.toThrow(/cannot be empty/);
    await expect(createEvent(conn, { ...talk(), place: { name: "" } }, ada)).rejects.toThrow(/cannot be empty/);
  });

  it("clears a series with an empty string, logging the change", async () => {
    const id = await createEvent(conn, talk(), ada, { at: at() });
    expect(await changeEvent(conn, id, { series: "" }, by(), { at: at() })).toEqual(["series"]);
    expect(await changes(id)).toEqual([[id, "series", "Catch a Buzz", null, ada, "form", null]]);
  });

  it("refuses a source other than form, api or load, and keeps an author that is not known as null", async () => {
    const id = await createEvent(conn, deadline(), ada, { at: at() });
    await expect(changeEvent(conn, id, { name: "X" }, { personId: ada, source: "email" as never }, { at: at() })).rejects.toThrow(/source/);
    await changeEvent(conn, id, { name: "Proposals due" }, { personId: null, source: "load", reason: "loaded from the members' list" }, { at: at() });
    expect(await changes(id)).toEqual([[id, "name", "Master Level proposals due", "Proposals due", null, "load", "loaded from the members' list"]]);
  });

  it("refuses a change from the form or the API with no author, writing nothing, and accepts one from a load", async () => {
    const id = await createEvent(conn, deadline(), ada, { at: at() });
    for (const source of ["form", "api"] as const) {
      await expect(changeEvent(conn, id, { name: "X" }, { personId: null, source } as never, { at: at() })).rejects.toThrow(/needs the person/);
      await expect(cancelEvent(conn, id, { personId: null, source } as never, { at: at() })).rejects.toThrow(/needs the person/);
    }
    expect(await changes()).toEqual([]);
    expect((await readEventState(conn, id))!.name).toBe("Master Level proposals due");
    expect((await readEventState(conn, id))!.cancelled_at).toBeNull();
    await changeEvent(conn, id, { name: "Y" }, { personId: null, source: "load" }, { at: at() });
    await cancelEvent(conn, id, { personId: null, source: "load" }, { at: at() });
    expect((await changes(id)).map(([, f, , , a, s]) => [f, a, s])).toEqual([["name", null, "load"], ["cancelled_at", null, "load"]]);
  });

  it("reads two changes to one field at one moment back in the order they were made", async () => {
    const id = await createEvent(conn, deadline(), ada, { at: at() });
    const same = at();
    await changeEvent(conn, id, { name: "First" }, by(), { at: same });
    await changeEvent(conn, id, { name: "Second" }, by(), { at: same });
    await changeEvent(conn, id, { name: "Third", details: "Late." }, by(), { at: same });
    const log = (await rows(conn, `SELECT change_id, field, old_value, new_value FROM event_change WHERE event_id = ${id} ORDER BY change_id, field`)) as [number, string, string, string][];
    expect(log.map(([, f, o, n]) => [f, o, n])).toEqual([
      ["name", "Master Level proposals due", "First"],
      ["name", "First", "Second"],
      ["details", null, "Late."],
      ["name", "Second", "Third"],
    ]);
    // One id for each request, shared by the rows of one request and increasing with the order made.
    expect(log[2]![0]).toBe(log[3]![0]);
    expect(new Set(log.map(([c]) => c)).size).toBe(3);
    expect(log[0]![0]).toBeLessThan(log[1]![0]);
    expect(log[1]![0]).toBeLessThan(log[2]![0]);
  });

  it("writes the moment of a cancellation always in one form, with milliseconds and a Z", async () => {
    const whole = await createEvent(conn, deadline(), ada, { at: at() });
    await cancelEvent(conn, whole, by(), { at: instant(2, "09:15:00.000") });
    expect((await readEventState(conn, whole))!.cancelled_at).toBe(instant(2, "09:15:00.000"));
    expect(await changes(whole)).toEqual([[whole, "cancelled_at", null, instant(2, "09:15:00.000"), ada, "form", null]]);
  });

  it("serialises calls that overlap on one shared connection, so none fails at BEGIN or joins another's transaction", async () => {
    const ids = await Promise.all([1, 2, 3, 4].map((n) => createEvent(conn, { ...deadline(), name: `Due ${n}` }, ada)));
    await Promise.all([
      ...ids.map((id, i) => changeEvent(conn, id, { name: `Renamed ${i}` }, by())),
      cancelEvent(conn, ids[0]!, by("late")),
      changeEvent(conn, ids[0]!, { details: "x" }, by()),
    ]);
    expect(await rows(conn, "SELECT count(*) FROM event")).toEqual([[4n]]);
    expect(await changes()).toHaveLength(6);
  });

  it("refuses an event that is not there", async () => {
    await expect(changeEvent(conn, 987654, { name: "Nothing" }, by())).rejects.toThrow(/no event 987654/);
    await expect(cancelEvent(conn, 987654, by())).rejects.toThrow(/no event 987654/);
  });

  it("agrees with its change log after a sequence of changes", async () => {
    const events = [talk(), microscope(), fieldDays(), oregonFieldDay(), deadline(), wholeProgram()];
    const ids: number[] = [];
    const created: EventState[] = [];
    for (const e of events) {
      const id = await createEvent(conn, e, ada, { at: at() });
      ids.push(id);
      created.push((await readEventState(conn, id))!);
    }
    const [t, m, f, o, dl, w] = ids as [number, number, number, number, number, number];
    await changeEvent(conn, o, { dateStart: d(7, 16), dateEnd: d(7, 16) }, by("smoke"), { at: at() });
    await changeEvent(conn, o, { place: { name: "A different park", latitude: 44.2, longitude: -123.2 } }, by("closed"), { at: at() });
    await changeEvent(conn, o, { dateStart: d(7, 9), dateEnd: d(7, 9), timeStart: null, timeZone: null }, by("smoke cleared"), { at: at() });
    await cancelEvent(conn, o, by("no permit"), { at: at() });
    await changeEvent(conn, t, { name: "Catch a Buzz: nests", details: "Recorded.", onlineUrl: null, kind: "outreach" }, by(), { at: at() });
    await changeEvent(conn, m, { registration: { url: "https://example.org/other" }, series: "Microscopy", collecting: true }, by("moved forms"), { at: at() });
    await changeEvent(conn, m, { registration: { url: "https://example.org/other", registerBy: d(11, 9) } }, by(), { at: at() });
    await changeEvent(conn, f, { place: null, timeStart: "08:00", timeZone: "America/Boise" }, by(), { at: at() });
    await changeEvent(conn, w, { onlineUrl: "https://example.org/zoom/new", name: "All-program meeting" }, by(), { at: at() });
    await changeEvent(conn, dl, { dateStart: d(11, 6), dateEnd: d(11, 6) }, by(), { at: at() });

    for (const [i, id] of ids.entries()) {
      // Fold the log over the event's state when it was created: it must arrive at the event's row, and each
      // change's old value must be what the field held just before it.
      const folded: EventState = { ...created[i]! };
      const log = (await rows(
        conn,
        `SELECT field, old_value, new_value FROM event_change WHERE event_id = ${id} ORDER BY change_id, field`,
      )) as [EventChangeField, string | null, string | null][];
      for (const [field, oldValue, newValue] of log) {
        expect(EVENT_CHANGE_FIELDS).toContain(field);
        expect(oldValue, `${field} of event ${id}`).toBe(folded[field]);
        expect(newValue, `${field} of event ${id}`).not.toBe(oldValue);
        folded[field] = newValue;
      }
      expect(folded).toEqual(await readEventState(conn, id));
    }
    // The sequence changed something in every one of the six events.
    const touched = (await rows(conn, "SELECT DISTINCT event_id FROM event_change")).flat();
    expect(touched.sort()).toEqual([...ids].sort());
  });

  it("leaves the change log appended to, never rewritten, by later changes", async () => {
    const id = await createEvent(conn, deadline(), ada, { at: at() });
    await changeEvent(conn, id, { name: "Proposals due (extended)" }, by(), { at: at() });
    const first = await changes(id);
    await changeEvent(conn, id, { name: "Proposals due (extended again)" }, by(), { at: at() });
    expect((await changes(id)).slice(0, 1)).toEqual(first);
    expect(await changes(id)).toHaveLength(2);
  });
});
