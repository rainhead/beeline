# ADR 0007: Authored changes are events, in a file until cutover

**Status:** accepted (2026-08-28) · sits beside
[ADR 0004](0004-correction-overlay.md), which it deliberately does not change ·
first instance is the person change log (beeline-o22) · second is the sample
change log (beeline-ewl, 2026-08-30 — see the addendum below)

## Context

`data/person-overlay.csv` records every decision staff make about a person —
account bindings, admin grants, membership, delegation, name fixes — with the
author and a reason. It is genuinely useful and was designed on purpose. It is
also **one current row per (`person_ref`, field)**: a later edit replaces the
earlier one, so latest-wins needs no timestamp arithmetic and promotion never
sees app-side duplicates.

That shape answers "who last changed this, and why". It cannot answer *when*,
*what the value was before*, *that it changed twice*, or *who changed it the
first time*. Nothing displayed it either — it is a CSV on a server's disk, and
`person_admin.granted_at`/`granted_by` were the only queryable provenance in
the store, read by nothing.

And it covers only the roster screen. Legacy promotion mints people and binds
accounts wholesale; `ingest/promote-observations.sql` rewrites
`inat_account.login` whenever iNaturalist renames an account. Both used to
leave no trace but the code that did it — which is exactly the class of change
that silently bound three people to the wrong iNat account (beeline-eft).

Two questions hide in "audit", and they want different answers:

- **Provenance** is a property of a value at rest: which source answered, and
  by what authority it holds. The project solves it in five places with
  deliberately different shapes — `sample_location.source`,
  `elevation_source_id`, `sample.atlas_assigned_by`, `determination.channel`,
  `person_admin.granted_by`. Flattening them would lose what each carries; the
  uniformity that pays there is coverage, not shape (beeline-bla).
- **Change auditing** is a sequence of events. That is this ADR, and the shape
  is already settled elsewhere: `schema/040` makes determinations append-only,
  "a correction is a newer event, never an edit".

## Decision

**Authored changes are append-only events, recorded in a file until cutover.**

- A change log is a separate artifact from the overlay beside it. The overlay
  is a set of decisions to *replay*; the log is what *happened*. Bending
  latest-wins into a history would break the merge semantics ADR 0004 exists
  for.
- **A file, not a table** — `data/person-change.csv`, `src/person-change.ts`.
  Both overlays are files because they must survive `pnpm db:build`; a history
  the blow-away erases answers "who changed this" with "nobody, we rebuilt
  it", which is the whole complaint. Unlike the overlays it is *appended* to
  rather than restated, so two processes can write it, a crash cannot truncate
  what is already there, and a malformed row can only cost itself — which is
  why it is read leniently where both overlays are read strictly.
- **Keyed by the overlay's `person_ref`**, never by `entity_id`: that is a
  per-store sequence draw a rebuild redraws, and a log keyed on it reattaches
  every entry to whoever inherited the number (beeline-ten). A rename moves
  the reference, and the log's own `display_name` entries are what follow it —
  **forward only, in file order, and never onto a name the log already knows
  somebody by**. Treating a rename as evidence that two names *are* one person
  is the tempting version and it is wrong: two people whose names swap, or a
  vacated name somebody else is later corrected into, merge into one person
  who then reports the difference between them on every pass, forever.
- **Nothing is recorded when a reference falls silent.** It looks like a
  departure and it is not one: the same silence is a name that became
  ambiguous, a rebuild that respelled it, and a store promoted from a smaller
  corpus. The version that wrote departures made affirmative false statements
  about people standing right there — including unbinding accounts they still
  held — so what the log asserts is what it observed a reference to *say*.
  That a person left is not observable from here.
- **Identity across a moved reference is recognised, never guessed.** A
  reference moves with nothing happening to the person: a namesake arriving
  pushes them off their own name onto their account, and a rebuild that
  respells `MaryJo` as `Mary Jo` moves it with no rename recorded anywhere. So
  a pass matches the store's people against the log's in order of evidence —
  the reference itself; then the name the log last recorded, because a name
  changes only when somebody changes it; then the account. **A person is
  claimed once**, and where two of them carry the same evidence neither is,
  since iteration order deciding who inherits a history is not an answer.
- **Every claim is proposed before any is granted**, because whether a claim
  is safe depends on what the *other* people in the store turn out to be.
  Deciding one person at a time is not a smaller version of this problem; it
  is a different and wrong one, and it produced a fabricated rebinding in
  every review round that looked for one.
- **What cannot be attributed is recorded as nothing, and counted.** Two
  people reaching one history claim nothing. A history whose account somebody
  else in the store now holds is nobody's to claim — because a newcomer who
  takes over the name of a person the last rebuild respelled is *identical in
  evidence* to the person whose account was taken away and who is still here,
  and one of those claims would be a fabricated unbinding of a live account.
  The cost is one-sided on purpose: an account changing hands leaves the
  history it came from unclaimable, so an ordinary shuffle records one of its
  two rebindings and stays silent about the other. Silence in an audit log is
  a gap somebody can go and look into; a fabricated rebinding is a lie about
  the one thing this log exists to make visible.
- **A name the store still carries means its person is still here**, so an
  account may only recognise somebody whose last recorded name nobody answers
  to any more — otherwise a household's login passing to the partner who does
  not hold it hands the newcomer the other's entire history and records it as
  one human being renamed into another.
- **Entries are differences, produced by comparing the store against what the
  log last said.** Not by each writer announcing its intent. So the roster
  screen, legacy promotion, observation promotion, and app boot all produce
  entries through one function reading one query, and a writer that forgets to
  record is caught by the next pass — attributed to that pass rather than to a
  person, which is what `source` says and `author` deliberately does not.
- **State, not instructions.** The log's field vocabulary is what the store
  says about a person, not what the overlay tells it to do (`home_atlas`
  becomes `membership`; a binding is `inat_user_id` and `login` separately). A
  log minted from what a writer *intended* would differ from what a rebuild
  *computes*, and report a change nobody made.

## Consequences

- **The first pass over a corpus is large and the rest are not.** 2,590
  entries for the dev store's 580 people (197 KB, 13 ms to compute); that is
  the baseline the next rebuild diffs against, so recording nothing would make
  every later run report everything. Recording every value on every rebuild —
  580 × 9 fields — was the alternative, and it drowns the signal.
- **Nobody's departure is in the log, and that is deliberate** — see above.
  What a person promotion stops minting leaves behind is their history, which
  simply stops.
- **The log is read in full on each `/people` request.** ~5 ms to parse and
  fold that baseline, inside pages that take 98 ms (the roster) and 25 ms (one
  person) end to end — acceptable at this size, and a reason to keep entries
  per-change rather than per-run.
- **Two people who swap names cannot be told apart**, and each will be
  recorded as having taken on the other's facts. Nothing keyed on a name can
  do better, and no store has ever done it. What is guaranteed instead is that
  the log *settles*: the pass after a swap records the difference once and
  then has nothing more to say, where the version that merged them on rename
  evidence never stopped.
- **A rename is always the last thing a pass says about a person.** Everything
  else it records is filed under the reference that named them when it
  started, so anything written under the old name after the rename would
  belong to a person the next reader has already moved on from — and start a
  second, half-empty record of them that every later pass re-reports in full.
  `FIELD_ORDER` is that rule; it is not cosmetic.
- **A person with no account who comes to share a display name is
  unrecordable** until one or the other is fixed, and the log says so rather
  than guessing. The roster screen refuses to write for them; a pass over the
  store counts them.
- **The default log belongs to the default database.** `pnpm legacy:promote
  scratch.duckdb` records nothing and says so, because diffing one corpus
  against another's history would report mass departures and then their mirror
  image at the next boot. `BEELINE_PERSON_CHANGES` names a log for any other
  store.
- **Promotion seeds the admin roster.** The bootstrap admins hold their rights
  through `seedAdmins` alone, never through an overlay row, so a freshly
  promoted store had nobody who could administer it until the app next booted
  — and the log recorded that gap as a revocation and the boot as a re-grant,
  a flap twice per rebuild that no person performed. The CLI now applies the
  same seed, by the same per-person rule (beeline-2c3.38), before recording.
- **This expires at cutover (December 2026)**, when the store stops being
  disposable. The natural home for authored events is then a table, and the
  file becomes its import. Designing the general mechanism now would mean
  designing around a constraint about to disappear; the per-column inventory
  of what such a mechanism would have to carry is beeline-bla, which usefully
  precedes it.

## Addendum: the sample log, and where it deliberately differs (2026-08-30)

The second instance (`src/sample-change.ts`, beeline-ewl) keeps every
mechanism above — state not instructions, differences against what the log
last said, one query for every producer, moves followed forward-only and
never onto a known reference, the unattributable recorded as nothing and
counted — and varies in three places, each a consequence of the corpus being
67,887 samples wide instead of 580 people:

- **The baseline lives in a snapshot beside the log**, not in the log.
  The person baseline is 2,590 entries read and folded on every request; the
  same trick here is a million rows. `data/sample-state.csv` is one current
  row per sample, restated wholesale by each recording pass (the overlays'
  shape), and the log gets only differences — 11.2 MB of snapshot against a
  log that grows by what actually changed. "What the log last said" *is* the
  snapshot; the consequence is that a reference falling silent is dropped
  from the snapshot, so a history interrupted by a silence reconnects only
  through the log's own recorded moves, where the person log's memory is
  unbounded.
- **The reference is a derived triple** — the primary collector as the
  person overlay names them, the sample number, the start date — carried as
  three columns because a sample number is free text no separator survives.
  Three fields can move it (the person log's one), so the writer files each
  mover under the triple as moved by the movers before it, and the fold
  stays one lookup per entry.
- **A moved reference is recognised by the observation link first**, the
  identity-once-made of beeline-oyq, then by number-and-date where the link
  cannot dispute it. Two samples colliding on one triple — a live
  `duplicate_sample_number` — are recorded as nothing and counted, since one
  reference naming two samples can only hand one the other's history.
