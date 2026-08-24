import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryDb, rows } from "./helpers.js";
import { applyPersonOverlay } from "../src/apply-person-overlay.js";
import {
  formatOverlay,
  mergeOverlays,
  parseOverlay,
  parseRef,
  readOverlay,
  upsertOverlay,
  type PersonOverlayRow,
} from "../src/person-overlay.js";

const row = (o: Partial<PersonOverlayRow>): PersonOverlayRow => ({
  person_ref: "name:Ada Collector",
  field: "admin",
  value: "yes",
  author: "staffer",
  reason: "",
  ...o,
});

describe("the overlay file", () => {
  it("names a person by something a rebuild reproduces, not by entity_id", () => {
    expect(parseRef("name:Ada Collector")).toEqual({ kind: "name", key: "Ada Collector" });
    expect(parseRef("inat:429964")).toEqual({ kind: "inat", key: "429964" });
    // An entity id is a sequence draw and means a different person per store.
    expect(parseRef("356")).toBeNull();
    expect(parseRef("inat:amelathopoulos")).toBeNull();
    expect(parseRef("name:")).toBeNull();
  });

  it("refuses a bad row rather than dropping it, because a save rewrites the file", () => {
    const head = "person_ref,field,value,author,reason\n";
    expect(() => parseOverlay(`${head}name:Ada,pronouns,they,me,\n`, "f")).toThrow(/not an overlay field/);
    expect(() => parseOverlay(`${head}Ada,admin,yes,me,\n`, "f")).toThrow(/not a person reference/);
    expect(() => parseOverlay(`${head}name:Ada,admin,maybe,me,\n`, "f")).toThrow(/expected yes or no/);
    expect(() => parseOverlay(`${head}name:Ada,inat_user_id,amelathopoulos,me,\n`, "f")).toThrow(/not an iNat user id/);
    expect(() => parseOverlay(`${head}name:Ada,admin,yes,me\n`, "f")).toThrow(/4 fields, expected 5/);
  });

  it("keeps the login beside the id, so the file is reviewable", () => {
    const parsed = parseOverlay(
      "person_ref,field,value,author,reason\nname:Ada,inat_user_id,429964 amelathopoulos,me,verified\n",
      "f",
    );
    expect(parsed[0]!.value).toBe("429964 amelathopoulos");
  });

  it("round-trips commas and quotes in a reason", () => {
    const r = row({ reason: 'They said "it is me", twice' });
    expect(parseOverlay(formatOverlay([r]), "f")).toEqual([r]);
  });

  it("replaces a decision about the same field, and keeps the others", async () => {
    const dir = await mkdtemp(join(tmpdir(), "overlay-"));
    const path = join(dir, "person-overlay.csv");
    await upsertOverlay(path, [row({ field: "admin", value: "yes" }), row({ field: "home_atlas", value: "OBA" })]);
    await upsertOverlay(path, [row({ field: "admin", value: "no", reason: "left the program" })]);
    const saved = await readOverlay(path);
    expect(saved).toHaveLength(2);
    expect(saved.find((r) => r.field === "admin")!.value).toBe("no");
    expect(saved.find((r) => r.field === "home_atlas")!.value).toBe("OBA");
  });

  it("lets an app row win over the git-curated one, per ADR 0004", () => {
    const curated = [row({ value: "no", author: "git" })];
    const app = [row({ value: "yes", author: "staffer" })];
    expect(mergeOverlays(curated, app)).toEqual(app);
  });

  it("reads a missing file as empty, so a fresh checkout just works", async () => {
    expect(await readOverlay(join(tmpdir(), "definitely-not-here.csv"))).toEqual([]);
  });
});

describe("applying the overlay", () => {
  let conn: DuckDBConnection;
  const people: Record<string, number> = {};

  beforeEach(async () => {
    ({ conn } = await createMemoryDb());
    for (const name of ["Ada Collector", "Bo Netter", "Ada Collector Jr"]) {
      await conn.run(`INSERT INTO person (display_name) VALUES ('${name}')`);
    }
    for (const [name, id] of (await rows(conn, `SELECT display_name, entity_id FROM person`)) as [string, number][]) {
      people[name] = Number(id);
    }
    await conn.run(`INSERT INTO inat_account (person_id, inat_user_id, login) VALUES (${people["Bo Netter"]}, 111, 'bonetter')`);
  });

  const apply = (rs: PersonOverlayRow[]) => applyPersonOverlay(conn, rs);
  const one = async (sql: string) => (await rows(conn, sql))[0];

  it("binds an account, keeping the login given beside the id", async () => {
    const r = await apply([row({ person_ref: "name:Ada Collector", field: "inat_user_id", value: "429964 amelathopoulos" })]);
    expect(r.unresolved).toEqual([]);
    expect(await one(`SELECT inat_user_id, login FROM inat_account WHERE person_id = ${people["Ada Collector"]}`)).toEqual([
      429964n,
      "amelathopoulos",
    ]);
  });

  it("refuses to bind an account another person already holds", async () => {
    const r = await apply([row({ person_ref: "name:Ada Collector", field: "inat_user_id", value: "111 bonetter" })]);
    expect(r.unresolved[0]!.reason).toMatch(/already bound/);
    expect(await one(`SELECT count(*) FROM inat_account WHERE person_id = ${people["Ada Collector"]}`)).toEqual([0n]);
  });

  it("unbinds on a blank, which is how someone loses the ability to sign in", async () => {
    await apply([row({ person_ref: "name:Bo Netter", field: "inat_user_id", value: "" })]);
    expect(await one(`SELECT count(*) FROM inat_account`)).toEqual([0n]);
  });

  it("grants and revokes admin", async () => {
    await apply([row({ person_ref: "name:Ada Collector", field: "admin", value: "yes" })]);
    expect(await one(`SELECT count(*) FROM person_admin`)).toEqual([1n]);
    await apply([row({ person_ref: "name:Ada Collector", field: "admin", value: "no" })]);
    expect(await one(`SELECT count(*) FROM person_admin`)).toEqual([0n]);
  });

  it("sets a home atlas by code, and refuses a code no atlas has", async () => {
    await apply([row({ person_ref: "name:Ada Collector", field: "home_atlas", value: "WaBA" })]);
    expect(await one(`SELECT a.code FROM person_home_atlas h JOIN atlas a ON a.entity_id = h.atlas_id`)).toEqual(["WaBA"]);
    const bad = await apply([row({ person_ref: "name:Ada Collector", field: "home_atlas", value: "ZZ" })]);
    expect(bad.unresolved[0]!.reason).toMatch(/no atlas with code/);
  });

  it("edits names, and clears a label override with a blank", async () => {
    await apply([
      row({ person_ref: "name:Ada Collector", field: "label_name", value: "A. Collector-Smith" }),
      row({ person_ref: "name:Ada Collector", field: "family_name", value: "Collector-Smith" }),
    ]);
    expect(await one(`SELECT label_name, family_name FROM person WHERE entity_id = ${people["Ada Collector"]}`)).toEqual([
      "A. Collector-Smith",
      "Collector-Smith",
    ]);
    await apply([row({ person_ref: "name:Ada Collector", field: "label_name", value: "" })]);
    expect(await one(`SELECT label_name FROM person WHERE entity_id = ${people["Ada Collector"]}`)).toEqual([null]);
  });

  it("refuses a name two people share rather than picking one", async () => {
    await conn.run(`INSERT INTO person (display_name) VALUES ('Ada Collector')`);
    const r = await apply([row({ person_ref: "name:Ada Collector", field: "admin", value: "yes" })]);
    expect(r.applied).toBe(0);
    expect(r.unresolved[0]!.reason).toMatch(/names 2 people/);
    expect(await one(`SELECT count(*) FROM person_admin`)).toEqual([0n]);
  });

  it("reports a reference that names nobody instead of guessing", async () => {
    const r = await apply([row({ person_ref: "name:Nobody At All", field: "admin", value: "yes" })]);
    expect(r.applied).toBe(0);
    expect(r.unresolved[0]!.reason).toMatch(/no person named/);
  });

  it("replays a file written after a rename, whichever name a row was keyed on", async () => {
    // This is the shape a rebuild replays: the rename was recorded under the
    // old name, and every decision made afterwards under the new one. Against
    // a freshly promoted store, which knows only the old name, both have to
    // land on the same person.
    const replayed = await apply([
      row({ person_ref: "name:Ada Collector", field: "display_name", value: "Ada Collector-Smith" }),
      row({ person_ref: "name:Ada Collector-Smith", field: "admin", value: "yes" }),
      row({ person_ref: "name:Ada Collector", field: "home_atlas", value: "OBA" }),
    ]);
    expect(replayed.unresolved).toEqual([]);
    expect(await one(`SELECT display_name FROM person WHERE entity_id = ${people["Ada Collector"]}`)).toEqual([
      "Ada Collector-Smith",
    ]);
    expect(await one(`SELECT person_id FROM person_admin`)).toEqual([people["Ada Collector"]]);
    expect(await one(`SELECT person_id FROM person_home_atlas`)).toEqual([people["Ada Collector"]]);
  });
});

describe("the file the app writes", () => {
  it("is the file promotion replays: same shape, same parser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "overlay-"));
    const path = join(dir, "person-overlay.csv");
    await upsertOverlay(path, [
      row({ person_ref: "name:Andony Melathopoulos", field: "inat_user_id", value: "429964 amelathopoulos", reason: "3,019 records" }),
    ]);
    const text = await readFile(path, "utf8");
    expect(text.split("\n")[0]).toBe("person_ref,field,value,author,reason");
    // Hand-written and app-written rows are interchangeable, which is what
    // makes graduating a row into git a copy-paste rather than a conversion.
    await writeFile(path, `${text}name:Bo Netter,admin,yes,git,program lead\n`);
    expect(await readOverlay(path)).toHaveLength(2);
  });
});
