# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the
actual label strings used in this repo's issue tracker.

Triage runs on **GitHub Issues** — that is the surface untriaged work arrives on, from atlas
staff and volunteers. Beads carries its own machinery for the same questions (`bd ready`,
`open`/`in_progress`/`blocked`/`deferred`, priorities, dependencies), so don't graft these
labels onto beads; a bead is already triaged by the person who filed it. See
[issue-tracker.md](./issue-tracker.md).

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding
label string from this table.

`wontfix` already exists in the repo's GitHub labels. The other four do not yet; create one on
first use rather than provisioning them upfront:

```bash
gh label create needs-triage --description "Maintainer needs to evaluate this issue" --color FBCA04
```

The repo's own labels — `cross-cutting`, `decision-watch`, `ops` in beads, and GitHub's
`question`, `bug`, `enhancement`, `accessibility` — are orthogonal to triage state and are not
touched by it.

Edit the right-hand column to match whatever vocabulary you actually use.
