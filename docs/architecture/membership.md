# Membership

Part of Beeline's architecture notes; the index is in [AGENTS.md](../../AGENTS.md#architecture-overview).

Membership has two shapes and one absence: a member atlas, or the umbrella program itself with no atlas — Master Melittology membership without a member atlas is real, so absence is reserved for "nobody has asked" (beeline-lcl; the overlay field stays `home_atlas` and takes `program` as a value). Samples answer the same question geographically through `atlas_region`, where a row with a NULL atlas says "known region, no atlas covers it" and no row at all is what `qc_rule_place_unrecognised` fires on.
