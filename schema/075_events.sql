-- Events: what a program puts on its calendar (beeline-2zej.1.4). Sketched in
-- docs/schema-sketch.md, "Programs, protocols and events", and described in
-- docs/architecture/events.md. This file builds only the announcement side:
-- the event, its kinds, its general place, its online link, its registration
-- link, and the log of changes made to it. The collecting event's report
-- (sites, protocols, conditions, flora, samples, attendance, photos, notes)
-- waits on Olivia (beeline-85m.2) and is built when its step arrives.
--
-- Production is migrated and never rebuilt (ADR 0006), and three things DuckDB
-- refuses shape this file, so what is here is what must be right on the first
-- day:
--   * A column that refers to another table cannot be updated on a row that
--     other tables refer to, and every event is referred to by its place, its
--     changes and later its samples. So event has no such column but its
--     program (fixed when the event is created) and its creator. Anything else
--     that would point elsewhere goes in a table beside it.
--   * A migration cannot add a column with a constraint, and cannot add or
--     change a CHECK. So the CHECKs are on the tables now, and `kind` is plain
--     text checked against event_kind by a view (event_kind_unlisted, schema/176)
--     that a test holds empty, since the list of kinds will grow.
--   * A table that refers to another cannot have a column dropped or renamed,
--     so every column here is permanent. Nothing is NOT NULL that a later step
--     might want to leave out.
-- The sketch writes `id` and `event(id)`; built, event is an entity with an
-- entity_id from the one sequence (ADR 0002) and the tables beside it are
-- keyed by it as `event_id`.

CREATE TABLE event (
  entity_id    INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  program_id   INTEGER NOT NULL REFERENCES program(entity_id),
  kind         TEXT NOT NULL,
  collecting   BOOLEAN NOT NULL,
  name         TEXT NOT NULL,
  series       TEXT,
  details      TEXT,
  date_start   DATE NOT NULL,
  date_end     DATE NOT NULL,
  time_start   TIME,
  time_end     TIME,
  time_zone    TEXT,
  cancelled_at TIMESTAMP,
  created_by   INTEGER NOT NULL REFERENCES person(entity_id),
  created_at   TIMESTAMP NOT NULL DEFAULT current_timestamp,
  CHECK (name <> ''),
  CHECK (date_end >= date_start),
  CHECK (time_start IS NULL OR time_zone IS NOT NULL),
  CHECK (time_end IS NULL OR time_start IS NOT NULL)
);
COMMENT ON TABLE event IS 'One thing a program puts on its calendar: a field day, a talk, a course, a deadline. The name is a label and never a key. This is the announcement; what was recorded at it (who came, the weather, the samples) is built separately (beeline-85m.2). Its current values are here and every later change to them is a row of event_change, written by src/event.ts, the only writer. An event has no meeting point: Beeline holds none (the program sends it to those who signed up).';
COMMENT ON COLUMN event.entity_id IS 'The event''s identity (ADR 0002), drawn from entity_id_seq.';
COMMENT ON COLUMN event.program_id IS 'Whose calendar the event is on: an atlas, or MM for the whole program. For publicity only: it never decides whose a sample is (beeline-85m.2.1). Set when the event is created and never changed, because a column that refers to another table cannot be updated on a row other tables refer to.';
COMMENT ON COLUMN event.kind IS 'An event_kind code. Plain text with no CHECK and no foreign key, so a new kind needs only a row in event_kind; event_kind_unlisted lists the events whose kind is not there, and a test holds it empty.';
COMMENT ON COLUMN event.collecting IS 'Held to collect bees, whether or not any are caught. Separate from kind because 12 of the 2026 calendar''s field days were also trainings. Only a collecting event takes samples.';
COMMENT ON COLUMN event.name IS 'What the calendar calls it, such as ''Cottonwood Canyon, 12 Jun 2027''. A label, not unique, and never empty.';
COMMENT ON COLUMN event.series IS 'The name of a series the event belongs to, such as ''Catch a Buzz''. Each session of a series is its own event: nothing stores a rule for repeating. Null when it is not in one.';
COMMENT ON COLUMN event.details IS 'Plain text a person reads: what to bring, who it is for.';
COMMENT ON COLUMN event.date_start IS 'The first day, a calendar date with no zone.';
COMMENT ON COLUMN event.date_end IS 'The last day, the same as date_start for a one-day event. Four days in west central Idaho are one event. Never before date_start.';
COMMENT ON COLUMN event.time_start IS 'The time of day it starts on each day of the event, not only the first, on the wall clock in time_zone. A TIME and not a timestamp: an appointment is a local time, not an instant. Null when no time is given. A time needs a time_zone (a CHECK).';
COMMENT ON COLUMN event.time_end IS 'The time of day it ends, on the wall clock in time_zone. Null when not given. Needs time_start.';
COMMENT ON COLUMN event.time_zone IS 'The IANA zone name the times are in, such as America/Los_Angeles. Required when time_start is given, and allowed without one, so that a deadline can say which zone its day ends in. src/event.ts refuses a name the runtime does not know.';
COMMENT ON COLUMN event.cancelled_at IS 'When the event was cancelled, in UTC. Null means not cancelled. A cancelled event keeps its row, and its event_change says who cancelled it and why.';
COMMENT ON COLUMN event.created_by IS 'The person who put the event on the calendar. Written when the event is created and never changed.';
COMMENT ON COLUMN event.created_at IS 'When the event was created, in UTC. Creating an event is not a change, so this and created_by are all the record there is of it.';

CREATE TABLE event_kind (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
COMMENT ON TABLE event_kind IS 'The kinds an event may have. event.kind is checked against it by the view event_kind_unlisted, not by a constraint, so that adding a kind is a row here and not a rebuild of event.';
COMMENT ON COLUMN event_kind.code IS 'What event.kind holds, in lower case with spaces: field day, microscope session, talk.';
COMMENT ON COLUMN event_kind.name IS 'The name a person sees.';
INSERT INTO event_kind (code, name) VALUES
  ('field day', 'Field day'),
  ('microscope session', 'Microscope session'),
  ('talk', 'Talk'),
  ('meeting', 'Meeting'),
  ('course', 'Course'),
  ('conference', 'Conference'),
  ('outreach', 'Outreach'),
  ('deadline', 'Deadline'),
  ('other', 'Other');

-- Where and how, each in a table beside the event that nothing refers to, so
-- every column stays writable. No row means none: a deadline has no place, a
-- field day has no online link.
CREATE TABLE event_place (
  event_id  INTEGER PRIMARY KEY REFERENCES event(entity_id),
  name      TEXT NOT NULL,
  latitude  DOUBLE,
  longitude DOUBLE,
  CHECK (name <> ''),
  CHECK (latitude BETWEEN -90 AND 90),
  CHECK (longitude BETWEEN -180 AND 180),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);
COMMENT ON TABLE event_place IS 'Where an event is, in general terms, which everyone signed in may see. No row means no place (a deadline, a talk on Zoom). Never a meeting point: Beeline holds none, because the program sends that only to people who signed up (beeline-2zej.1.3).';
COMMENT ON COLUMN event_place.event_id IS 'The event.';
COMMENT ON COLUMN event_place.name IS 'The place as a person would say it: ''Cottonwood Canyon State Park''. Never empty.';
COMMENT ON COLUMN event_place.latitude IS 'Decimal degrees of the place as a whole, not of a meeting point. Between -90 and 90. Both latitude and longitude are given, or neither is.';
COMMENT ON COLUMN event_place.longitude IS 'Decimal degrees of the place as a whole. Between -180 and 180. Null exactly when latitude is.';

CREATE TABLE event_online (
  event_id INTEGER PRIMARY KEY REFERENCES event(entity_id),
  url      TEXT NOT NULL,
  CHECK (url <> '')
);
COMMENT ON TABLE event_online IS 'The link to join an event held online. No row means it is not held online. Everyone signed in may see it.';
COMMENT ON COLUMN event_online.event_id IS 'The event.';
COMMENT ON COLUMN event_online.url IS 'The address to join at, as the program gave it. Never empty.';

CREATE TABLE event_registration (
  event_id    INTEGER PRIMARY KEY REFERENCES event(entity_id),
  url         TEXT NOT NULL,
  register_by DATE,
  CHECK (url <> '')
);
COMMENT ON TABLE event_registration IS 'Where to sign up for an event. Registration stays where it is today (Ideal Logic, Google Forms, a partner''s page); Beeline holds the link and not the sign-ups. No row means no registration is asked for.';
COMMENT ON COLUMN event_registration.event_id IS 'The event.';
COMMENT ON COLUMN event_registration.url IS 'The page where a person signs up. Never empty.';
COMMENT ON COLUMN event_registration.register_by IS 'The last day to sign up, a calendar date with no zone. Null when there is none.';

-- Six of 2026's 107 events were cancelled and five were moved. Each is a change
-- that says who made it and when. Append-only: nothing updates or deletes a
-- row. The event's own row holds the current values (ADR 0007, the 2026-11-19
-- addendum).
CREATE TABLE event_change (
  change_id  INTEGER NOT NULL,
  event_id   INTEGER NOT NULL REFERENCES event(entity_id),
  changed_at TIMESTAMP NOT NULL,
  author_id  INTEGER REFERENCES person(entity_id),
  source     TEXT NOT NULL,
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  reason     TEXT,
  PRIMARY KEY (change_id, field)
);
COMMENT ON TABLE event_change IS 'What was changed about an event after it was created, one row for each field changed, written by src/event.ts in the same transaction as the change itself. Append-only. Creating an event writes none. A change to the event''s place, online link or registration is logged under the field names place, online and registration, since those live in tables beside the event.';
COMMENT ON COLUMN event_change.change_id IS 'One request to change an event: every row written by one call to changeEvent or cancelEvent has the same change_id, drawn from entity_id_seq when the request is made, so it also puts changes in the order they were made (sort by it, never by changed_at alone, which two changes can share). With field it is the key. Not an entity: nothing refers to a change.';
COMMENT ON COLUMN event_change.event_id IS 'The event that changed.';
COMMENT ON COLUMN event_change.changed_at IS 'When the change was made, in UTC. The fields changed in one request share one value, and two requests can share one too: order by change_id.';
COMMENT ON COLUMN event_change.author_id IS 'The person who made the change. Null means the change was made outside Beeline and loaded afterwards, and who made it is not known.';
COMMENT ON COLUMN event_change.source IS 'Where the change was made from: form (the web form), api (the events endpoint) or load (loaded afterwards from outside Beeline). Plain text with no CHECK, because a CHECK can never be changed; src/event.ts allows these three.';
COMMENT ON COLUMN event_change.field IS 'The event column that changed (kind, collecting, name, series, details, date_start, date_end, time_start, time_end, time_zone, cancelled_at), or place, online or registration.';
COMMENT ON COLUMN event_change.old_value IS 'What it was, as text: a date as 2026-06-12, a time as 18:00:00, a flag as true or false, a moment in UTC as 2026-06-12T08:00:00.000Z, always with milliseconds and the Z. For place and registration, JSON of the row''s columns as they were when the change was made (a column added later is missing from older rows); for online, the address. Null when there was nothing.';
COMMENT ON COLUMN event_change.new_value IS 'What it became, written as old_value is. Null when it was removed.';
COMMENT ON COLUMN event_change.reason IS 'Why, in the author''s words (''smoke''). Only the person making the change knows it, so it cannot be worked out afterwards. Null when none was given.';
