import { describe, expect, test } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_DIR } from "../src/schema.js";
import { numberPlaceholders, toPostgres } from "../src/postgres-port.js";

/**
 * The rewrites src/postgres-port.ts makes, one rule at a time, on SQL in the
 * shapes the schema and the app actually write. Whether the result applies
 * and means the same thing is a question for a real Postgres: CI's
 * `db:check-postgres` applies the schema, and bench/postgres/compare-views.ts
 * compares every view's rows on a copy of a store.
 */

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const port = (sql: string) => squash(toPostgres(sql));

describe("toPostgres", () => {
  test("leaves portable SQL alone", () => {
    const sql = "SELECT s.entity_id, concat_ws(' ', a, b) FROM sample s WHERE s.kind = 'net' AND x <> 1";
    expect(port(sql)).toBe(sql);
  });

  test("never rewrites inside a string, a quoted identifier or a comment", () => {
    expect(port(`SELECT 'try_cast(x AS INTEGER) DOUBLE', "DOUBLE" FROM t -- json_extract(a, '$.b')`)).toBe(
      `SELECT 'try_cast(x AS INTEGER) DOUBLE', "DOUBLE" FROM t`,
    );
  });

  test("DOUBLE becomes DOUBLE PRECISION, once", () => {
    expect(port("CREATE TABLE t (a DOUBLE, b DOUBLE PRECISION, c DOUBLE NOT NULL)")).toBe(
      "CREATE TABLE t (a DOUBLE PRECISION, b DOUBLE PRECISION, c DOUBLE PRECISION NOT NULL)",
    );
    expect(port("SELECT CAST(x AS DOUBLE), y::DOUBLE")).toBe("SELECT CAST(x AS DOUBLE PRECISION), y::DOUBLE PRECISION");
  });

  test("the JSON type becomes jsonb", () => {
    expect(port("CREATE TABLE t (content JSON NOT NULL)")).toBe("CREATE TABLE t (content JSONB NOT NULL)");
  });

  describe("JSON extraction", () => {
    test("a path becomes a Postgres path, with array indexes", () => {
      expect(port("SELECT json_extract_string(o.content, '$.user.login')")).toBe(
        "SELECT (o.content #>> '{user,login}')",
      );
      expect(port("SELECT json_extract(o.content, '$.geojson.coordinates[1]')")).toBe(
        "SELECT (o.content #> '{geojson,coordinates,1}')",
      );
    });

    test("a cast of an extracted scalar goes by way of text, which survives a JSON null", () => {
      expect(port("SELECT CAST(json_extract(o.content, '$.taxon.id') AS BIGINT)")).toBe(
        "SELECT CAST((o.content #>> '{taxon,id}') AS BIGINT)",
      );
    });

    test("a cast to a list takes the array's elements", () => {
      expect(port("SELECT unnest(CAST(json_extract(o.content, '$.ofvs') AS JSON[]))")).toBe(
        "SELECT unnest(beeline_json_array((o.content #> '{ofvs}')))",
      );
      expect(
        port(
          "SELECT unnest(CAST(coalesce(json_extract(o.content, '$.private_place_ids'), json_extract(o.content, '$.place_ids')) AS BIGINT[]))",
        ),
      ).toBe(
        "SELECT unnest(CAST(beeline_json_array_text(coalesce((o.content #> '{private_place_ids}'), (o.content #> '{place_ids}'))) AS BIGINT[]))",
      );
    });

    test("a JSONPath after an arrow is a path, not a key named '$.name'", () => {
      expect(port("WHERE j.j ->> '$.name' = 'sampleId'")).toBe("WHERE j.j #>> '{name}' = 'sampleId'");
      expect(port("SELECT j -> 'plain_key'")).toBe("SELECT j -> 'plain_key'");
    });

    test("refuses a path it cannot express", () => {
      expect(() => toPostgres("SELECT json_extract(c, '$.ofvs[*].name')")).toThrow(/JSON path/);
      expect(() => toPostgres("SELECT json_extract(c, path_column)")).toThrow(/JSON path/);
    });
  });

  test("try_cast becomes a helper that answers NULL rather than raising", () => {
    expect(port("SELECT try_cast(f.specimen_count_raw AS INTEGER) > 0")).toBe(
      "SELECT beeline_try_cast_integer(CAST(f.specimen_count_raw AS text)) > 0",
    );
    expect(port("SELECT try_cast(v AS DOUBLE)")).toBe("SELECT beeline_try_cast_double(CAST(v AS text))");
    expect(() => toPostgres("SELECT try_cast(v AS TIMESTAMPTZ)")).toThrow(/no port rule/);
  });

  describe("regular expressions", () => {
    test("regexp_matches is an operator, and \\b is spelled \\y", () => {
      expect(port(String.raw`SELECT regexp_matches(upper(c.part), '\b[A-Z][0-9][A-Z]\b')`)).toBe(
        String.raw`SELECT (upper(c.part) ~ '\y[A-Z][0-9][A-Z]\y')`,
      );
      expect(port("SELECT regexp_matches(x, 'abc', 'i')")).toBe("SELECT (x ~* 'abc')");
    });

    test("regexp_full_match is anchored", () => {
      expect(port("SELECT regexp_full_match(upper(c.part), '(US|CA)-[A-Z]{2}')")).toBe(
        "SELECT (upper(c.part) ~ '^(?:(US|CA)-[A-Z]{2})$')",
      );
    });

    test("a pattern that is not a literal passes through", () => {
      expect(port("SELECT regexp_matches(n.norm, locality_street_suffix_pattern())")).toBe(
        "SELECT (n.norm ~ locality_street_suffix_pattern())",
      );
    });

    test("regexp_extract answers '' on no match, as DuckDB does", () => {
      expect(port("SELECT regexp_extract(s, '[0-9]+')")).toBe(
        "SELECT coalesce((regexp_match(s, concat('(', '[0-9]+', ')')))[1], '')",
      );
    });

    test("str_split_regex", () => {
      expect(port(String.raw`SELECT str_split_regex(g.text, ',\s*')`)).toBe(
        String.raw`SELECT regexp_split_to_array(g.text, ',\s*')`,
      );
    });
  });

  test("a macro becomes an SQL function", () => {
    expect(port("CREATE MACRO locality_street_suffix_pattern() AS concat(' (road|rd)', '(,|$)');")).toBe(
      "CREATE FUNCTION locality_street_suffix_pattern() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT concat(' (road|rd)', '(,|$)') $$;",
    );
    expect(() => toPostgres("CREATE MACRO f(a) AS a + 1;")).toThrow(/parameters/);
  });

  test("CREATE OR REPLACE TEMP TABLE drops and creates", () => {
    expect(port("CREATE OR REPLACE TEMP TABLE minted_sample AS SELECT 1")).toBe(
      "DROP TABLE IF EXISTS minted_sample; CREATE TEMP TABLE minted_sample AS SELECT 1",
    );
  });

  test("lists become arrays", () => {
    expect(port("SELECT array_to_string(list_sort(list(p.name)), ' | ')")).toBe(
      "SELECT array_to_string(array_agg(p.name ORDER BY p.name), ' | ')",
    );
    expect(port("SELECT list_contains(ids, 211194)")).toBe("SELECT (211194 = ANY(ids))");
    expect(port("SELECT string_split(s, ';')")).toBe("SELECT string_to_array(s, ';')");
  });

  test("arg_min ignores rows whose key is NULL, as DuckDB does", () => {
    expect(port("SELECT arg_min(name, position) FROM t GROUP BY 1")).toBe(
      "SELECT (array_agg(name ORDER BY position ASC) FILTER (WHERE position IS NOT NULL))[1] FROM t GROUP BY 1",
    );
    expect(() => toPostgres("SELECT arg_max(a, b) OVER (PARTITION BY c) FROM t")).toThrow(/window/);
  });

  test("round to n places keeps printing a double", () => {
    expect(port("SELECT round(loc.latitude, 4)")).toBe(
      "SELECT CAST(round(CAST(loc.latitude AS numeric), 4) AS double precision)",
    );
    expect(port("SELECT round(x)")).toBe("SELECT round(x)");
  });

  test("an interval's amount and unit become one literal", () => {
    expect(port("current_timestamp - INTERVAL 30 DAY")).toBe("current_timestamp - INTERVAL '30 day'");
    expect(port("$1::TIMESTAMPTZ + INTERVAL (row_number() OVER (ORDER BY c.id)) MICROSECOND")).toBe(
      "$1::TIMESTAMPTZ + ((row_number() OVER (ORDER BY c.id)) * INTERVAL '1 microsecond')",
    );
    expect(port("now() - INTERVAL '1 hour'")).toBe("now() - INTERVAL '1 hour'");
  });

  test("rewrites nest", () => {
    expect(port("SELECT try_cast(json_extract_string(c, '$.n') AS INTEGER)")).toBe(
      "SELECT beeline_try_cast_integer(CAST((c #>> '{n}') AS text))",
    );
  });

  test("regexp_extract adds one to a group expression as a whole", () => {
    expect(port("SELECT regexp_extract(s, '([a-z]+)', n - 1)")).toBe(
      "SELECT coalesce((regexp_match(s, concat('(', '([a-z]+)', ')')))[(n - 1) + 1], '')",
    );
  });

  test("placeholders are numbered, and a question mark in a string is not one", () => {
    expect(numberPlaceholders("SELECT coalesce(ref, '?') FROM t WHERE a = ? AND b IN (?, ?)")).toBe(
      "SELECT coalesce(ref, '?') FROM t WHERE a = $1 AND b IN ($2, $3)",
    );
  });

  test("every schema file has a rule for each construct it uses", async () => {
    for (const dir of [SCHEMA_DIR, join(SCHEMA_DIR, "private")]) {
      for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql"))) {
        const sql = await readFile(join(dir, file), "utf8");
        expect(() => toPostgres(sql), file).not.toThrow();
      }
    }
  });
});
