# Copy

Part of Beeline's architecture notes; the index is in [AGENTS.md](../../AGENTS.md#architecture-overview).

Volunteer-facing copy goes through the message catalog (`src/app/messages/` — en only; those views never carry literal prose); QC self-service instructions and the glossary live there, pinned by test to the `qc_rule` seed and to the rendered anchors. Staff screens (`/jobs`, `/people`, `/design*`) are English-only: `/design*` carries literal prose, `/jobs` and `/people` read from the catalog like everything else, since there is no reason for staff copy to be worse-kept than volunteer copy — only untranslated.
