# Registrations, from Ideal Logic

Part of Beeline's architecture notes; the index is [README.md](README.md).

People register for Master Melittology in Ideal Logic, the registration platform OSU Extension uses. Since 2026-11-18 Ideal Logic gives Beeline one HTTP endpoint that returns every registrant: a name, an email address, a home address, the atlases they said they belong to, and an iNaturalist handle they typed. Beeline reads it for three things (epic beeline-w8ab): to find collectors it does not know, with their atlas; to look up where a collector's labels are mailed, at the moment staff download a print run's addresses; and, later, to email people. This reverses the decision of 2026-09-11 that Beeline would keep mailing addresses itself ([gh-34](https://github.com/rainhead/beeline/issues/34)).

## The rule: addresses never reach the disk

An address or an email address is never written to Beeline's disk (Peter, 2026-11-18). It is fetched when it is needed and dropped when the request that needed it ends. What Beeline keeps of a registration is the link from a person to it, and through that link the address is looked up each time.

The rule shapes the code in places a reader might otherwise tidy away:

- **Errors from the client carry fixed text**: a status or a count, never a piece of the response and never Ideal Logic's own message (`IdealLogicError`, `src/ideal-logic.ts`). The job framework writes an error's message into `job_run.detail`, which is in the store and every backup, and logs its stack. `JSON.parse` quotes the text it failed on, and here that text is somebody's record. A test feeds the client a response cut off in the middle of a street.
- **Neither table has a column for an address or an email address** (`schema/014`), and `src/registrations.ts` does not read those fields at all.
- **Evidence is recorded by its kind**, never by the value: `register_email`, not the address that matched.
- **Nothing is cached** between requests.

## The API

`GET https://apps.ideal-logic.com/api/f36e9b6c.json` with the key as a bearer token returns everybody in one list (826 people on 2026-11-18). The header `X-NumResults` says how many there are, and the client refuses a list of a different length, so that a change in Ideal Logic's default paging cannot make registrants look gone. Every failure is a 404.

Ideal Logic allows **100 requests a day**. The list is fetched whole, never per person. The client counts its own attempts for the Pacific day and refuses the one that would pass 60 (`RequestBudget`), which leaves the rest for a person working by hand. The count is in memory; nothing fetches at boot, so a machine restarting in a loop makes no requests. The app holds one client (`config.idealLogic`), so the nightly job and the downloads draw on one count. The key is the secret `IDEAL_LOGIC_KEY`; without it the job fetches nothing and says so.

Two things the feed lacks. It has a field for a US state and none for a province or a country, so the province of a Canadian address is read off the first letter of its postal code (`provinceFromPostalCode`; X is shared by two territories and names neither). Ideal Logic has been asked to add both (beeline-w8ab.5). And it has no registration date, which Beeline does not need: `first_seen_at` is the night Beeline first saw a registration, and that tells a new registrant from then on.

## Which registration is whose

`person_registration_event` (`schema/014`) holds decisions, and the latest one about a person is the answer (`person_registration`, `schema/104`). They are events so that a link that mailed labels to the wrong home can be traced to who made it and on what evidence.

- **Several people can share a registration.** A couple registered once, under the first name "Pete and Gretchen".
- **The link is not in the person overlay.** The overlay exists to replay decisions onto a rebuilt store, and production is no longer rebuilt. It also cannot name a person who shares a name and has no account, and its curated copy is in this public repository.
- **Whether an Ideal Logic id names a person for good is not known.** If people register again each year, a link would go on pointing at an old address. The evidence so far is against that: five names were registered twice on 2026-11-18, each pair under two different email addresses and none with two different addresses, which is what a record per account looks like. It is still a question for OSU (beeline-w8ab.5).

The handle a registrant types is the weakest evidence there is: of 142, seven were not the login Beeline holds for that person (typing slips, a display name, the word "yes"). So nothing links on a handle alone, and nothing links on a name alone, since 386 registrants have no relation to Beeline and any of them may share a collector's name. Three ways a link is made:

1. **The old register's email addresses**, once, by hand (`pnpm ideal-logic:link-register`, `src/link-register-emails.ts`). The registration's email address must be in the old Beeline's register against exactly one login, exactly one person must hold that login, and the full name must agree. It linked 259 of 593 people on 2026-11-18. It runs on a machine that holds the register and sends each link through the API; it is not part of the nightly job, because the register is a frozen file that holds addresses.
2. **The nightly job**, where the typed handle is the login of exactly one person and the full name is that person's (20 more people). It never links a person a decision has already been made about, so a person staff unlinked stays unlinked.
3. **Staff**, for everybody else, through `POST /api/v1/people/<id>/registration` ([The API and its keys](the-api-and-its-keys.md)) until the page for it exists (beeline-w8ab.2).

The full name must agree, and not only the family name, because of households: two people who registered separately can share one login, which only one of them holds.

## The nightly job

`ideal-logic-registrants` runs at 1am (`src/app/jobs/registry.ts`). It makes one request and keeps a row in `ideal_logic_registrant` for each registration Beeline has a use for: one linked to a person, one that names an atlas or a handle, or one whose name is a person's. The rest have no relation to Beeline, and their names do not belong in every backup. A registration that has left Ideal Logic keeps its row, and its `last_seen_at` falls behind.

A failed run is retried every 15 minutes until 5am, like every night job, which is about a dozen requests at worst.

## Not built yet

- The download of a print run's addresses (beeline-w8ab.3).
- The page where staff place the registrants nobody is linked to (beeline-w8ab.2).
- Linking at sign-in: iNaturalist reports the signed-in account's own confirmed email address, which could be compared with the registration's. How to compare without storing either is undecided.
- "Keep in lab" and other instructions not to mail (beeline-w8ab.4), and email (beeline-w8ab.6).
