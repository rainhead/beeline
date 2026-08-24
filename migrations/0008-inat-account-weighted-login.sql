-- Correction for ingest/promote-legacy.sql (beeline-eft).
--
-- Unlike its neighbours this migration carries no schema delta — the rule it
-- corrects lives in promotion, not in schema/*.sql, and a rebuilt store gets
-- the right answer from the rewritten query. The sandbox cannot be rebuilt,
-- and it is the store people sign in to, so the rows have to be corrected in
-- place. `db:migrate --check` will show no difference either way.
--
-- The old rule discarded any login that appeared on more than one person's
-- records as ambiguous. Data entry makes that the normal state of a busy
-- volunteer's login, so the busiest — most trustworthy — logins were thrown
-- out and the person was left bound to whatever stray survived, chosen
-- alphabetically. Three people ended up on the wrong iNat account. Each
-- replacement below was checked against the iNat API by hand on 2026-08-24.
--
-- Keyed on inat_user_id, not person_id: entity_ids are per-store sequence
-- draws and the sandbox does not share dev's.
--
-- No row already holds any of the three replacement ids, so these updates
-- cannot collide with inat_account's UNIQUE (inat_user_id).

-- 1542612 'andonymelathopoulos' has no display name and 2 observations; it is
-- not Andony. It won on ONE legacy record, beating 'amelathopoulos' — 429964,
-- 'Andony Melathopoulos', ~1,900 observations, an iNat app owner — which
-- carries 3,019 of his records but also 151 of Emily Carlson's, entered by
-- him. He is the program lead and could not sign in at all.
UPDATE inat_account SET inat_user_id = 429964, login = 'amelathopoulos'
WHERE inat_user_id = 1542612;

-- 12665 'hexapod' is Damion Coe, a different and active iNat user, who would
-- have received Pat Wheeler's person record and samples on sign-in. It won on
-- 4 records against 'patwheeler' (793138) on 886.
UPDATE inat_account SET inat_user_id = 793138, login = 'patwheeler'
WHERE inat_user_id = 12665;

-- Same login, wrong id: the legacy rows carry both 5212917 and 5212918 for
-- 'mjmarshall_pdx', and the old max(uid) tiebreak took the larger. 5212917 is
-- Michelle Marshall; 5212918 is 'brocklwest', an empty account.
UPDATE inat_account SET inat_user_id = 5212917
WHERE inat_user_id = 5212918;
