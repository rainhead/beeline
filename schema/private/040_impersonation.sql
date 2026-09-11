-- Every time a staff member looked at Beeline as somebody else (beeline-jjt).
-- Re-appliable on its own, like the tables beside it.
--
-- Impersonation is a staff member deliberately reading another person's
-- records, which is worth a trace even in a high-trust program: not because
-- anyone is suspected, but because "who looked at my records" is a question
-- a volunteer is entitled to ask and the answer should not be "nobody knows".
-- The row records the fact, not what was read: every page under the switch
-- is one the impersonated person could open themselves.

CREATE TABLE impersonation (
  admin_login  TEXT NOT NULL,
  person_name  TEXT NOT NULL,
  started_at   TIMESTAMP NOT NULL DEFAULT current_timestamp
);
COMMENT ON TABLE impersonation IS 'One row per time a staff member switched into viewing Beeline as somebody else (beeline-jjt). Append-only; nothing reads it yet beyond a hand query, and nothing purges it. In the private store because it is about people rather than about records, the same reason person_activity is.';
COMMENT ON COLUMN impersonation.admin_login IS 'The staff member''s iNaturalist login at the time — the same attribution the corrections overlay and the change logs use for an author. A login can be renamed upstream, so this is a name rather than a key, which is what an audit line wants: who, as they were known then.';
COMMENT ON COLUMN impersonation.person_name IS 'Whose view was taken, by display name — the way the switch cookie and the overlay name a person, and never person.entity_id, which a rebuild redraws (beeline-ten).';
COMMENT ON COLUMN impersonation.started_at IS 'When the switch was turned on. There is no ended_at: the switch ends when the cookie is cleared or the session ends, and neither reliably passes through a route that could record it.';
