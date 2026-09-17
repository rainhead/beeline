# Olivia's BLM documents: what they add, confirm, and correct

Read 2026-09-17 against [CONTEXT.md](../../CONTEXT.md) (Programs and governance, Sample, Collecting event, Protocol, Identifiers), the BLM section of [questions.md](../questions.md), and [field-data-entry.md](field-data-entry.md). Page numbers are the PDFs' own; the protocol's printed folio is one less than its PDF page.

## What the documents are

- **Narrative** — *Building a Standardized Bee Monitoring Protocol: Design, Testing, and Implementation for BLM Lands*, 32 pp., undated, covering 2021–2026 (narrative p. 9): why each method was chosen, the pilots, the database in outline. A complete draft; "Revision following peer review" is a listed activity.
- **Protocol** — *Bee Monitoring Protocol for Bureau of Land Management Lands*, dated 1 January 2026, 214 pp.: the three tiers, site selection, forms, Kobo, pinning, labelling, shipping, keys. Visibly a draft — a dead bookmark (p. 9), a "(source?)" (p. 167), a Table 3 cited but absent (p. 75), figure numbers that disagree (pp. 72, 92–93).
- Both are written for BLM field offices, "wildlife biologists, botanists, ecologists, technicians, and partner organizations" (protocol p. 10); Olivia's own surveys are one implementation among the pilots.

## What they confirm

- Pan traps out for six hours, start and end both recorded (protocol pp. 70, 71, 76); six because richness at six did not differ from eight (narrative p. 18).
- The ten-minute targeted plant collection, one plant genus per event (protocol pp. 64–65).
- The plot day: two collectors, traps out 8:30–9:00, retrieved after 15:00, netting between (p. 74); trap and net events are separate (p. 75).
- Kobo today, offline-capable, one form for all tiers (p. 160); paper as fallback (p. 148).
- Photos of the plot and its plants belong to the plot day (protocol pp. 162–163).
- A collector prints as first initial plus full last name, "O. Carril" (protocol p. 176) — `labelName()` already does this.
- Program is stated per event, never derived: `ProjectID` sits on `CollectionEvent` (p. 93).

## What they contradict or correct

1. **A zero-bee sample is a record, and must exist.** "Events stand alone, and can exist in the absence of specimens" (protocol p. 92); the no-bee event gets accession "XXXX" (p. 175); "Collections in which no bees are observed are still valuable data and should be documented in the same manner" (p. 157). Beeline mints a sample only from a positive count (`observation_sample_candidate`), reading zero as "nothing was collected". For a BLM sample, zero is the finding.

2. **Her label carries the floral host and the time.** The minimum label is "Country, State, County, Location Description, Decimal degrees, Date, Collector(s), Collection Method, Time of collection, and (if net), Plant genus and species", 4-point Arial, plus a bar code (protocol pp. 178, 180). CONTEXT's label rule — no host, "so late host corrections never invalidate printed labels" — does not hold for her labels, and a plant "identified later" (p. 157) is a reprint.

3. **The site is not a BLM code; it is the collector's own shorthand.** No BLM-assigned site code appears anywhere. The plot is named by whoever sets it up — "unique to this place, short to write, and descriptive" (p. 136) — and the *location descriptor* is "what you will write on your label to tie it to your GPS coordinates" (p. 161): `EMPP1`, `CPMCT-3`, `MM17`, `Plot 243-b` (pp. 72, 154–158). The five characters Olivia described look like this `LocationShorthand`, chosen rather than issued.

4. **Her "collection event" is not quite our sample.** `EventID` is "unique for each combination of date, time, and collector" (p. 92) — a timed *session*. For a ten-minute collection and for a trap array, session and sample coincide. For a plot's 45-minute net session they do not: the bees are vialled "one vial for each plant" plus one for ground and air (pp. 74, 142), each vial gets its own field label "date/plot/collector/flower/time of day" (p. 76), each is one row in the spreadsheet — "Each date/place/collector/method/plant is one row" (pp. 174–175) — and the plant sits on the specimen (`BeeSpecimens.PlantID`, p. 93). So a plot day is day-place → session → vial, three grains; Beeline's sample is her vial and her session has no Beeline name.

5. **Bycatch is discarded.** Pinning step 1: "discarding any specimens that are not bees (i.e. flies, wasps, gnats, ants)" (p. 169). CONTEXT catalogues bycatch as genuinely valuable.

6. **The end time of a ten-minute collection is not recorded**: "Record the start time only ... the end time can be inferred" (p. 157); Kobo computes it (p. 161); pauses go in notes. CONTEXT says start and stop recorded. The required-metadata list does ask for "active sampling duration, excluding paused time" (p. 67), but no form has a field for it.

7. **One Kobo form is not one sample.** A targeted collection is one submission; a plot day is one submission per *collector*, holding trap times, both net sessions, the plant list and the photos, saved as a draft through the day (pp. 160–163). Two collectors on one plot each submit their own (p. 160), so a plot day arrives twice. The one-form-per-event shape [field-data-entry.md](field-data-entry.md) proposes already exists for plots; the per-vial grain is what is missing.

8. **The pilot's volunteers were Journey-level; apprentice appears nowhere.** The pilot used "Master Melittologist Journey-level participants who were considered capable of independently implementing the complete sampling regimen" (narrative p. 21); training is online modules and videos (narrative p. 22; protocol p. 59). Neither document mentions apprentice level or Canvas — so the April 2027 entry bar is the meeting's claim alone.

9. **Accession numbers can be removed.** More labels than bees, or a bee destroyed in pinning: "Remove the records from the database, including the accession numbers" (p. 184). Her practice voids a number for a specimen that no longer exists — Arthur's side of the *Voided field number* disagreement, in writing.

10. **Location radius disagrees with itself**: a location is "any location within a 300-meter radius" (p. 92), but a new location is recorded when "more than approximately 500 m from the previous location" (pp. 66, 142).

## What they add

**The data flow.** Kobo or paper → collection-event database → specimen database → one label per specimen → identification, "batch updates as taxonomy changes" → a Darwin Core upload "so that they are accessible to the BLM" (narrative p. 29). Kobo submissions are "imported directly into the monitoring database, where it is reviewed and processed by the database manager" (protocol p. 173); paper goes through an Excel sheet first (p. 174). Determinations are updated in place, "a living record of current bee determinations" (p. 92), not appended. The database is described as online, openable by "landscape managers and partners ... at any time" (p. 92), with "an online user interface ... currently under development" (narrative p. 30).

**Per collecting event (her DayPlace; the plot form, protocol pp. 149–153).** Date; location name; county; state; latitude, longitude (decimal degrees; Kobo also takes altitude m and accuracy m, p. 160); elevation (ft; Kobo: m); habitat (grassland / sagebrush / riparian-wetland / pinyon-juniper / ponderosa pine / aspen / other); habitat condition (free text); temperature at start, end, AM and PM (°F); cloud cover (Kobo: full sun, 1/4, 1/2, 3/4, overcast; paper: 0, 1–25, 26–50, 51–75, 76–100 %, p. 152); precipitation; AM and PM wind (mph); weather notes; comments, including which photos were taken; floral resources — every blooming taxon in the plot with abundance on a modified log scale (exact under 10 or 20, tens to 100, hundreds to 1,000, then "1000+"; plants, not stems, pp. 77, 157), entered in Kobo as one string "Genus species abundance; ..." parsed on upload (p. 162); photos of the plot (every visit), of plants, and of queen bumble bees (pp. 162–163). Humidity is asked for in the field manual (p. 141) and is on no form.

**Per sample (her event/vial).** Collection method PT / VT / N; protocol TPC / PlotPT / PlotNT / PlotVT (pp. 176–177); Time1, Time2 (traps to the nearest 15 min, p. 151; nets: both collectors start and stop together); collector (one for nets, two for traps on paper, three in the schema); plant genus and species ("sp." if unknown, family if genus unknown, p. 177) and patch abundance (Tier 1); pan traps deployed and damaged (p. 71); number of bees — **counted at pinning, not in the field**, on a count label at the end of the string (p. 172); notes on deviations. Targeted collections take three photos of the target plant: close, whole, patch (p. 161).

**Identifiers.** Event: date + time + collector. Location: a reusable 300 m area with description, shorthand, coordinates, habitat, county (p. 93). Specimen: the accession number, which is the bar code, assigned when labels are generated and never by the collector; the recommended shape is a four-letter institution code plus six digits, `RPFO000001` (p. 111), unless a housing museum wants its own. Whether numbers are assigned locally is a planning question (p. 96). Nothing says what Olivia's own database uses.

**Field labels.** Every vial or Whirl-pak gets a pencil label — date, collector initials, location shorthand, plant or "PT"/"VT", times (pp. 67, 72, 76, 140) — which becomes the header of that sample's row of pins (p. 172). Initials must be unique within a project (p. 151). No Beeline equivalent.

**Protocol constants.** Weather: <50 % cloud, sustained wind ≤10 mph, gusts ≤15 mph, no rain; minimum 70 °F in the arid west, 65 °F above 40°N or high, 60 °F far north (pp. 59–60); traps pulled at rain or sustained 15 mph (p. 70). Pan traps: 30, ten each white / fluorescent blue / fluorescent yellow, on the ground in an X, ~9 m apart (square) or ~11 m (50 × 200 m plot), colour not recorded (pp. 69–71, 74, 138). Vane trap: optional, one at plot centre, same duration, may run dry with queens released (p. 79). Plots: one hectare, corners and centre GPS'd and flagged, ≥25 m from an ecotone, ≥500 m apart in one habitat, ≥5 km otherwise, never relocated (pp. 86–87, 136–137). Visits: monthly ideal, spring/summer/fall the minimum, annually between years (pp. 61–62).

**Specimens afterwards.** Netted bees pinned within 12 h or held in alcohol; trap catch in 95 % alcohol, frozen (pp. 140, 166). Honeybees kept; spring queen bumble bees photographed, released, and the release recorded (pp. 64–65, 157) — a record with no specimen. Shipped to the "taxonomist at the end of the season" (p. 185), labelled or not — an office can send its spreadsheet to the "monitoring manager who can print the labels and send them back" (p. 177), a label czar by mail. Identified in batches (p. 92), "three weeks for every 1000 bees" to genus (p. 108). Housed "permanently ... in recognized museum collections" (p. 92). Logan is not named anywhere.

**People by role.** Field-office staff (wildlife biologist, botanist, technicians, interns), private contractors, trained volunteers (narrative p. 23); a *project coordinator / program manager* consulted first and handing out the Kobo link (protocol pp. 95, 160); a *database manager*; a *designated taxonomist*; a *monitoring manager* who prints. Olivia is coordinator, taxonomist contact and author. Kobo identifies the collector by a typed "First Initial, Last Name" (p. 161) — free text, no login; `Collectors` holds email, institution and phone.

**Locality style.** "landmark, distance, heading": `Cebolla Spring, 1.2 mi SSE`, `Jct State 117 & County 42, 0.6 mi N` (p. 175); run `qc_rule_locality_format` over these before ingesting any.

**Governance.** BLM's access is reading the online database and receiving a Darwin Core upload (narrative p. 29; protocol p. 92). Rare plants appear only as five years of pollination studies on focal rare plants and their co-blooming neighbours (narrative p. 23); nothing about withholding locations, sign-up, contractors versus volunteers, or telling BLM who collected.

## Answers to the queued questions

1. **Her data model** — answered. Figure 16 (protocol p. 93): `DayPlace`, `CollectionEvent` (start/stop, three collectors, project, bee count, weather), `BeeSpecimens` (barcode, event, species, plant), `BeeSpecies` (family…subspecies, **sex, identifier**), `Locations`, `Counties`, `States`, `Collectors`, `Project`, `PlotFloralMetadata`, `PLANTS database`, `BeeSpeciesTraits`. Real rows: pp. 154–158. What the diagram did not show — the event is a timed session and the vial is the label grain — is correction 4.
2. **The sample identifier** — partly. The event's id is date + time + collector; the *specimen's* is the accession number, printed as the bar code (pp. 92, 178, 180). Its shape in her own database is not stated; the field-office recommendation is `XXXX000001` (p. 111). Meeting a Beeline field number: not addressed.
3. **Before and after** — partly. The reusable thing is the 300 m *location* and the named plot, never relocated (p. 87). The shorthand is the collector's, not BLM's (correction 3).
4. **One sample, two programs** — not addressed; `ProjectID` is one per event.
5. **Signing up** — not addressed beyond "reach out to project manager" for the form (p. 160).
6. **Rare plants** — not addressed.
7. **BLM's access** — partly: view the online database at any time, and a Darwin Core upload to a central repository (narrative p. 29; protocol p. 92).
8. **What Logan wants about volunteers** — not addressed; the `Collectors` table holds email, institution, phone (p. 93).
9. **Floral host on each bee** — answered by correction 4: a targeted collection is one genus; a plot session ranges over several plants but the bees are vialled by plant, so Beeline's one-host sample survives if the sample is the vial.
10. **Which plant list** — partly: free text in the field, down to `Asteraceae #1 – photo` or a voucher (pp. 153, 157), resolved to PLANTS in the database (p. 93); nothing says BLM needs symbols back.
11. **The barcode** — partly: it is the accession number, on the printed label, issued by whoever generates labels — a field office or the project manager (pp. 96, 111, 177). Logan is not mentioned.
12. **Photos** — partly: plot, plants and queens on the plot form, three target-plant photos on the Tier 1 form (pp. 161–163). iNaturalist appears only as an identification resource (p. 187); nothing suggests a BLM net sample is an observation.

## New questions for Olivia

- Does BLM assign a site code at all, or is the five-character code the collector's `LocationShorthand`? If BLM does, it is on no form — where is it recorded?
- `BeeSpecies` carries sex and identifier but no date: one row per species, or one per determination? Does a re-identification overwrite, and is the old one kept?
- What do her accession numbers look like, and would Beeline print them, with her label content (host, time, bar code) rather than the atlases'?
- Is the "online user interface currently under development" (narrative p. 30) Beeline, or something else?
- Should a released queen bumble bee be a record in Beeline? It has a photo and an abundance but no specimen.
- Should bycatch stay discarded for BLM samples, or catalogued as the atlases do?
- 300 m or 500 m for a new location? And is the pinning count final, or does the taxonomist's tally supersede it?

## Terms

| Hers | Ours |
|---|---|
| day-place, `DayPlace` | collecting event |
| collection event, event, sampling event | a timed session: one sample for Tier 1 and traps; for plot netting, several samples (one per vial) — no Beeline word |
| vial, string (the row of pins from one vial), spreadsheet row | sample |
| field label, header label, collection label | the pencil label in the vial; no equivalent |
| accession number, barcode ID, Specimen ID | field number (the bar code being our DataMatrix) |
| location (300 m area), `LocationID` | no equivalent — reusable place with coordinates, habitat, shorthand |
| location descriptor, `LocationShorthand` | the site code as CONTEXT has it |
| location description | locality |
| plot | the permanent one-hectare unit; no equivalent |
| target plant, targeted plant taxon, `PlantID` | floral host |
| floral resources, `PlotFloralMetadata` | the plot's plant list with abundance; no equivalent |
| collection method PT / VT / N | `sample.kind` |
| protocol TPC / PlotPT / PlotNT / PlotVT | protocol |
| identifier (the person) | determiner; "identification" and "determination" both used |
| project, `ProjectID` | program |
| project coordinator, program manager, monitoring manager, database manager | governor, staff, label czar |
| number of bees, `NumberOfBees` | specimen count |
