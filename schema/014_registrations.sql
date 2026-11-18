-- Registrations (beeline-w8ab). People register for Master Melittology in
-- Ideal Logic, the platform OSU Extension uses, and since 2026-11-18 Beeline
-- reads the registrations from it (src/ideal-logic.ts): to find collectors
-- it does not know, with the atlas they named, and to look up where a
-- collector's labels are mailed at the moment a print run's addresses are
-- downloaded.
--
-- The rule both tables are shaped by (Peter, 2026-11-18): an address or an
-- email address is never written to Beeline's disk. So neither table has a
-- column for one, and what Beeline keeps of a registration is the link from
-- a person to it, through which the address is fetched when it is needed.
-- This replaces the plan for Beeline to keep addresses itself (gh-34,
-- beeline-1kb.6), and with it the reason ADR 0003's private store existed.

CREATE TABLE ideal_logic_registrant (
  ideal_logic_id TEXT PRIMARY KEY,
  given_name     TEXT NOT NULL,
  family_name    TEXT NOT NULL,
  atlases        TEXT,
  inat_handle    TEXT,
  first_seen_at  TIMESTAMP NOT NULL DEFAULT current_timestamp,
  last_seen_at   TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE ideal_logic_registrant IS 'A registration in Ideal Logic, as the nightly ideal-logic-registrants job last saw it, without its email address and without its home address: those are never stored. Kept only for a registrant Beeline has a use for: one linked to a person, one who named an atlas or an iNaturalist handle, or one whose name is a person''s. A registration can be a household''s (one was made under the given name "Pete and Gretchen"), so it is not a person.';
COMMENT ON COLUMN ideal_logic_registrant.ideal_logic_id IS 'Ideal Logic''s id for the registration, such as QNN6-MX8. It names a person''s record in Ideal Logic, which keeps it as they update their details. A person with two records, under two email addresses, has two ids.';
COMMENT ON COLUMN ideal_logic_registrant.given_name IS 'The first name as registered.';
COMMENT ON COLUMN ideal_logic_registrant.family_name IS 'The last name as registered.';
COMMENT ON COLUMN ideal_logic_registrant.atlases IS 'The atlases the registrant named, as program codes joined with semicolons in the order given (OBA;WaBA); MM for "No Atlas Affiliation". NULL where the question was not answered. A suggestion for staff: person_membership holds the one program a person belongs to.';
COMMENT ON COLUMN ideal_logic_registrant.inat_handle IS 'The iNaturalist handle the registrant typed, trimmed, without a leading @. Unverified, and wrong often enough (7 of 142 on 2026-11-18: slips, display names, the word "yes") that it never links a person without the name agreeing too.';
COMMENT ON COLUMN ideal_logic_registrant.first_seen_at IS 'When a nightly fetch first returned this registration. Ideal Logic gives no registration date, so this is how Beeline tells a new registrant; every registration present on the first night shares that night''s date.';
COMMENT ON COLUMN ideal_logic_registrant.last_seen_at IS 'When a nightly fetch last returned it. One that falls behind the latest fetch is no longer in Ideal Logic.';

-- Which registration is a person's, as events (ADR 0007): a row is a
-- decision that from then on this person's registration is the one named,
-- or, with no id, that none is. The latest row per person is the answer
-- (person_registration, schema/104). Events rather than one row per person
-- updated in place, so that a link which mailed somebody's labels to the
-- wrong home can be traced to who made it and on what evidence.
--
-- Several people may share a registration: a household registers once.
-- Written to directly and not through the person overlay: the overlay
-- exists to replay decisions onto a rebuilt store, production is no longer
-- rebuilt, the overlay cannot name a person who shares a name and has no
-- account, and its curated copy is in a public repository.
CREATE TABLE person_registration_event (
  entity_id      INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  person_id     INTEGER NOT NULL REFERENCES person(entity_id),
  ideal_logic_id TEXT,
  evidence       TEXT NOT NULL CHECK (evidence IN ('register_email', 'handle', 'sign_in_email', 'staff')),
  decided_by     TEXT NOT NULL,
  decided_at     TIMESTAMP NOT NULL DEFAULT current_timestamp,
  reference      TEXT
);
COMMENT ON TABLE person_registration_event IS 'Decisions about which Ideal Logic registration is a person''s. Append-only; the latest row per person is the answer, which person_registration reads. Several people may share one registration.';
COMMENT ON COLUMN person_registration_event.entity_id IS 'Drawn from the one sequence, so a later decision has a higher id: the order decisions are read in, since two made in one transaction share a decided_at.';
COMMENT ON COLUMN person_registration_event.ideal_logic_id IS 'The registration from now on, or NULL for none: the person was unlinked.';
COMMENT ON COLUMN person_registration_event.evidence IS 'Why the two are taken for one: register_email, the registration''s email address is the one the old Beeline''s register lists against this person''s iNaturalist login, and the names agree; handle, the handle typed at registration is this person''s login, and the names agree; sign_in_email, iNaturalist reported the registration''s email address as this account''s own; staff, a member of staff decided. The kind of evidence only, never the address or handle itself.';
COMMENT ON COLUMN person_registration_event.decided_by IS 'The iNaturalist login of the member of staff, or the name of the job that linked them.';
COMMENT ON COLUMN person_registration_event.decided_at IS 'When, in UTC.';
COMMENT ON COLUMN person_registration_event.reference IS 'A pointer to the request behind a change made through the API, as api_key_use.reference: a message id or an issue link, never an address or a name.';

-- Where a person's labels go when they are not mailed (beeline-w8ab.4): some
-- collectors' labels are kept in the lab, students in a course and people who
-- collect from the lab. An instruction to staff and not an address, so it may
-- be kept; the address itself stays in Ideal Logic and is never stored.
-- Events, as above, so that a bundle of labels left in a drawer can be traced
-- to who said so. The latest row per person is the answer, which
-- person_mailing_instruction (schema/105) reads.
CREATE TABLE person_mailing_event (
  entity_id   INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  person_id   INTEGER NOT NULL REFERENCES person(entity_id),
  instruction TEXT NOT NULL CHECK (instruction IN ('mail', 'keep_in_lab')),
  note        TEXT,
  decided_by  TEXT NOT NULL,
  decided_at  TIMESTAMP NOT NULL DEFAULT current_timestamp,
  reference   TEXT
);
COMMENT ON TABLE person_mailing_event IS 'Decisions about whether a person''s printed labels are mailed or kept in the lab. Append-only; the latest row per person is the answer, which person_mailing_instruction reads. An instruction and an optional note, never an address or an email address.';
COMMENT ON COLUMN person_mailing_event.entity_id IS 'Drawn from the one sequence, so a later decision has a higher id: the order decisions are read in, since two made in one transaction share a decided_at.';
COMMENT ON COLUMN person_mailing_event.person_id IS 'The person whose labels the decision is about.';
COMMENT ON COLUMN person_mailing_event.instruction IS 'mail, the default: the labels are mailed to the address Ideal Logic holds; keep_in_lab: they are not mailed, and the address download says so in place of an address.';
COMMENT ON COLUMN person_mailing_event.note IS 'Free text from staff, at most 200 characters, such as "ENT 499, picked up in class". Free text could carry an email address or a street number, so src/mailing-instructions.ts refuses a note containing "@" or a run of five or more digits before it is stored. That refusal is what keeps an address out of this column, so a second way of writing here would need the same check.';
COMMENT ON COLUMN person_mailing_event.decided_by IS 'The iNaturalist login of the member of staff who decided.';
COMMENT ON COLUMN person_mailing_event.decided_at IS 'When, in UTC.';
COMMENT ON COLUMN person_mailing_event.reference IS 'A pointer to the request behind a change made through the API, as api_key_use.reference: a message id or an issue link, never an address or a name.';
