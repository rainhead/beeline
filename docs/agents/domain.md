# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase.

## Before exploring, read these

- **[`CONTEXT.md`](../../CONTEXT.md)** at the repo root — the domain glossary.
- **[`docs/adr/`](../adr/)** — read the ADRs that touch the area you're about to work in.

This is a **single-context** repo: one `CONTEXT.md`, one `docs/adr/`, both at the root. There is
no `CONTEXT-MAP.md` and no per-package context.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest
creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get
resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-duckdb-first-with-portable-sql.md
│   ├── 0002-entities.md
│   └── …
└── src/
```

ADRs are numbered sequentially from `0001`; a new one takes the next free number.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a
test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary
explicitly avoids — it says which ones and why (a *specimen* is not an *occurrence* outside
exports; *membership* is not *administration*).

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing
language the project doesn't use (reconsider) or there's a real gap (note it for
`/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently
overriding:

> _Contradicts [ADR 0001](../adr/0001-duckdb-first-with-portable-sql.md) (DuckDB behind
> dialect-neutral SQL) — but worth reopening because…_
