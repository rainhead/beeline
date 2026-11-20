# Events

Part of Beeline's architecture notes; the index is [README.md](README.md).

An event is one thing a program puts on its calendar: a field day, a talk, a course, a deadline. This area is the announcement side only: what a calendar needs, which is whose event it is, what kind, when, where, and how to sign up. What was recorded at an event (who came, the weather, the plants in bloom, the samples) is the report side, and waits on Olivia's answers (beeline-85m.2). The design is in [the schema sketch](../schema-sketch.md) under "Programs, protocols and events"; this file says what was built from it and what differs. Built in beeline-2zej.1.4. There is no page, form or API endpoint yet (beeline-2zej.1.6, .1.7 and .1.8).

## The tables

`schema/075_events.sql` builds six tables and `schema/176_view_event_kind_unlisted.sql` one view. `migrations/0112-events.sql` brings a deployed store to the same shape.

- `event` is an entity: its key is `entity_id`, drawn from `entity_id_seq` (ADR 0002). The sketch writes `id`; built tables follow the repository's spelling, and the tables beside `event` name it `event_id`.
- `event_kind` lists the kinds: field day, microscope session, talk, meeting, course, conference, outreach, deadline and other.
- `event_place`, `event_online` and `event_registration` each hold one optional row for an event. No row means none: a deadline has no place and a field day has no online link.
- `event_change` is the log of changes, one row for each field changed.
- `event_kind_unlisted` lists the events whose kind is not in `event_kind`.

Every table and column carries a `COMMENT ON`, which is the place to read what a column means.

## What is fixed on the first day, and why

Production is migrated and never rebuilt (ADR 0006), and DuckDB refuses three things that decide the shape. They were confirmed on DuckDB 2.0.0 when this was built, and `test/event.test.ts` pins the first two.

1. **A column that refers to another table cannot be updated on a row that other tables refer to.** Every event is referred to by its place and its changes, and later by samples and notes. So `event` has no such column except its program and its creator, which are written when the event is created and never changed. An event's program cannot be moved to another program; a mistake there is fixed by cancelling the event and creating another. Anything else an event will point at (a site, a protocol) goes in a table beside it, as a sample's atlas does.
2. **A migration cannot add a column with a REFERENCES, and cannot add or change a CHECK.** So the three CHECKs are on `event` from the start (the end date is not before the start date, a start time comes with a time zone and only then, an end time needs a start time), and so is the one on `event_place` (a latitude comes with a longitude). `kind` is plain text with no CHECK and no foreign key, because the list of kinds will grow, and rebuilding `event` would mean rebuilding every table that refers to it. The rule that a kind is listed is the view `event_kind_unlisted`, which `test/event.test.ts` holds empty over the synthetic events. Adding a kind is one row in `event_kind`.
3. **A table that refers to another cannot have a column dropped or renamed.** Every column here is permanent, so nothing is NOT NULL that a later step might want to leave out.

`event_place` is the general location only: a name and, if known, a latitude and longitude of the place as a whole. Beeline holds no meeting point. The program sends it only to people who signed up, so that nobody arrives who did not (beeline-2zej.1.3).

## Dates and times

An event is an appointment, not an instant. `date_start` and `date_end` are a local date range (a four-day event is one event, and `date_end` equals `date_start` for a one-day event). `time_start` and `time_end` are a time of day on the wall clock, on each day of the event, and `time_zone` is the IANA zone name they are in. They are not UTC. Only `created_at`, `cancelled_at` and `event_change.changed_at` are instants, and those are UTC, as everywhere in the store.

kysely-duckdb does not read these two types well. Checked on 2026-11-20: it writes a string into a DATE or TIME correctly, but reads a TIME back as a `DuckDBTimeValue` object, which is not a string, and reads a DATE as a JavaScript Date at midnight in the machine's zone, which reads as the wrong day wherever it is formatted as UTC. The smallest workaround is the one in `src/event.ts`: it uses the raw connection, writes `$1::DATE` and `$1::TIME` from strings, and reads with `CAST(... AS TEXT)`. `src/model.ts` types these columns as strings for that reason, and a future page that selects them through Kysely must cast them in SQL too.

## One writer, and the change log

`src/event.ts` is the only code that writes these tables. The form and the API will both call it, so that nothing can change an event without leaving a change behind. The reasoning is the fourth addendum to [ADR 0007](../adr/0007-authored-changes-are-events.md) and is not repeated here.

- `createEvent` writes the event and its optional place, online link and registration in one transaction, and writes no change. The event's `created_by` and `created_at` are the record of it.
- `changeEvent` takes the fields to change (a field left out is left alone, and `null` clears one that may be empty). In one transaction it writes the event and one `event_change` row for each field that changed, with the author, the source (`form` or `api`) and the author's reason. The dates and times are checked after the whole request is applied, so moving the start and the end together is one request.
- `cancelEvent` sets `cancelled_at` and writes one change. A cancelled event keeps its row. Cancelling twice is refused, so the first cancellation stays on record. Taking a cancellation back is not built.

A change is found by reading every logged field of the event as text before the write and again after it, and comparing. So the log says what the store now holds, however the caller spelled a value (`9:30` or `09:30:00`), and a request that changes nothing writes nothing. A date is logged as `2026-06-12`, a time as `18:00:00`, a flag as `true` or `false`, and a moment as `2026-06-12 08:00:00` in UTC. The place and the registration live in tables beside the event, so a change to either is logged under the field name `place` or `registration`, as JSON of the row's columns, and a change to the online link under `online`, as the address. All the fields changed in one request share one `changed_at`.

The price of one writer, stated in ADR 0007, is that a change made to these tables by anything else leaves no trace. The guard is `test/event.test.ts`, which folds each event's log over the state it was created in and expects the event's row, and expects each change's old value to be what the field held just before it.

A concurrent write to one event fails, as any DuckDB write conflict does; the caller may retry with `src/write-conflict.ts`.

## Not built

`site`, `event_site`, `event_protocol`, `event_conditions`, `event_flora`, `sample_event`, `sample_submitted_for`, `event_attendance`, `event_photo` and `event_note` wait on Olivia (beeline-85m.2). Loading the 2026 events, which need an author and a time for changes already made, is beeline-2zej.1.8. A key for each event of a loader's own, so that running it twice does not make each event twice, is not here either.

Tests: `test/event.test.ts` (the events, the CHECKs, the change log) and `test/event-migration.test.ts` (that the migration gives a deployed store the same tables, comments and constraints as a fresh build).
