# Prototype: the Collect tab

**Throwaway** (beeline-2zej.4). A tab for planning the next four weeks of collecting, drawn inside Beeline's real header and stylesheets:

- **Plants to work**: the staff list (here, the 2026 communiques' targets), each shown when it usually flowers in the four weeks, with its phenology from iNaturalist (observations annotated as flowering, per atlas) beside our own samples by week.
- **A map** you can pan and zoom, with iNaturalist's grid and point tiles for each ticked plant, filtered to the window's months. Click it for the nearest observations. Choose all observations, only those marked flowering, or only the bee atlas projects' samples.
- **Events**: collecting events and trainings in the four weeks, within the map's view.

It opens on 1 June 2026, because nothing flowers in November. `./build.sh` writes `site/`; serve it with any static server. The page calls iNaturalist, the tile servers and Nominatim from the browser, so it cannot run as a sandboxed artifact.

The plant notes and events come from the communiques, which are for members, so they live in `data/communiques/` and not in git.
