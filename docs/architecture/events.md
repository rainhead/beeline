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

Production is migrated and never rebuilt (ADR 0006), and DuckDB refuses three things that decide the shape. They were confirmed on DuckDB 2.0.0 on 2026-11-19.

1. **A column that refers to another table cannot be updated on a row that other tables refer to.** Every event is referred to by its place and its changes, and later by samples and notes. So `event` has no such column except its program and its creator, which are written when the event is created and never changed. An event's program cannot be moved to another program; a mistake there is fixed by cancelling the event and creating another. Anything else an event will point at (a site, a protocol) goes in a table beside it, as a sample's atlas does. `test/event.test.ts` pins this refusal on the real table.
2. **A migration cannot add a column with a REFERENCES, and cannot add or change a CHECK.** `test/event.test.ts` pins the first half, a refused `ALTER TABLE event ADD COLUMN ... REFERENCES`. The second half is the finding recorded in ADR 0006 and is not tested here. So every CHECK is on its table from the start, and `kind` is plain text with no CHECK and no foreign key, because the list of kinds will grow and rebuilding `event` would mean rebuilding every table that refers to it. The rule that a kind is listed is the view `event_kind_unlisted`, which `test/event.test.ts` holds empty over the synthetic events. Adding a kind is one row in `event_kind`. For the same reason `event_change.source` has no CHECK either; `src/event.ts` allows `form`, `api` and `load`.
3. **A table that refers to another cannot have a column dropped or renamed.** This is the finding recorded in `schema/030` and ADR 0006, and is not tested here. Every column is permanent, so nothing is NOT NULL that a later step might want to leave out.

The CHECKs are these. On `event`: the name is not empty; the end date is not before the start date; a start time comes with a time zone (a zone may stand without a time, so that a deadline can say which zone its day ends in); an end time needs a start time. On `event_place`: the name is not empty, the latitude is between -90 and 90, the longitude between -180 and 180 (a null passes, as on `sample_location`), and a latitude comes with a longitude. On `event_online` and `event_registration`: the address is not empty.

`event_place` is the general location only: a name and, if known, a latitude and longitude of the place as a whole. Beeline holds no meeting point. The program sends it only to people who signed up, so that nobody arrives who did not (beeline-2zej.1.3).

## Dates and times

An event is an appointment, not an instant. `date_start` and `date_end` are a local date range (a four-day event is one event, and `date_end` equals `date_start` for a one-day event). `time_start` and `time_end` are a time of day on the wall clock, on each day of the event, and `time_zone` is the IANA zone name they are in. They are not UTC. Only `created_at`, `cancelled_at` and `event_change.changed_at` are instants, and those are UTC, as everywhere in the store.

`src/event.ts` refuses a time zone that is not an IANA name the server's runtime knows: it must look like a name (`America/Los_Angeles`, `UTC`, not an offset such as `+01:00`) and `Intl.DateTimeFormat` must accept it. The runtime matches names without regard to case, so `america/los_angeles` passes as written; the module does not correct it.

kysely-duckdb does not read these two types well. Checked on 2026-11-19: it writes a string into a DATE or TIME correctly, but reads a TIME back as a `DuckDBTimeValue` object, which is not a string, and reads a DATE as a JavaScript Date at midnight in the machine's zone, which reads as the wrong day wherever it is formatted as UTC. The smallest workaround is the one in `src/event.ts`: it uses the raw connection, writes `$1::DATE` and `$1::TIME` from strings, and reads with `CAST(... AS TEXT)`. `src/model.ts` types these columns as strings for that reason, and a future page that selects them through Kysely must cast them in SQL too.

## One writer, and the change log

`src/event.ts` is the only code that writes these tables. The form and the API will both call it, so that nothing can change an event without leaving a change behind. The reasoning is the fourth addendum to [ADR 0007](../adr/0007-authored-changes-are-events.md) and is not repeated here.

- `createEvent` writes the event and its optional place, online link and registration in one transaction, and writes no change. The event's `created_by` and `created_at` are the record of it.
- `changeEvent` takes the fields to change (a field left out is left alone, and `null` clears one that may be empty). In one transaction it writes the event and one `event_change` row for each field that changed, with the author, the source, and the author's reason. The dates and times are checked after the whole request is applied, so moving the start and the end together is one request. A time on an event with no zone is refused unless the request sets the zone too. A cancelled event may still be changed (its details, say); it stays cancelled, because `changeEvent` does not touch `cancelled_at`.
- `cancelEvent` sets `cancelled_at` and writes one change. A cancelled event keeps its row. Cancelling twice is refused, so the first cancellation stays on record. Taking a cancellation back is not built.

Both functions refuse, before writing anything: a kind that is not in `event_kind` (looked up inside the transaction, since `kind` has no constraint), a time zone the runtime does not know, an empty name, place name or address, and a source other than `form`, `api` or `load`. An empty series or details is stored as none, since this module is the only writer.

**The log.** A change is found by reading every logged field of the event as text before the write and again after it, and comparing. So the log says what the store now holds, however the caller spelled a value (`9:30` or `09:30:00`), and a request that changes nothing writes nothing. Each request that changes something draws one `change_id` from `entity_id_seq`; all its rows share it, and with `field` it is the key. A change is not an entity, since nothing refers to it: the id is there to name the request and to order requests. Two requests can share one `changed_at`, so **read the log in order by `change_id`, never by `changed_at` alone**. `author_id` is null for a change made outside Beeline and loaded afterwards, when who made it is not known (`source` is then `load`); `event.created_by` is never null.

**How a value is written in the log.** A date is `2026-06-12`, a time `18:00:00`, a flag `true` or `false`, and a moment (only `cancelled_at`) is always `2026-06-12T08:00:00.000Z`: UTC, with milliseconds and the Z. The online link is its address. The place and the registration live in tables beside the event, so a change to either is logged under the field name `place` or `registration`, as JSON of the row's columns with the keys in this order: `{"name":...,"latitude":...,"longitude":...}` and `{"url":...,"register_by":"2026-11-08" or null}`. When there is no row the value is null. These forms are the columns as they were when the change was made. A column added to one of those tables later is missing from older log rows, and the first time the place or registration is written after that, the comparison sees a difference that nobody made and logs a change. The migration that adds such a column should say so.

**Concurrency.** The app shares one DuckDB connection per kind of work, and its transactions are raw `BEGIN` and `COMMIT`, so two overlapping calls on one connection would fail at `BEGIN` ("cannot start a transaction within a transaction") or pull one call's statements into the other's transaction (the hazard described in `src/print-run.ts`). So every write in `src/event.ts` runs behind the same in-process lock that the trap-sample and print-run writers use, `withPrintRunLock`, and takes it itself; a caller does not. The lock is not re-entrant, so code already inside it must not call these functions. The caller still passes the connection. Behind the lock, a write from another connection to the same event can still lose a DuckDB write conflict, and the caller may retry with `src/write-conflict.ts`. A failed `ROLLBACK` does not replace the error that caused it.

The price of one writer, stated in ADR 0007, is that a change made to these tables by anything else leaves no trace. The guard is `test/event.test.ts`, which folds each event's log over the state it was created in, in `change_id` order, and expects the event's row, and expects each change's old value to be what the field held just before it.

## Not built

`site`, `event_site`, `event_protocol`, `event_conditions`, `event_flora`, `sample_event`, `sample_submitted_for`, `event_attendance`, `event_photo` and `event_note` wait on Olivia (beeline-85m.2). Loading the 2026 events, which need an author and a time for changes already made, is beeline-2zej.1.8 (the `load` source and a null author are for that). A key for each event of a loader's own, so that running it twice does not make each event twice, is not here either.

Tests: `test/event.test.ts` (the events, the CHECKs, the writer's refusals, the change log, the lock) and `test/event-migration.test.ts` (that the migration gives a deployed store the same tables, comments and constraints as a fresh build).
