# Surrounding systems and future scopes

What consumes Beeline's data today, what is planned to build on it, and — the reason this document exists — what each of those pulls on the core data model. Recorded from project-lead context, 2026-08-18.

## Where Beeline stops

`melittologist.org` is the program's domain and Beeline's home, and Beeline is all it carries. Beeline is internal-facing, for people already in the program: volunteers fixing their own records, staff running ingestion and printing labels. Every route is session-gated by construction and there are no anonymous reads, because `sample_true_location` makes a leak a live hazard. This is the whole of what is being built.

The program's public face is the [OSU Extension Master Melittologist website](https://extension.oregonstate.edu/master-melittologist), which says what the program and its member atlases are and how to join one. Program staff, answering the design-system question in [issue #249](https://github.com/rainhead/beeline/issues/249) (Andony, 2026-11-03): "The entry point will continue to be the OSU Extension Master Melittologist website ... We do not envision a public-facing beeline at this time." Until 2026-11-03 this document expected a second, public scope on the same domain (project lead, 2026-08-23); that expectation is withdrawn.

Two consequences:

1. **The sign-in page is the only thing an outsider sees.** It tells an unrecognised visitor only that nothing here is public (beeline-2c3.16).
2. **Anything that would be public is out of Beeline's scope.** The items below that were once assigned to a public tier (the collector page, Canvas retirement's static content, the prospective-volunteer funnel) are each marked with where that leaves them. If a public view of Beeline's data is ever proposed, the per-atlas geoprivacy question ([questions.md](questions.md)) stops being about labels and exports and becomes about a web page, which is a design problem in its own right.

Worth noting for scale: the smaller atlases have little or no web presence of their own. New Mexico has no site at all, only an iNaturalist project; Idaho is a Google Sites page (beeline-58b).

## Downstream consumers today

- **Ecdysis** — the entomological collections database; receives specimen records, returns expert determinations — both by hand for the time being, through the staff of the atlases that use it — Washington, and probably BC; Oregon does not (2026-09-11). Note the fun bit: **GBIF receives our data both directly and via Ecdysis**, so identifier stability and record identity matter doubly (GBIF dedup is imperfect; see salishsea-io's SRC-01 rule for the same problem handled deliberately).
- **GBIF** — directly, and via Ecdysis as above. Neither path is automated from Beeline, for the time being: staff download specimen data from Beeline and upload what they choose, which is how Washington's review of volunteer determinations and Oregon's embargo are applied (Andony, 2026-09-11; Peter, 2026-09-14).
- **Existing reporting** — systems built on the legacy system's CSV dump, Andony's continuity-checking R script among them. Beeline keeps producing that format past cutover so none of them has to change at once (beeline-6q8); the pivot tables staff use for an overview of recent atlas activity get rebuilt natively afterwards (beeline-4sl).
- **One-off student projects** — novel expressions of the data, worth preserving for posterity. No real requirements beyond datasets that are *convenient to access and self-explaining* — an argument for a documented, columnar export (e.g. Parquet + data dictionary) as a first-class product rather than ad-hoc CSV dumps.
- **Operational reports for landowners** — "what bees have we found on your land, on what flowers, and what else should you plant to improve bee diversity." Leans on iNaturalist floral taxonomy plus external native-plant checklists. Implies plant–pollinator association queries and some notion of a land/place scope for a report; the reports themselves have no natural home today.

## Adjacent and future scopes

- **Volunteer report / dashboard** (top priority for a future scope) — the landowner-style report addressed to the volunteer: what you've found and where, recent identifications of your bees. Goals: help volunteers see the scope of their work and feel good about it; support their learning. A previous incarnation was a very long PDF answering far too many questions (the per-volunteer reports Melittoflora links to: [research/melittoflora.md](research/melittoflora.md#the-volunteer-reports-it-hosts)), and the BC Bee Atlas has its own staff-facing take on the same counts ([research/bc-reporting-app.md](research/bc-reporting-app.md)); this one should be concise, interactive, always up to date. beeatlas.net has a prototype. Includes a **collector page** for other participants to view, and a way to contact the collector. With no public-facing Beeline, any such page would sit behind sign-in; a page open to anyone is out of Beeline's scope.
- **Identification notifications** — until November 2026 there was *no way* for a volunteer to learn their bees were identified, which often happens a year or two after collection. The front page now lists the latest expert identifications of their bees ([the-front-page.md](architecture/the-front-page.md), beeline-xegx); telling them what is new since they last looked, or by email, is still to come. Part of the dashboard scope, and the sharpest single requirement it imposes on the core model (see below).
- **[Melittoflora](https://agsci.oregonstate.edu/bee-atlas/melittoflora)** — an existing explorer of plant–pollinator associations for Oregon data, maintained by others; its interface is being improved and instances deployed for other atlases' data. A consumer of specimen + host-association data, read today from old Beeline's occurrences file. What it is and where its redesign stands: [research/melittoflora.md](research/melittoflora.md).
- **Canvas retirement** — replacing the Master Melittologist program's Canvas usage with static content (11ty?) plus some replacement for its forum and "grading" mechanisms. Mostly disjoint from specimens. **Not for some time** (Andony, 2026-09-11): the educational content stays in Canvas, and only what people need in order to do their work moves over, at cutover (beeline-jn3). Where it lands is not decided; being for people doing the work, Beeline is a likelier home than the Extension website, whose content stays public.
- **Lightweight CRM** — centralizing communication with landowners and prospective/new volunteers, so relationship ownership survives handoffs between staff. The prospective-volunteer side starts on the Extension website, not in Beeline; whether Beeline holds any of it is undecided.
- **Central feed** — one place for news from OSU, news from your atlas, new identifications of your specimens, and so on.

## What these pull on the core model

1. **Determinations must be events, not current values.** Three independent scopes demand it: identification notifications ("your bee was identified" requires knowing *when* a determination arrived), the central feed (same, as a feed item), and the Ecdysis/in-app coexistence problem (concurrent channels need append-only assertions with a computed determination-of-record). One design decision satisfies all three.
2. **Collector visibility is a policy decision, not an afterthought.** Collector pages and contact mechanisms mean the collector entity needs consent/visibility preferences from the start.
3. **Plant–pollinator associations are a query product.** Landowner reports and Melittoflora both consume specimen×host associations; the model should make that a natural join, not a report-time reconstruction.
4. **Exports are a product.** Student projects and successor systems need self-describing datasets; budget for a documented export format, not just CSV endpoints.
5. **The feed and CRM scopes suggest a generic event/notification substrate eventually** — worth keeping in mind, not worth building ahead of need.
6. **Specimen whereabouts tracking** is a named future featureset: which repository (or taxonomist's reference collection, or garage) physically holds a specimen — extending naturally to equipment and teaching supplies. The custody stages in CONTEXT.md are its foundation; don't preclude it.
