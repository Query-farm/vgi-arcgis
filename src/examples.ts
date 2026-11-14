/**
 * Example queries that combine two of the worker's functions. Each is defined
 * once here and listed on the function that drives it; the schema-level
 * `vgi.example_queries` (catalog.ts) collects every function's examples.
 */

const VA_PARCELS = "https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/FeatureServer/0";
const VA_CITIES_COUNTIES =
  "https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Admin_Boundaries/FeatureServer/1";
const TIGER_STATES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0";
const TIGER_COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1";
const USGS_3DEP = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer";

/** arcgis_statistics (server-side parcel counts) joined to arcgis_query (city boundaries and areas). */
export const PARCEL_DENSITY_EXAMPLE = {
  description:
    "Parcels per square mile in four small Virginia cities: arcgis_statistics counts parcels per FIPS on the " +
    "server, and arcgis_query supplies each city's name and area from the boundaries layer",
  sql:
    "SELECT b.NAMELSAD, p.statistic_value::BIGINT AS parcels, round(b.AREASQMI, 2) AS sq_mi, " +
    "round(p.statistic_value / b.AREASQMI) AS parcels_per_sq_mi " +
    `FROM arcgis.main.arcgis_statistics('${VA_PARCELS}', 'OBJECTID', statistic := 'count', group_by := 'FIPS', ` +
    "where_clause := 'FIPS IN (''51530'', ''51580'', ''51678'', ''51720'')') p " +
    `JOIN arcgis.main.arcgis_query('${VA_CITIES_COUNTIES}') b ON b.STCOFIPS = p.group_value ` +
    "ORDER BY parcels_per_sq_mi DESC",
};

/** arcgis_query (state names) joined to arcgis_statistics (county counts grouped by state on the server). */
export const STATE_COUNTY_COUNTS_EXAMPLE = {
  description:
    "The five states with the most counties and county equivalents (Virginia's count includes its independent " +
    "cities), by name: arcgis_statistics counts them per state FIPS on the Census server, and arcgis_query on the " +
    "states layer turns each code into its abbreviation and name",
  sql:
    "SELECT s.STUSAB, s.NAME, c.statistic_value::INTEGER AS counties " +
    `FROM arcgis.main.arcgis_query('${TIGER_STATES}') s ` +
    `JOIN arcgis.main.arcgis_statistics('${TIGER_COUNTIES}', 'OBJECTID', statistic := 'count', group_by := 'STATE') c ` +
    "ON c.group_value = s.STATE ORDER BY counties DESC, s.STUSAB LIMIT 5",
};

/** arcgis_sample (elevation at points) spatially joined to arcgis_query (the city polygon holding each point). */
export const ELEVATION_BY_CITY_EXAMPLE = {
  description:
    "USGS elevation at four points, labelled with the Virginia city each falls in: arcgis_sample reads the " +
    "pixels and arcgis_query supplies city boundaries for a point-in-polygon join",
  sql:
    "SELECT b.NAMELSAD, round(TRY_CAST(s.value AS DOUBLE)) AS elevation_m " +
    `FROM arcgis.main.arcgis_sample('${USGS_3DEP}', ` +
    "'[[-79.9937,37.7935],[-79.3540,37.7343],[-79.4428,37.7840],[-82.6290,36.9334]]') s " +
    `JOIN arcgis.main.arcgis_query('${VA_CITIES_COUNTIES}') b ` +
    "ON ST_Contains(b.geometry, ST_Point(s.sample_x, s.sample_y)) " +
    "WHERE b.JURISTYPE = 'CI' ORDER BY elevation_m DESC",
};
