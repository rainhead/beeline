-- Postgres only: the helpers src/postgres-port.ts rewrites DuckDB constructs
-- into. Applied before schema/*.sql by `pnpm db:check-postgres`; DuckDB never
-- reads this directory (src/schema.ts lists schema/*.sql, not subdirectories).

-- try_cast(x AS T): DuckDB answers NULL where the cast fails, Postgres raises.
-- One function per target type, since Postgres cannot take a type as an
-- argument. The text is trimmed first, as DuckDB's cast trims it. An integer
-- goes by way of numeric because DuckDB rounds a decimal string ('1.5' is 2,
-- '2.5' is 3, half away from zero) where Postgres refuses it; numeric's
-- round() rounds the same way.
CREATE FUNCTION beeline_try_cast_integer(v text) RETURNS integer
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RETURN round(trim(v)::numeric)::integer; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE FUNCTION beeline_try_cast_bigint(v text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RETURN round(trim(v)::numeric)::bigint; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE FUNCTION beeline_try_cast_double(v text) RETURNS double precision
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RETURN trim(v)::double precision; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE FUNCTION beeline_try_cast_date(v text) RETURNS date
LANGUAGE plpgsql STABLE AS $$
BEGIN RETURN trim(v)::date; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE FUNCTION beeline_try_cast_timestamp(v text) RETURNS timestamp
LANGUAGE plpgsql STABLE AS $$
BEGIN RETURN trim(v)::timestamp; EXCEPTION WHEN others THEN RETURN NULL; END $$;

-- CAST(<json> AS T[]): DuckDB casts a JSON array to a list, and anything
-- that is not an array (a JSON null included) to NULL. Postgres casts no
-- JSON to an array, so the elements come out through these.
CREATE FUNCTION beeline_json_array(j jsonb) RETURNS jsonb[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(j) = 'array'
              THEN ARRAY(SELECT jsonb_array_elements(j)) END
$$;

CREATE FUNCTION beeline_json_array_text(j jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(j) = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(j)) END
$$;
