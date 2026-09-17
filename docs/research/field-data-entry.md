# Offline field data entry for the BLM bee surveys: which tool

Researched 2026-09-17 for the taxonomists' meeting on Friday 2026-09-25. Prices and limits were read from each vendor's own page on 2026-09-17 and will drift. Every claim links to the page that owns it; what could not be verified says so.

## Recommendation

Demo two tools and sketch a third.

1. **KoboToolbox, rebuilt as one form per collecting event.** Olivia already uses it, it is free for a university programme, the form is a portable spreadsheet, and its API hands Beeline everything including photos. Its weakness is the hard requirement itself: the offline app is Android-only, and an iPhone gets a web page that keeps unsent samples and photos in Safari's storage. Demo it on an iPhone in airplane mode; that test decides whether Kobo survives.
2. **Esri Survey123.** The only mainstream option with a real offline app on both iOS and Android; it reads the same spreadsheet form standard, and BLM's own field staff use it. Its cost is unknown until someone says whose ArcGIS organisation holds the data, which is also the governance answer.
3. **A Beeline offline web app, as a paper sketch only.** The one option where the collecting event, iNaturalist identity and downstream sample numbering are native rather than reconciled afterwards, and the one whose value depends on how many taxonomists say "me too" on Friday. It shares Kobo's iPhone weakness, would take Peter two to three months, and lands on top of the December 2026 cutover. Show it to measure demand, not to commit.

My default if Friday changes nothing: keep Kobo for 2027, restructure the form, have Beeline ingest it nightly as it does iNaturalist, and let a season of real data specify anything we build later. Move to Survey123 only if the iPhone test fails and BLM or OSU will cover the licences.

One cost is the same under every option and is counted against none: Beeline has no model for a collecting event holding several samples, and nowhere to keep photos. Both must be built whichever tool fills them.

## The requirements as understood

Olivia's BLM-funded surveys (mostly New Mexico; also Colorado, Montana and elsewhere) run three protocols: a 10-minute net collection with recorded start and stop; pan traps out for six hours with recorded start and end; and an all-day plot with two collectors, traps set in the morning and collected in the afternoon with net samples between, trap and net samples being distinct samples within one event. Collectors are volunteers or contractors at apprentice level, on their own phones, trained by April 2027.

The tool must work without signal on iOS and Android and sync later; hold one collecting event with several samples and several photos (the plot, its plants); capture GPS with accuracy; take a five-character BLM site code, checking its shape only; leave the sample identifier to be assigned downstream; hand data, photos and later edits to Beeline automatically; say who is participating, alongside Beeline's iNaturalist sign-in; keep governance with the programme, with BLM given access and rare-plant coordinates withholdable; and cost little at tens of collectors and low thousands of samples a year.

Photos are what hit the free tiers: 2,500 samples a year at five photos each is about 6 GB with photos scaled to roughly 0.5 MB, and over 30 GB at full phone resolution.

## KoboToolbox (the incumbent)

**What it is.** A hosted form service from Kobo, Inc., a nonprofit ([pricing FAQ](https://www.kobotoolbox.org/pricing/)), with server code under AGPL-3.0 ([kobotoolbox/kpi](https://github.com/kobotoolbox/kpi)) and a supported self-install ([kobo-install](https://github.com/kobotoolbox/kobo-install)). Forms are XLSForm, the spreadsheet standard also read by ODK and Survey123 ([xlsform.org](https://xlsform.org/en/)).

**Against the requirements.** Repeating groups, which can nest, give one event with several samples and several photos, exported as one table per group ([repeat groups](https://support.kobotoolbox.org/group_repeat.html)). XLSForm records form start and end automatically, captures GPS with an accuracy target and a warning threshold, scales photos with `max-pixels`, and can hold the site code to five alphanumerics by regular expression ([xlsform.org](https://xlsform.org/en/)).

**Where it falls down.** KoboCollect, the offline app, "works only on Android phones and tablets" ([KoboCollect](https://support.kobotoolbox.org/kobocollect_on_android_latest.html)). An iPhone uses web forms, which keep the form, drafts and queued samples in browser storage and upload "automatically in the background while the form remains open"; Kobo's own warning is that clearing site data "removes stored forms, drafts, and queued submissions from the device, and this data cannot be recovered" ([web forms](https://support.kobotoolbox.org/data_through_webforms.html)). That is an offline web app, so the iOS findings under *Building our own* apply to it.

**A possible escape, untested.** CyberTracker, from a South African conservation nonprofit, has a native [iPhone app](https://apps.apple.com/us/app/cybertracker/id1524186167) that "supports the XlsForm form standard and connects to popular backends: ODK Central, KoBoToolbox and Survey123" ([CyberTracker](https://cybertrackerwiki.org/xlsform/)), so Kobo could stay the server. Its manual admits it "is not as mature as" KoboCollect ([manual](https://cybertrackerwiki.org/xlsform/reference-manual/)). Worth an afternoon with our form before Friday.

**Accounts.** A project either requires a Kobo login, so each sample carries the collector's username, or accepts anonymous submissions by link; row-level permissions can confine a collector to their own samples ([permissions](https://support.kobotoolbox.org/managing_permissions.html)). Kobo knows nothing of iNaturalist: Beeline would map each Kobo username to a person, as the person overlay already maps legacy logins.

**Into Beeline.** A token-authenticated REST API returns samples as JSON, up to 1,000 a page, filterable by submission time, each with `_submitted_by` and an `_attachments` list of download links ([API guide](https://support.kobotoolbox.org/api.html), [API reference](https://kf.kobotoolbox.org/api/v2/docs/)). An edited sample keeps its `meta/rootUuid` and gains a `meta/deprecatedID`. I found no last-modified filter, so the nightly job should re-read everything, a request or two at this scale. The API can delete attachments, so Beeline could copy photos and then clear them from Kobo.

**Cost and governance.** Universities and government qualify for the free Community plan: 5,000 samples a month and 1 GB of files. Next is Professional at $159 a month ($129 billed annually) with unlimited storage ([pricing](https://www.kobotoolbox.org/pricing/)). Photos exhaust 1 GB in the first season unless scaled hard ([media questions](https://support.kobotoolbox.org/photo_audio_video_file.html)) or cleared after ingestion. Data sits on Amazon Web Services and is "never deleted unless you delete the data yourself" ([data storage](https://support.kobotoolbox.org/data_storage.html)); the terms treat survey questions and results as the user's confidential information ([terms](https://www.kobotoolbox.org/terms/)). I did not verify which AWS region the Global server uses.

## ODK (Collect and Central)

The project Kobo descends from: same XLSForm, same Android-only app ("ODK Collect is an Android app", [Collect](https://docs.getodk.org/collect-intro/)), Apache-2.0 server ([getodk/central](https://github.com/getodk/central)). Its iPhone story is weaker than Kobo's: its new browser forms do "not yet support offline use", and the older ones go offline only by hand-editing the link ([Central submissions](https://docs.getodk.org/central-submissions/)). It does two things better: collectors are provisioned by QR code with no email or password ([users](https://docs.getodk.org/central-users/)), and each edit is a new version with a field-level diff, filterable on `__system/updatedAt` ([submission API](https://docs.getodk.org/central-api-submission-management/), [OData](https://docs.getodk.org/central-api-odata-endpoints/)).

Cost is the obstacle. ODK Cloud starts at $199 a month, API access begins at the $499 tier, and no academic discount is listed ([getodk.org](https://getodk.org/#pricing)); self-hosting is free but is a second server, with Postgres, for Peter to run ([install guide](https://docs.getodk.org/central-install-digital-ocean/)). Nothing here justifies moving Olivia off Kobo.

## Esri Survey123 and Field Maps

**What it is.** Esri's form app for iOS and Android, authored in XLSForm through Survey123 Connect, supporting "most (but not all)" of the standard including repeats, photo questions and a GPS accuracy threshold ([XLSForm essentials](https://doc.arcgis.com/en/survey123/desktop/create-surveys/xlsformessentials.htm)). Collectors download a survey on Wi-Fi and "can then begin capturing information without a data connection" ([submitter FAQ](https://doc.arcgis.com/en/survey123/get-started/faqgetanswers.htm)). Field Maps, its map-first sibling, adds nothing a questionnaire needs. BLM's field staff "use mobile apps like ArcGIS Field Maps, Survey123, and QuickCapture" ([BLM mobile GIS](https://www.blm.gov/services/geospatial/mobile-GIS)).

**Where it falls down.** Licensing, and with it governance. A survey lives in an ArcGIS organisation, and a signed-in collector needs a paid user type ([general FAQ](https://doc.arcgis.com/en/survey123/get-started/faqgeneral.htm), [user types](https://www.esri.com/en-us/arcgis/products/arcgis-online/buy)). Esri's price list is rendered by script and I could not read it, so per-collector cost is unknown. OSU has a site licence with ONID sign-in, but for "OSU faculty, staff and students" and "education and non-commercial research" ([OSU](https://technology.oregonstate.edu/software/arcgis), [CEOAS](https://ceoas.oregonstate.edu/computing-arcgisonline)); nothing provides for outside volunteers, and I could not confirm Survey123 is enabled. Esri's nonprofit discount excludes universities and government ([Esri](https://www.esri.com/en-us/industries/nonprofit/nonprofit-program)). A public survey needs no account, but then the collector is whoever they type, and I did not verify that a public survey runs offline in the app. In BLM's organisation the cost would vanish and BLM, not Olivia, would govern the data. Editing a response in the web app is unsupported where repeats are nested ([editing](https://doc.arcgis.com/en/survey123/browser/get-answers/editexistingdata.htm)), so photos should sit beside samples rather than inside them.

**Into Beeline.** Results are a hosted feature layer with a documented REST query, a separate attachments query for photos, and optional editor tracking stamping who edited a row and when ([query](https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer/), [attachments](https://developers.arcgis.com/rest/services-reference/enterprise/query-attachments-feature-service-layer/), [editor tracking](https://doc.arcgis.com/en/arcgis-online/manage-data/manage-editing-hfl.htm)). Proprietary, but the form is still an XLSForm that would move back to Kobo.

## Epicollect5

A free service from the Centre for Genomic Pathogen Surveillance at Oxford, with native apps for Android 10+ and iOS 16+ and an MIT-licensed server ([platforms](https://docs.epicollect.net/mobile-application/mobile-application), [source](https://github.com/epicollect5/epicollect5-server)). A form can carry several branches (repeating sub-forms, one level deep) or a chain of up to five child forms ([child forms vs branches](https://docs.epicollect.net/common-use-cases/child-forms-vs-branches)), which fits event, samples and photos. Location accuracy is captured ([question types](https://docs.epicollect.net/formbuilder/input-types)), a private project ties each entry to the collector's sign-in email ([FAQ](https://docs.epicollect.net/extra/faq)), and a read-only REST API with a media endpoint covers ingestion, at 5 requests a minute ([developer docs](https://developers.epicollect.net/)).

Where it falls down: photos are resized to 1024 × 768, poor for identifying plants; upload is manual, and media upload is a second manual step volunteers will forget ([upload](https://docs.epicollect.net/mobile-application/upload-entries)); a location cannot be made required ([location](https://docs.epicollect.net/mobile-application/location-questions)); the form format is its own. Its makers provide it "without any guarantees" and point mission-critical projects to Kobo or ODK ([docs home](https://docs.epicollect.net/)). It is the fallback if Kobo fails on iPhones and Survey123 cannot be licensed. Where it is hosted I did not verify.

## QField, Mergin Maps, and Fulcrum

QField and Mergin Maps are open-source mobile companions to QGIS with offline apps on iOS and Android ([QField](https://docs.qfield.org/get-started/), [Mergin Maps](https://merginmaps.com/docs/)). A "form" is a map layer's attribute form designed in QGIS desktop, nesting is a relation between layers ([relations](https://merginmaps.com/docs/layer/one-to-n-relations/)), photos are attachments, and Mergin exposes GPS accuracy as a form variable ([position variables](https://merginmaps.com/docs/layer/position_variables/)). Academic plans are cheap (QFieldCloud €25 a month with 10 GB, Mergin free with 5 GB) and both self-host ([QFieldCloud](https://qfield.cloud/pricing), [Mergin](https://merginmaps.com/pricing)). They fall down on fit: someone must maintain a QGIS project, a volunteer faces a map application rather than a questionnaire, and Beeline would read GIS layers rather than a record feed.

Fulcrum, a commercial form builder, works offline, but API access starts at $55 per user per month, billed annually, five users minimum ([pricing](https://www.fulcrumapp.com/pricing/)): about $20,000 a year for thirty collectors. Not credible at this scale.

## The iNaturalist apps

The existing programme records a net sample as an observation of the host plant, with observation fields for sample number and specimen count. Could that carry the net samples of protocols 1 and 3? Partly. Observations made without signal upload later ([bioblitz guide](https://help.inaturalist.org/en/support/solutions/articles/151000194866-bioblitz-guide)), but observation fields reach the apps only through a traditional project ("it's not possible to add an observation field to an observation in any iNat app without adding it to a project", [staff, June 2026](https://forum.inaturalist.org/t/observation-fields-on-mobile-app/79957)), and the new iPhone app could not add to traditional projects as of [April 2025](https://help.inaturalist.org/en/support/solutions/articles/151000212105-why-can-t-i-add-my-observation-to-a-traditional-project-in-the-new-iphone-app-). I did not confirm whether that has changed, or whether project fields load without signal.

What it cannot carry is structural. An observation "records an encounter with an individual organism" ([iNaturalist](https://help.inaturalist.org/en/support/solutions/articles/151000169927)): a plot photo is not one, a pan trap has no host plant, a net sample taken off no flower has no observation at all, and nothing groups observations into an event or records timed effort. iNaturalist stays right for the host plant record, and a field form can hold the observation's number.

## Building our own inside Beeline

**What it is.** An installable offline web app served by Beeline: a service worker caches the form, samples and photos wait in IndexedDB, and the app uploads when it next has signal. Kobo's iPhone web forms prove it can be done, within the same limits below.

**What iOS Safari gives you and does not.**

- *Storage and eviction.* Since Safari 17 a site may use up to 60% of the disk, the same for a Home Screen web app, but WebKit evicts "when the system is under storage pressure, or when the site has not been interacted with by the user for some time", least recently used first; `navigator.storage.persist()` is granted on "heuristics like whether the website is opened as a Home Screen Web App" ([WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)). Separately, Safari deletes a site's IndexedDB and service worker after seven days of Safari use without interaction; a Home Screen app counts its own days of use, and WebKit does "not expect" its data to be deleted ([WebKit](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)). Unsent samples are reasonably safe only if the volunteer installs the app to the Home Screen.
- *Installing.* A site cannot trigger an install prompt on iOS (`beforeinstallprompt` "is not supported on iOS"); the volunteer uses Share, then Add to Home Screen, which before iOS 16.4 works from Safari only ([MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)). A training step, on phones we do not manage.
- *Background sync.* Unsupported in every Safari version ([caniuse](https://caniuse.com/background-sync), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)). Uploads run only while the app is open on screen, a long wait for thirty photos on rural signal.
- *Camera.* A file input with `capture` opens the phone's camera and hands back a file, which involves no network, though MDN marks the attribute limited-availability ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture)).
- *GPS.* The Geolocation API reports `accuracy` in metres and requires HTTPS ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/GeolocationCoordinates)). I found no primary source for how good an offline fix is inside an iOS web app, how often iOS re-asks for location permission there, or whether removing the Home Screen icon deletes unsent data. Those need a device test.

**The work.** An offline form shell and service worker; an IndexedDB queue holding photos; idempotent upload keyed by identifiers minted on the phone, with retry; a sign-in that outlives a trip without signal; rules for editing after upload; iPhone install coaching; an export-to-file escape hatch for a stranded phone; and testing on phones we do not own. Eight to twelve weeks to a first field-ready version, then a season of support calls, against one to two weeks to ingest Kobo. The field season is a fixed deadline and the work overlaps the December 2026 cutover.

**What it buys.** Collectors sign in with iNaturalist, so who is participating is already Beeline's roster; events, samples and the downstream identifier live in one model; governance is Beeline's; nothing is rented. The other atlases' trap samplers, on spreadsheets today, could use it too.

## Comparison

| Option | Offline on collectors' phones | Event with several samples and photos | Collector identity | Into Beeline | Hosting and governance | Yearly cost at this scale |
| --- | --- | --- | --- | --- | --- | --- |
| KoboToolbox | Android app; iPhone browser storage only | Yes, nested repeats | Kobo username, or anonymous link | REST and JSON, photo links, edits marked | Kobo on AWS, or self-host | Free to 1 GB of photos, then about $1,550 |
| ODK | Android app; iPhone browser storage, being replaced | Yes, nested repeats | QR-provisioned collectors | REST and OData, versions, `updatedAt` | ODK Cloud (US, EU, India) or self-host | $5,988 with API, or a server to run |
| Survey123 | Native app on both | Yes; avoid nesting | ArcGIS named user, or anonymous | REST query, attachments, editor tracking | An ArcGIS organisation: whose? | Unknown; nil if BLM or OSU licences cover it |
| Epicollect5 | Native app on both | Yes, branches | Sign-in email on private projects | Read-only REST, media endpoint | Oxford-run, no guarantees; or self-host | Free |
| QField or Mergin Maps | Native app on both | Yes, layer relations | Cloud accounts | GIS layers, not a feed | Vendor cloud or self-host | €0 to €300, academic |
| Fulcrum | Offline app (platforms not checked) | Not checked | Paid seats | REST on the Elite plan | Vendor cloud | About $20,000 |
| iNaturalist apps | Native app on both | No | iNaturalist, as Beeline has | Already built | iNaturalist | Free |
| Beeline web app | Browser storage only, on both | Whatever we model | iNaturalist sign-in | Native | Beeline's own | 8 to 12 weeks of Peter, then upkeep |

## Open questions only Olivia or BLM can answer

1. How do iPhone collectors use Kobo today (web forms offline, paper transcribed later, a borrowed Android), has anyone lost samples, and what share of the 2027 collectors will carry iPhones?
2. Would BLM host the surveys in its ArcGIS organisation or extend licences to the programme, and who would govern the data there? Does BLM want access as a map layer, or is an export from Beeline enough?
3. Is Olivia OSU faculty or staff, so that OSU's Esri licence is hers to use?
4. How many photos per event, and at what resolution are plot and plant photos still useful? This sets the storage bill everywhere.
5. What is sensitive for rare plants: the plot point, the location embedded in plant photos, or both?
6. How do volunteers and contractors enrol today, and is an iNaturalist account a fair thing to require of a BLM contractor?
