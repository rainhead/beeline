/**
 * Each member atlas's identity, keyed by `atlas.code` (schema/010): its public
 * home, its colorway, and its mark.
 *
 * A colorway is a pair (beeline-2c3.12). `disc` is the accent and the seed a
 * Material palette would generate from; `ring` is the dark band that carries
 * the atlas name. Both are sampled from the marks the program distributes on
 * Canvas (2026-09-21), not stated by any brand source.
 *
 * `logo` is a 216px JPEG from the same place, with no transparency, so it is
 * only ever drawn small and cropped to its circle (`AtlasMark`). It stands in
 * until the vector artwork arrives (beeline-2c3.13); replacing it is a change
 * to this table and the files under static/atlas/, nothing else.
 */
export interface AtlasIdentity {
  url: string;
  disc: string;
  ring: string;
  logo: string;
}

export const ATLAS_IDENTITY: Readonly<Record<string, AtlasIdentity>> = {
  OBA: {
    url: "https://extension.oregonstate.edu/bee-atlas",
    disc: "#d63e08",
    ring: "#8f908a",
    logo: "/static/atlas/OBA.jpg",
  },
  WaBA: {
    url: "https://agr.wa.gov/beeatlas",
    disc: "#fcbd4a",
    ring: "#262162",
    logo: "/static/atlas/WaBA.jpg",
  },
  BC: {
    url: "https://www.bcnativebees.org/bc-bee-atlas",
    disc: "#6eb3d6",
    ring: "#75041d",
    logo: "/static/atlas/BC.jpg",
  },
  ID: {
    url: "https://sites.google.com/view/idahobeeatlas/home",
    disc: "#f3b401",
    ring: "#191919",
    logo: "/static/atlas/ID.jpg",
  },
  NM: {
    url: "https://www.inaturalist.org/projects/new-mexico-bee-atlas",
    disc: "#fdd701",
    ring: "#42b6a3",
    logo: "/static/atlas/NM.jpg",
  },
  OK: {
    url: "https://www.inaturalist.org/projects/oklahoma-bee-atlas",
    disc: "#851617",
    ring: "#333333",
    logo: "/static/atlas/OK.jpg",
  },
};
