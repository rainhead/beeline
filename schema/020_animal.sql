CREATE TABLE animal (
  id              INTEGER PRIMARY KEY DEFAULT nextval('entity_id_seq'),
  parent_id       INTEGER REFERENCES animal(id),
  rank            TEXT NOT NULL,
  scientific_name TEXT NOT NULL,
  authorship      TEXT
);
COMMENT ON TABLE animal IS 'The curated taxonomy — named for its role: every specimen determination (bees and bycatch alike) points here, while floral hosts are iNat taxon references on the sample. Bees to species; non-bee scaffold deep enough for wasps at species rank. Versioning mechanics are an open design point (docs/schema-sketch.md).';
COMMENT ON COLUMN animal.rank IS 'Must admit suborder and superfamily — coarse bycatch determinations land at Symphyta and Ichneumonoidea.';
COMMENT ON COLUMN animal.scientific_name IS 'Scientific name, disambiguated from vernacular names, which this table does not carry.';
