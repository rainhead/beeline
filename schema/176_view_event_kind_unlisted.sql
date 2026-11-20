-- The events whose kind is not an event_kind (schema/075). event.kind has no
-- CHECK and no foreign key, so that a new kind is a row in event_kind and not a
-- rebuild of a table other tables refer to; this view is where the rule is
-- stated, and test/event.test.ts holds it empty.
CREATE VIEW event_kind_unlisted AS
SELECT e.entity_id AS event_id, e.kind
FROM event e
LEFT JOIN event_kind k ON k.code = e.kind
WHERE k.code IS NULL;
COMMENT ON VIEW event_kind_unlisted IS 'The events whose kind is not listed in event_kind: a misspelled kind, or a new one nobody added to the list. Empty when the store is sound; a test holds it so.';
