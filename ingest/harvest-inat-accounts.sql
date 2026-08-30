-- Harvest the iNat account behind each linked sample's observation
-- (beeline-gju rides along).
--
-- Runs FIRST in observation promotion, ahead of minting, because minting
-- resolves an observer to a person through inat_account (beeline-oyq): an
-- account harvested on this pass is a sample minted on this pass rather than
-- on the next one, and "promotion twice mints the same count" is then a
-- property of the design instead of a property of the fixture. It converges
-- in one pass: a minted sample's observer necessarily held an account before
-- it could be minted, and a free link joins an observation to a collector the
-- harvest already had — measured, observer_collector_pair 440 -> 440 across
-- the free links.

-- The observer of a sample's evidencing observation is its collector.
-- Candidate pairs are written only when unambiguous both ways: one observer
-- account per collector across their linked samples, one collector per
-- account, and neither side already claimed. Conflicts stay for staff.
CREATE OR REPLACE TEMP TABLE observer_collector_pair AS
SELECT s.collector_id                    AS person_id,
       f.user_id,
       arg_max(f.user_login, f.inat_id)  AS login
FROM sample s
JOIN observation_field f ON f.inat_id = s.inat_observation_id
WHERE f.user_id IS NOT NULL AND f.user_login IS NOT NULL
GROUP BY s.collector_id, f.user_id;

-- Logins change; user id is the stable key. Refresh the cache.
UPDATE inat_account SET login = p.login
FROM observer_collector_pair p
WHERE inat_account.inat_user_id = p.user_id
  AND inat_account.login <> p.login;

INSERT INTO inat_account (person_id, inat_user_id, login)
SELECT p.person_id, p.user_id, p.login
FROM observer_collector_pair p
WHERE (SELECT count(*) FROM observer_collector_pair q
       WHERE q.person_id = p.person_id) = 1
  AND (SELECT count(*) FROM observer_collector_pair q
       WHERE q.user_id = p.user_id) = 1
  AND NOT EXISTS (SELECT 1 FROM inat_account a WHERE a.person_id = p.person_id)
  AND NOT EXISTS (SELECT 1 FROM inat_account a WHERE a.inat_user_id = p.user_id);
