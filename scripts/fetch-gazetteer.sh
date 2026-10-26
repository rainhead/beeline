#!/usr/bin/env bash
# Downloads the public sources a locality is named from (beeline-7i6), into
# data/gazetteer-sources/ by default. Run on a workstation: the OpenStreetMap
# extracts are about 2 GB, which is why the gazetteer is built here and only
# the built file goes up to the machine (docs/runbooks/deploy-fly.md).
#   pnpm locality:fetch [dir]
# A file already downloaded is kept; delete it to fetch it again.
set -euo pipefail
DL=${1:-data/gazetteer-sources}
mkdir -p "$DL"
cd "$DL"
get() { [ -s "$2" ] || { echo "fetching $2" >&2; curl -sSfL -m 1800 -o "$2.part" "$1" && mv -f "$2.part" "$2"; }; }

# Towns, peaks and named places, with population and elevation (GeoNames, CC BY 4.0).
get https://download.geonames.org/export/dump/US.zip US.zip
get https://download.geonames.org/export/dump/CA.zip CA.zip
# Counties, and town limits (incorporated places and census-designated
# places): Census cartographic boundaries, 2023.
get https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_500k.zip cb_2023_us_county_500k.zip
get https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_place_500k.zip cb_2023_us_place_500k.zip
# BC's regional districts and municipalities as the province legally defines
# them now (ABMS), not as iNaturalist has them (beeline-313x); and BC's
# provincial parks, ecological reserves and protected areas.
WFS="https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature&outputFormat=json&srsName=EPSG:4326"
get "$WFS&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_REGIONAL_DISTRICTS_SP" bc_rd.geojson
get "$WFS&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_MUNICIPALITIES_SP" bc_muni.geojson
get "$WFS&typeName=pub:WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW" bc_parks.geojson
# National wildlife refuges: USFWS interest boundaries, simplified to about
# 30 m, in pages of 500.
FWS="https://services.arcgis.com/QVENGdaPbd4LUkLV/ArcGIS/rest/services/FWSInterest_Simplified_Authoritative/FeatureServer/0/query"
for o in 0 500 1000; do
  get "$FWS?where=RSL_TYPE%3D%27NWR%27&outFields=ORGNAME,INTTYPE1&outSR=4326&f=geojson&resultOffset=$o&resultRecordCount=500&orderByFields=OBJECTID&maxAllowableOffset=0.0003&geometryPrecision=5" "nwr_$o.geojson"
done
# WDFW wildlife area units.
get "https://geodataservices.wdfw.wa.gov/arcgis/rest/services/MapServices/WildlifeAreas/MapServer/0/query?where=1%3D1&outFields=WLA_Name,WLAU_Name,AccessTypeIDDesc&outSR=4326&f=geojson&maxAllowableOffset=0.0003&geometryPrecision=5" wdfw_units.geojson
# Washington state parks, as WA State Parks publishes them.
get "https://services5.arcgis.com/4LKAHwqnBooVDUlX/arcgis/rest/services/WA_State_Park_Boundaries/FeatureServer/0/query?where=1%3D1&outFields=ParkName,Category&outSR=4326&f=geojson&maxAllowableOffset=0.0002&geometryPrecision=5" wa_state_parks.geojson
# National Park Service units: parks, monuments, recreation areas.
get "https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service/FeatureServer/2/query?where=1%3D1&outFields=UNIT_NAME,UNIT_TYPE&outSR=4326&f=geojson&maxAllowableOffset=0.0005&geometryPrecision=5" nps_units.geojson
# Park, reserve and island outlines from OpenStreetMap (ODbL), for the
# regional and city parks no government layer gathers, and for islands.
# Geofabrik's extracts, one per state or province the atlases collect in.
for region in north-america/canada/british-columbia north-america/us/washington north-america/us/oregon \
              north-america/us/idaho north-america/us/new-mexico; do
  get "https://download.geofabrik.de/$region-latest.osm.pbf" "$(basename "$region")-latest.osm.pbf"
done

[ -d us ] || unzip -oq US.zip -d us
[ -d ca ] || unzip -oq CA.zip -d ca
[ -d counties ] || unzip -oq cb_2023_us_county_500k.zip -d counties
[ -d places ] || unzip -oq cb_2023_us_place_500k.zip -d places
echo "sources in $DL" >&2
