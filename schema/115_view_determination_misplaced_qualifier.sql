-- A qualifier that cannot mean what it says.
--
-- cf., aff. and nr. modify a species-rank assertion: "resembles Bombus
-- occidentalis", "near Lasioglossum tenax". Attached to a genus or a family
-- they assert nothing — "resembles Andrenidae" is not a claim anyone can
-- check — and on a printed label they would read as though somebody had
-- hedged a name they never made (beeline-tgu).
--
-- This is the CHECK the engine cannot hold: the rule spans two tables, since
-- "species or finer" is a fact about animal_rank rather than about the
-- determination row. So it is a view, and a test asserts it empty — the same
-- shape as sample_elevation_stale (schema/170), and for the same reason.
--
-- Legacy promotion cannot produce a row here: it sets a qualifier only where
-- a qualified epithet resolved, which is always a species. The writer this
-- guards is the determination UI, which does not exist yet (roadmap phase 6)
-- and where a taxon picker returning a genus while the qualifier control is
-- still set is exactly the mistake to expect.
CREATE VIEW determination_misplaced_qualifier AS
SELECT d.entity_id, d.specimen_id, d.qualifier, a.rank, a.scientific_name
FROM determination d
JOIN animal a ON a.entity_id = d.animal_id
JOIN animal_rank r ON r.rank = a.rank
WHERE d.qualifier IS NOT NULL
  AND r.ordinal < (SELECT ordinal FROM animal_rank WHERE rank = 'species');
