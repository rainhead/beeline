-- Migration for the comment on program_lead (schema/010): a program's lead may
-- now enter samples directly rather than through iNaturalist (Peter,
-- 2026-11-24). The rule itself is in src/trap-sample.ts; only the comment
-- changes in the store.
COMMENT ON TABLE program_lead IS 'person_id leads program_id: the program''s work is theirs to take up, and its questions theirs to answer. Set from /people through the person overlay (field leads). A lead may open the program''s Data tab, whose files hold collectors'' names and true coordinates, and may enter samples directly rather than through iNaturalist; nothing else follows from leading.';
