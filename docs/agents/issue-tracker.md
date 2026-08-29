# Issue tracker: GitHub Issues and Beads

This repo tracks work in **two** places, split by audience — the split is stated in
[README.md](../../README.md#ways-of-working) and this file is its operational form.

- **[GitHub Issues](https://github.com/rainhead/beeline/issues)** — anything discussion-shaped,
  and customer requests and bugs. It is the venue where atlas staff (Andony, Arthur) can
  participate, so anything a non-developer might read, answer, or raise belongs here.
- **[Beads](https://github.com/steveyegge/beads) (`bd`, in-repo)** — everything else:
  fine-grained work items, interaction between workstreams, dependency tracking.

**Which one to use.** Ask who else needs to read it. If the answer includes someone outside
the codebase — a question for staff, a bug a volunteer hit, a request from an atlas — it is a
GitHub issue. If it is engineering work whose whole audience is whoever picks it up next, it is
a bead. **Bugs split on the same test rather than landing wholesale in either tracker**: one a
volunteer or staff member reported is a GitHub issue, because the reporter needs to follow it;
one found while working is a bead (`beeline-d34`, `beeline-oyq`). Where this file and the
managed Beads block below it disagree — that block says to use `bd` for *all* task tracking —
this file wins, and README.md is the authority behind it. When a GitHub discussion resolves into implementation work, the outcome becomes one or
more beads that reference the issue by URL; the GitHub issue stays as the conversation.

The repo is public ([memory](https://github.com/rainhead/beeline)): no volunteer PII in either
tracker.

## Beads conventions

Run `bd prime` for the full workflow context before starting.

- **Create**: `bd create "<title>" -d "<description>" -t <type> -p <P0-P4> -l <labels>`. Use
  `--body-file -` with a heredoc for multi-line bodies. Types: `task` (default), `bug`,
  `feature`, `chore`, `epic`, `decision`, `spike`, `story`.
- **Create a child**: `bd create "<title>" --parent <id>` — children get dotted IDs
  (`beeline-1kb.1`), which is how this repo decomposes epics.
- **Read**: `bd show <id>` (`--json --include-comments` for the full body and conversation,
  `--children` for its children).
- **List**: `bd list --status open --json`, with `--label`, `--type`, `--assignee`, `--limit 0`.
  `bd ready` lists what is unblocked and available.
- **Search**: `bd search "<text>"`; `bd query` for the query language.
- **Comment**: `bd comment <id> "<text>"`; read back with `bd comments <id>`.
- **Labels**: `bd update <id> --add-label <label>` / `--remove-label <label>`.
- **Claim**: `bd update <id> --claim`.
- **Close**: `bd close <id> -r "<reason>"`.
- **Dependencies**: `bd dep add <blocked> <blocker>` (or `bd dep <blocker> --blocks <blocked>`),
  `bd dep list <id>`, `bd dep tree <id>`.

IDs are prefixed `beeline-` and are stable. `.beads/issues.jsonl` is a passive export, never the
source of truth — don't hand-edit it. `bd dolt push` syncs the Dolt store over `refs/dolt/data`
on the git remote, and the export it changes is committed straight to `main` — the one thing
exempt from this repo's pull-request rule.

## GitHub conventions

Use the `gh` CLI; it infers the repo from `git remote -v` inside a clone.

- **Create**: `gh issue create --title "..." --body "..."` (heredoc for multi-line bodies).
- **Read**: `gh issue view <number> --comments`.
- **List**: `gh issue list --state open --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`,
  with `--label` / `--state` filters. `--limit` is not optional: without it `gh` returns the
  first 30 and says nothing about the rest, so a triage pass would silently skip issues. If a
  listing ever comes back at the limit, raise it rather than assuming that was all of them.
- **Comment**: `gh issue comment <number> --body "..."` — append 🤖 to anything an agent authors,
  here and in PR comments.
- **Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`.

Prose written here is read by atlas staff, not only by developers: plain words, no bead IDs
without saying what they are, and no assumption the reader has the repo checked out.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature
requests; `/triage` reads this flag.)_

Note that PRs are reviewed by CodeRabbit and are the way all code lands
([AGENTS.md](../../AGENTS.md#git-authority)); that is a review surface, not a request one.

## When a skill says "publish to the issue tracker"

Apply the audience test above. Discussion-shaped or customer-facing → `gh issue create`.
Engineering work → `bd create`. A spec/PRD is a bead, typically type `epic` or `feature`, with
implementation tickets created as `--parent` children of it.

## When a skill says "fetch the relevant ticket"

The user will normally pass the handle directly, and its shape says which tracker: a bead ID
(`beeline-o22`) → `bd show <id> --json --include-comments`; a number or `#17` →
`gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`, and always in beads — a wayfinding map is engineering navigation, not a
staff-facing conversation. The **map** is a bead with **child** beads as tickets.

- **Map**: `bd create "<effort>" -t epic -l wayfinder:map`, holding the
  Notes / Decisions-so-far / Fog body.
- **Child ticket**: `bd create "<question>" --parent <map-id> -l wayfinder:<type>`, where
  `<type>` is `research` / `prototype` / `grilling` / `task`. Order is the dotted child number.
- **Blocking**: `bd dep add <child> <blocker>` — native beads dependencies. A ticket is unblocked
  when every blocker is closed.
- **Frontier query**: `bd ready --parent <map-id> --json` — `--parent` filters to descendants of
  that bead, so without it the frontier picks up ready work from the rest of the store. Lowest
  child number wins.
- **Claim**: `bd update <id> --claim` — the session's first write.
- **Resolve**: `bd comment <id> "<answer>"`, then `bd close <id> -r "<gist>"`, then append a
  context pointer to the map's Decisions-so-far (`bd update <map-id> --append-notes "..."`).
