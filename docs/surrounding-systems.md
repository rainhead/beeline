# Surrounding systems and future scopes

What consumes Beeline's data today, what is planned to build on it, and — the reason this document exists — what each of those pulls on the core data model. Recorded from project-lead context, 2026-08-18.

## Two scopes on one domain

`melittologist.org` is the program's domain and Beeline's home, and it carries **two
scopes that should not be confused** (project lead, 2026-08-23):

- **Beeline — the tool.** Internal-facing, for people already in the program: volunteers
  fixing their own records, staff running ingestion and printing labels. Every route is
  session-gated by construction and there are no anonymous reads, because
  `sample_true_location` makes a leak a live hazard. This is the whole of what is being
  built now.
- **The public tier — the program's face.** Expected in time, not yet designed: what the
  Master Melittologist program and its member atlases are, how to learn more, and sign-up
  funnels for prospective volunteers.

The two are different surfaces that share a domain, so **"no anonymous reads" is a
statement about the tool, not about the domain** — it does not preclude a public presence
and should not be quoted as if it did.

Several bullets already listed below belong to the public tier rather than to Beeline: the
public-facing collector page, Canvas retirement's static content, and the CRM's
prospective-volunteer funnel. Naming the split is what makes those tractable.

Two seams will need deciding, neither now:

1. **Where the public site hands off to the tool.** Today that is a bare sign-in page that
   tells an unrecognised visitor only that nothing here is public (beeline-2c3.16).
2. **Whether the public tier ever reads Beeline's data.** The moment it does — an atlas
   page showing species recorded, a collector page — the per-atlas geoprivacy question
   ([questions.md](questions.md)) stops being about labels and exports and becomes about a
   web page. That is a design problem in its own right, not a routing change.

Worth noting for scale: the smaller atlases have little or no web presence of their own.
New Mexico and Oklahoma have no site at all, only an iNaturalist project; Idaho is a Google
Sites page. A public tier would be filling a real gap, not duplicating one (beeline-58b).

## Downstream consumers today

- **Ecdysis** — the entomological collections database; receives specimen records, returns expert determinations. Note the fun bit: **GBIF receives our data both directly and via Ecdysis**, so identifier stability and record identity matter doubly (GBIF dedup is imperfect; see salishsea-io's SRC-01 rule for the same problem handled deliberately).
- **GBIF** — directly, and via Ecdysis as above.
- **One-off student projects** — novel expressions of the data, worth preserving for posterity. No real requirements beyond datasets that are *convenient to access and self-explaining* — an argument for a documented, columnar export (e.g. Parquet + data dictionary) as a first-class product rather than ad-hoc CSV dumps.
- **Operational reports for landowners** — "what bees have we found on your land, on what flowers, and what else should you plant to improve bee diversity." Leans on iNaturalist floral taxonomy plus external native-plant checklists. Implies plant–pollinator association queries and some notion of a land/place scope for a report; the reports themselves have no natural home today.

## Adjacent and future scopes

- **Volunteer report / dashboard** (top priority for a future scope) — the landowner-style report addressed to the volunteer: what you've found and where, recent identifications of your bees. Goals: help volunteers see the scope of their work and feel good about it; support their learning. A previous incarnation was a very long PDF answering far too many questions; this one should be concise, interactive, always up to date. beeatlas.net has a prototype. Includes a public-facing **collector page** for other participants to view, and a way to contact the collector.
- **Identification notifications** — there is currently *no way* for a volunteer to learn their bees were identified, which often happens a year or two after collection. Part of the dashboard scope, and the sharpest single requirement it imposes on the core model (see below).
- **[Melittoflora](https://agsci.oregonstate.edu/bee-atlas/melittoflora)** — an existing explorer of plant–pollinator associations for Oregon data, maintained by others; its interface is being improved and instances deployed for other atlases' data. A consumer of specimen + host-association data.
- **Canvas retirement** — replacing the Master Melittologist program's Canvas usage with static content (11ty?) plus some replacement for its forum and "grading" mechanisms. Mostly disjoint from specimens.
- **Lightweight CRM** — centralizing communication with landowners and prospective/new volunteers, so relationship ownership survives handoffs between staff.
- **Central feed** — one place for news from OSU, news from your atlas, new identifications of your specimens, and so on.

## What these pull on the core model

1. **Determinations must be events, not current values.** Three independent scopes demand it: identification notifications ("your bee was identified" requires knowing *when* a determination arrived), the central feed (same, as a feed item), and the Ecdysis/in-app coexistence problem (concurrent channels need append-only assertions with a computed determination-of-record). One design decision satisfies all three.
2. **Collector visibility is a policy decision, not an afterthought.** Public collector pages and contact mechanisms mean the collector entity needs consent/visibility preferences from the start.
3. **Plant–pollinator associations are a query product.** Landowner reports and Melittoflora both consume specimen×host associations; the model should make that a natural join, not a report-time reconstruction.
4. **Exports are a product.** Student projects and successor systems need self-describing datasets; budget for a documented export format, not just CSV endpoints.
5. **The feed and CRM scopes suggest a generic event/notification substrate eventually** — worth keeping in mind, not worth building ahead of need.
6. **Specimen whereabouts tracking** is a named future featureset: which repository (or taxonomist's reference collection, or garage) physically holds a specimen — extending naturally to equipment and teaching supplies. The custody stages in CONTEXT.md are its foundation; don't preclude it.
