# Prototype: collection targets

**Throwaway.** Three layouts for telling a volunteer where to collect next (beeline-2zej.4), switched with the bar at the bottom of the page or the arrow keys:

- **A, target board**: the 2026 communiques' targets as cards, each with the plant's months, a map of where it has been collected from, and how many records each bee sought has in the atlas.
- **B, map of gaps**: counties shaded by samples in the chosen month; pick one for what has been collected there that month, and the specialists recorded elsewhere in the atlas but never there.
- **C, plants ranked**: plant genera collected from that month, ranked by how many of their specialists have fewer than 10 records in the atlas.

The data is the old system's records (the legacy pull, `data/legacy`), placed in counties by the gazetteer, not the store, so it runs on a machine with no store. The targets were extracted from the communiques into `data/communiques/`, which is not committed: the mailing list is for members, and this repository is public.

`./build.sh` writes `out/collection-targets.html`, one self-contained file.
