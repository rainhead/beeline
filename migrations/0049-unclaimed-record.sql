-- Migration for schema/108_views_minting.sql (beeline-e85): each unresolved
-- collection record with the program whose region it fell in. The reasoning
-- is in schema/108. A new view over existing ones, so this is the schema's
-- own DDL.
CREATE VIEW unclaimed_record AS
SELECT u.inat_id, u.user_id, u.user_login, u.sample_number, u.specimen_count, u.observed_on,
       pl.state_province, pl.county_name,
       pr.entity_id AS program_id,
       pr.code      AS program_code
FROM observation_sample_unresolved u
LEFT JOIN observation_place pl ON pl.inat_id = u.inat_id
LEFT JOIN atlas_region reg ON reg.state_province = pl.state_province
LEFT JOIN atlas a ON a.entity_id = reg.atlas_id
JOIN program pr ON pr.code = coalesce(a.code, 'MM');
COMMENT ON VIEW unclaimed_record IS 'An unresolved collection record (observation_sample_unresolved) with the program whose region it fell in: the atlas covering its state, or Master Melittology outside every atlas and where the state is unknown. Read by the unclaimed screen (beeline-e85), which groups observers by it.';
