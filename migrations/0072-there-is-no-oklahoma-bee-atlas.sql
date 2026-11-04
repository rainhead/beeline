-- Migration for schema/010_people_atlases.sql: there is no Oklahoma Bee Atlas
-- (gh-251, beeline-ln8w). 0071 removed every row that named the program; this
-- deletes the program, in a transaction of its own because DuckDB will not
-- delete a referenced row in the one that removed its references.

DELETE FROM program WHERE code = 'OK';
