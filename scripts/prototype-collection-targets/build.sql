-- PROTOTYPE, throwaway (beeline-2zej.4). Run from this directory by build.sh: reads the legacy pull and the gazetteer,
-- writes the JSON that build.py inlines into page.html. A sample here is one collector, one day, one place, one host genus.
INSTALL spatial; LOAD spatial;
ATTACH '../../data/gazetteer.duckdb' AS gaz (READ_ONLY);
CREATE TABLE occ AS
SELECT fieldNumber, userLogin, stateProvince AS st, county,
       try_cast(year AS INT) yr, try_cast(month AS INT) mo, try_cast(day AS INT) dy,
       try_cast(decimalLatitude AS DOUBLE) lat, try_cast(decimalLongitude AS DOUBLE) lon,
       nullif(familyPlant,'') pfam, nullif(genusPlant,'') pgen, nullif(family,'') bfam, nullif(genus,'') bgen, nullif(specificEpithet,'') bsp
FROM read_json('../../data/legacy/occurrences.jsonl.gz', format='newline_delimited', columns={fieldNumber:'VARCHAR',userLogin:'VARCHAR',stateProvince:'VARCHAR',county:'VARCHAR',year:'VARCHAR',month:'VARCHAR',day:'VARCHAR',decimalLatitude:'VARCHAR',decimalLongitude:'VARCHAR',familyPlant:'VARCHAR',genusPlant:'VARCHAR',family:'VARCHAR',genus:'VARCHAR',specificEpithet:'VARCHAR',scratch:'BOOLEAN'})
WHERE NOT coalesce(scratch,false);
CREATE TABLE reg AS SELECT region_id, state, county, geom FROM gaz.region WHERE state IN ('OR','WA','ID','BC','NM');
CREATE TABLE occ2 AS SELECT o.*, r.region_id FROM occ o LEFT JOIN reg r ON o.lat IS NOT NULL AND ST_Contains(r.geom, ST_Point(o.lon, o.lat));
CREATE VIEW o AS
SELECT *, CASE WHEN bsp IS NOT NULL AND bsp NOT LIKE 'sp%' AND bsp NOT LIKE '%.%' THEN bgen||' '||bsp END AS sp,
       concat_ws('|', userLogin, yr, mo, dy, round(lat,4), round(lon,4), pgen) AS skey
FROM occ2 WHERE yr IS NOT NULL;

COPY (SELECT region_id id, state, county name,
  ST_AsGeoJSON(ST_ReducePrecision(ST_SimplifyPreserveTopology(geom, CASE WHEN state='BC' THEN 0.03 ELSE 0.012 END), 0.001)) g
  FROM reg) TO 'out/regions.json' (FORMAT json, ARRAY true);

COPY (
WITH base AS (SELECT pgen, any_value(pfam) fam, count(*) n, count(DISTINCT skey) s, count(*) FILTER (yr=2026) n26, max(yr) last FROM o WHERE pgen IS NOT NULL GROUP BY pgen HAVING count(*)>=5),
mon AS (SELECT pgen, [count(DISTINCT skey) FILTER (mo=1), count(DISTINCT skey) FILTER (mo=2), count(DISTINCT skey) FILTER (mo=3), count(DISTINCT skey) FILTER (mo=4), count(DISTINCT skey) FILTER (mo=5), count(DISTINCT skey) FILTER (mo=6), count(DISTINCT skey) FILTER (mo=7), count(DISTINCT skey) FILTER (mo=8), count(DISTINCT skey) FILTER (mo=9), count(DISTINCT skey) FILTER (mo=10), count(DISTINCT skey) FILTER (mo=11), count(DISTINCT skey) FILTER (mo=12)] bymo FROM o WHERE pgen IS NOT NULL GROUP BY pgen),
bees AS (SELECT pgen, list({sp: sp, n: n} ORDER BY n DESC)[1:25] bees, count(*) nsp FROM (SELECT pgen, sp, count(*) n FROM o WHERE sp IS NOT NULL AND pgen IS NOT NULL GROUP BY ALL) GROUP BY pgen),
bg AS (SELECT pgen, list({g: bgen, n: n} ORDER BY n DESC)[1:12] gens FROM (SELECT pgen, bgen, count(*) n FROM o WHERE bgen IS NOT NULL AND pgen IS NOT NULL GROUP BY ALL) GROUP BY pgen)
SELECT base.pgen g, fam, n, s, n26, last, bymo, coalesce(bees,[]) bees, coalesce(nsp,0) nsp, coalesce(gens,[]) gens
FROM base JOIN mon USING (pgen) LEFT JOIN bees USING (pgen) LEFT JOIN bg USING (pgen) ORDER BY n DESC) TO 'out/plants.json' (FORMAT json, ARRAY true);

COPY (
WITH base AS (SELECT sp, any_value(bfam) fam, count(*) n, max(yr) last, min(yr) first, [count(*) FILTER (mo=1), count(*) FILTER (mo=2), count(*) FILTER (mo=3), count(*) FILTER (mo=4), count(*) FILTER (mo=5), count(*) FILTER (mo=6), count(*) FILTER (mo=7), count(*) FILTER (mo=8), count(*) FILTER (mo=9), count(*) FILTER (mo=10), count(*) FILTER (mo=11), count(*) FILTER (mo=12)] bymo FROM o WHERE sp IS NOT NULL GROUP BY sp),
pl AS (SELECT sp, list({g: pgen, n: n} ORDER BY n DESC)[1:12] plants, sum(n) withhost FROM (SELECT sp, pgen, count(*) n FROM o WHERE sp IS NOT NULL AND pgen IS NOT NULL GROUP BY ALL) GROUP BY sp),
pf AS (SELECT sp, arg_max(pfam, n) topfam, max(n)/sum(n) famshare FROM (SELECT sp, pfam, count(*) n FROM o WHERE sp IS NOT NULL AND pfam IS NOT NULL GROUP BY ALL) GROUP BY sp),
rg AS (SELECT sp, list({r: region_id, n: n, last: last} ORDER BY n DESC) regs FROM (SELECT sp, region_id, count(*) n, max(yr) last FROM o WHERE sp IS NOT NULL AND region_id IS NOT NULL GROUP BY ALL) GROUP BY sp)
SELECT base.sp, fam, n, first, last, bymo, coalesce(plants,[]) plants, coalesce(withhost,0) withhost, topfam, round(famshare,2) famshare, coalesce(regs,[]) regs
FROM base LEFT JOIN pl USING (sp) LEFT JOIN pf USING (sp) LEFT JOIN rg USING (sp) ORDER BY n DESC) TO 'out/bees.json' (FORMAT json, ARRAY true);

COPY (SELECT region_id r, count(DISTINCT skey) s, count(DISTINCT skey) FILTER (yr=2026) s26, count(DISTINCT sp) nsp, count(DISTINCT pgen) npl,
  [count(DISTINCT skey) FILTER (mo=1), count(DISTINCT skey) FILTER (mo=2), count(DISTINCT skey) FILTER (mo=3), count(DISTINCT skey) FILTER (mo=4), count(DISTINCT skey) FILTER (mo=5), count(DISTINCT skey) FILTER (mo=6), count(DISTINCT skey) FILTER (mo=7), count(DISTINCT skey) FILTER (mo=8), count(DISTINCT skey) FILTER (mo=9), count(DISTINCT skey) FILTER (mo=10), count(DISTINCT skey) FILTER (mo=11), count(DISTINCT skey) FILTER (mo=12)] bymo, max(yr) last, count(DISTINCT userLogin) people
FROM o WHERE region_id IS NOT NULL GROUP BY 1) TO 'out/effort.json' (FORMAT json, ARRAY true);

COPY (SELECT region_id r, pgen g, mo m, count(DISTINCT skey) s, count(DISTINCT skey) FILTER (yr=2026) s26
      FROM o WHERE region_id IS NOT NULL AND pgen IS NOT NULL AND mo BETWEEN 1 AND 12 GROUP BY ALL) TO 'out/cpm.json' (FORMAT json, ARRAY true);
