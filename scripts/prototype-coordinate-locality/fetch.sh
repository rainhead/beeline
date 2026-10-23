#!/usr/bin/env bash
# PROTOTYPE (beeline-7i6) — throwaway. Downloads the gazetteers the
# coordinate-locality prototype reads, into data/prototype-locality/downloads.
set -euo pipefail
DL=${1:-data/prototype-locality/downloads}
mkdir -p "$DL"; cd "$DL"
get() { [ -s "$2" ] || curl -sSfL -m 600 -o "$2" "$1"; }
# Towns and peaks, with population and elevation (CC BY 4.0).
get https://download.geonames.org/export/dump/US.zip US.zip
get https://download.geonames.org/export/dump/CA.zip CA.zip
# Counties: Census cartographic boundaries, 2023.
get https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip cb_2023_us_county_500k.zip
# Town limits: incorporated places and census-designated places, 2023.
get https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_place_500k.zip cb_2023_us_place_500k.zip
# BC regional districts as legally defined today (ABMS), and the one
# municipality that sits outside every district.
WFS="https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature&outputFormat=json&srsName=EPSG:4326"
get "$WFS&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_REGIONAL_DISTRICTS_SP" bc_rd.geojson
get "$WFS&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_MUNICIPALITIES_SP&CQL_FILTER=ADMIN_AREA_NAME%20LIKE%20%27%25Northern%20Rockies%25%27" bc_nrrm.geojson
get "$WFS&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_MUNICIPALITIES_SP" bc_muni.geojson
# National wildlife refuges: USFWS interest boundaries, simplified to ~30 m.
FWS="https://services.arcgis.com/QVENGdaPbd4LUkLV/ArcGIS/rest/services/FWSInterest_Simplified_Authoritative/FeatureServer/0/query"
for o in 0 500 1000; do
  get "$FWS?where=RSL_TYPE%3D%27NWR%27&outFields=ORGNAME,INTTYPE1&outSR=4326&f=geojson&resultOffset=$o&resultRecordCount=500&orderByFields=OBJECTID&maxAllowableOffset=0.0003&geometryPrecision=5" nwr_$o.geojson
done
# WDFW wildlife area units.
get "https://geodataservices.wdfw.wa.gov/arcgis/rest/services/MapServices/WildlifeAreas/MapServer/0/query?where=1%3D1&outFields=WLA_Name,WLAU_Name,AccessTypeIDDesc&outSR=4326&f=geojson&maxAllowableOffset=0.0003&geometryPrecision=5" wdfw_units.geojson
[ -d us ] || unzip -oq US.zip -d us
[ -d ca ] || unzip -oq CA.zip -d ca
[ -d counties ] || unzip -oq cb_2023_us_county_500k.zip -d counties
[ -d places ] || unzip -oq cb_2023_us_place_500k.zip -d places
