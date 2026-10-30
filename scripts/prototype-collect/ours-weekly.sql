-- PROTOTYPE (beeline-2zej.4): samples per plant genus, atlas and week of the year, from the legacy pull.
-- Run after ../prototype-collection-targets/build.sh, which builds out/proto.duckdb with occ2.
COPY (
SELECT pgen g, CASE WHEN region_id LIKE 'CA-BC%' THEN 'BC' ELSE split_part(region_id,'-',2) END a,
       least(53, greatest(1, week(make_date(yr, mo, dy)))) w,
       count(DISTINCT concat_ws('|', userLogin, yr, mo, dy, round(lat,4), round(lon,4))) s
FROM occ2 WHERE pgen IS NOT NULL AND region_id IS NOT NULL AND yr IS NOT NULL AND mo BETWEEN 1 AND 12 AND dy BETWEEN 1 AND 31
  AND try(make_date(yr, mo, dy)) IS NOT NULL
GROUP BY ALL) TO 'ours-weekly.json' (FORMAT json, ARRAY true);
