-- Migration for schema/010: the comment on program_lead said that leading a
-- program grants no access. Since beeline-q8di a lead may open their
-- program's Data tab, whose files hold collectors' names and true
-- coordinates. Only the comment changes; no row does.
COMMENT ON TABLE program_lead IS 'person_id leads program_id: the program''s work is theirs to take up, and its questions theirs to answer. Set from /people through the person overlay (field leads). A lead may open the program''s Data tab, whose files hold collectors'' names and true coordinates; nothing else follows from leading.';
