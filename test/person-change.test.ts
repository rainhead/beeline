import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryDb } from "./helpers.js";
import {
  appendChanges,
  diffPerson,
  duckdbReader,
  historyFor,
  lastKnown,
  CHANGE_FIELDS,
  type ChangeField,
  parseChanges,
  readChanges,
  readPersonStates,
  recentChanges,
  recordPersonChanges,
  type PersonChange,
} from "../src/person-change.js";

/**
 * The person change log (beeline-o22): what happened to somebody, and when.
 *
 * The interesting cases are all about identity across a rebuild, because the
 * log is keyed on a reference rather than on an entity_id — every test here
 * that looks like it is about renaming is really about that.
 */

let conn: DuckDBConnection;
let path: string;

const add = (sql: string) => conn.run(sql);

beforeEach(async () => {
  ({ conn } = await createMemoryDb());
  path = join(await mkdtemp(join(tmpdir(), "changes-")), "person-change.csv");
});

const record = (opts: Parameters<typeof recordPersonChanges>[2]) =>
  recordPersonChanges(duckdbReader(conn), path, opts);

const promotion = { source: "legacy_promotion" } as const;

/** One person's history, asked the way the app asks it: through the store. */
async function history(person: { ref: string; altRef: string | null }) {
  const { names } = await readPersonStates(duckdbReader(conn));
  const fields = Object.fromEntries(CHANGE_FIELDS.map((f) => [f, ""])) as Record<ChangeField, string>;
  const state = [...(await readPersonStates(duckdbReader(conn))).states.values()].find(
    (s) => s.ref === person.ref,
  ) ?? { ...person, fields };
  return historyFor(await readChanges(path), names, state);
}

/** The log as (ref, field, old, new) tuples, in the order it was written. */
async function logged(): Promise<string[][]> {
  return (await readChanges(path)).map((c) => [c.person_ref, c.field, c.old_value, c.new_value]);
}

describe("recording what a pass over the store found", () => {
  it("records every field a person arrives with, and nothing they arrive without", async () => {
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (1, 'Ada Collector', 'Ada')`);
    const result = await record(promotion);

    expect(result.appended).toBe(2);
    // The rename goes last, always — see FIELD_ORDER.
    expect(await logged()).toEqual([
      ["name:Ada Collector", "given_name", "", "Ada"],
      ["name:Ada Collector", "display_name", "", "Ada Collector"],
    ]);
  });

  it("does not record 'admin: nothing → no', which is not an event", async () => {
    await add(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Ada Collector')`);
    await record(promotion);
    expect((await logged()).map((r) => r[1])).not.toContain("admin");
  });

  it("appends nothing on a second pass over an unchanged store", async () => {
    await add(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Ada Collector')`);
    await record(promotion);
    const second = await record(promotion);

    expect(second.appended).toBe(0);
    expect((await readChanges(path)).length).toBe(1);
  });

  it("records a rebinding, which is the change nothing used to leave a trace of", async () => {
    // beeline-eft: promotion bound three people to the wrong iNat account and
    // the only record of it was the code that did it.
    await add(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Andony Melathopoulos')`);
    await add(`INSERT INTO inat_account VALUES (1, 1542612, 'andonymelathopoulos')`);
    await record(promotion);

    await add(`UPDATE inat_account SET inat_user_id = 429964, login = 'amelathopoulos' WHERE person_id = 1`);
    const second = await record(promotion);

    expect(second.appended).toBe(2);
    expect((await logged()).slice(-2)).toEqual([
      ["name:Andony Melathopoulos", "inat_user_id", "1542612", "429964"],
      ["name:Andony Melathopoulos", "login", "andonymelathopoulos", "amelathopoulos"],
    ]);
  });

  it("says nothing at all about a reference that has fallen silent", async () => {
    // It looks like a departure and it is not one. The same silence is a name
    // that became ambiguous, a rebuild that respelled it, and a store
    // promoted from a smaller corpus — and the version that wrote departures
    // made flat false statements about people standing right there.
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES
                 (1, 'Ada Collector', 'Ada'), (2, 'Bo Netter', 'Bo')`);
    await record(promotion);

    await add(`DELETE FROM person WHERE entity_id = 2`);
    expect((await record(promotion)).appended).toBe(0);
    expect((await logged()).filter((r) => r[0] === "name:Bo Netter" && r[3] === "")).toEqual([]);
  });

  it("says nothing about an empty store either, which is a rebuild in progress", async () => {
    await add(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Ada Collector')`);
    await record(promotion);

    await add(`DELETE FROM person`);
    expect((await record(promotion)).appended).toBe(0);
  });

  it("does not report a departure when a namesake arrives and takes the name away", async () => {
    // Ada is here, referenced by her name. A second Ada is promoted, and the
    // first one's reference stops naming her alone — but she is still here,
    // with her samples, and saying she left is a plain falsehood.
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (1, 'Ada Collector', 'Ada')`);
    await add(`INSERT INTO person (entity_id, display_name) VALUES (3, 'Bo Netter')`);
    await record(promotion);

    await add(`INSERT INTO person (entity_id, display_name) VALUES (2, 'Ada Collector')`);
    await record(promotion);

    expect((await logged()).filter((r) => r[0] === "name:Ada Collector" && r[3] === "")).toEqual([]);
  });

  it("follows a respelling a rebuild made, rather than starting the person again", async () => {
    // Nobody typed this: promotion derives the display name from recordedBy,
    // and a curated alias or a graduated register row changes it (MaryJo →
    // Mary Jo is CLAUDE.md's own example). No entry says a rename happened,
    // so only the account can recognise her — and it should, because the
    // rename is the interesting thing this pass has to report.
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (1, 'MaryJo Andersen', 'MaryJo')`);
    await add(`INSERT INTO inat_account VALUES (1, 555, 'mjandersen')`);
    await record(promotion);

    await add(`UPDATE person SET display_name = 'Mary Jo Andersen', given_name = 'Mary Jo' WHERE entity_id = 1`);
    await record(promotion);

    expect((await logged()).slice(-2)).toEqual([
      ["name:MaryJo Andersen", "given_name", "MaryJo", "Mary Jo"],
      ["name:MaryJo Andersen", "display_name", "MaryJo Andersen", "Mary Jo Andersen"],
    ]);
    expect((await record(promotion)).appended).toBe(0);
  });

  it("does not say two people traded accounts when their names were swapped", async () => {
    // Fixing a promotion mix-up by hand: two people were each recorded under
    // the other's name. Nothing was rebound, and a log that says two accounts
    // changed hands is worse than one that says nothing, because a wrongly
    // bound account is the very thing it exists to surface (beeline-eft).
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES
                 (1, 'Ada Collector', 'Ada'), (2, 'Bo Netter', 'Bo')`);
    await add(`INSERT INTO inat_account VALUES (1, 111, 'ada'), (2, 222, 'bo')`);
    await record(promotion);

    await add(`UPDATE person SET display_name = 'x' WHERE entity_id = 1`);
    await add(`UPDATE person SET display_name = 'Ada Collector' WHERE entity_id = 2`);
    await add(`UPDATE person SET display_name = 'Bo Netter' WHERE entity_id = 1`);
    await record(promotion);

    const bindings = (await logged()).filter((r) => r[1] === "inat_user_id" && r[2] !== "");
    expect(bindings).toEqual([]);
    expect((await record(promotion)).appended).toBe(0);
  });

  it("still records a rebinding, which is the one it must never miss", async () => {
    // The refusal above must not swallow this: an account new to the log is
    // not one being taken off anybody (beeline-eft).
    await add(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Andony Melathopoulos')`);
    await add(`INSERT INTO inat_account VALUES (1, 1542612, 'andonymelathopoulos')`);
    await record(promotion);
    await add(`UPDATE inat_account SET inat_user_id = 429964, login = 'amelathopoulos' WHERE person_id = 1`);
    await record(promotion);

    expect((await logged()).filter((r) => r[1] === "inat_user_id" && r[2] !== "")).toEqual([
      ["name:Andony Melathopoulos", "inat_user_id", "1542612", "429964"],
    ]);
  });

  it("does not hand a login to its next holder when the last one cannot be named", async () => {
    // Pat shares a name, so the log knows her by her account alone. The
    // household login then moves to the newly admitted Robert. She cannot
    // claim her own history — nothing in the store names her — so the guard
    // has to be that somebody is still called what the log called her.
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES
                 (1, 'Pat Pederson', 'Pat'), (3, 'Pat Pederson', 'Patricia')`);
    await add(`INSERT INTO inat_account VALUES (1, 111, 'pandg')`);
    await record(promotion);

    await add(`DELETE FROM inat_account WHERE person_id = 1`);
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (2, 'Robert Pederson', 'Robert')`);
    await add(`INSERT INTO inat_account VALUES (2, 111, 'pandg')`);
    await record(promotion);

    const robert = await history({ ref: "name:Robert Pederson", altRef: "inat:111" });
    expect(robert.map((c) => c.new_value)).not.toContain("Pat");
    expect((await logged()).filter((r) => r[0] === "inat:111" && r[3] === "Robert Pederson")).toEqual([]);
    expect((await record(promotion)).appended).toBe(0);
  });

  it("gives a history to neither namesake when the log cannot tell them apart", async () => {
    // An accountless person's history carries no account, so nothing but the
    // shared name reaches it. Awarding it to whichever row the database
    // returned first decides by accident who inherits somebody's past.
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (1, 'Ada Collector', 'Ada')`);
    await record(promotion);
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (2, 'Ada Collector', 'Adele')`);
    await add(`INSERT INTO inat_account VALUES (1, 111, 'ada'), (2, 222, 'adele')`);
    await record(promotion);

    // Neither is recorded at all — not even as a new person, since somebody
    // the log cannot attribute, recorded as an arrival, arrives again on
    // every pass forever.
    expect((await logged()).filter((r) => r[0]!.startsWith("inat:"))).toEqual([]);
    expect((await record(promotion)).appended).toBe(0);
  });

  it("records what it can of an account shuffle and stays silent on the rest", async () => {
    // Ada takes over the account Bo has just left, and Bo moves to a new one.
    // Ada's rebinding is unambiguous and recorded. Bo's is not: his history
    // records the account Ada now holds, which is the same shape as a
    // newcomer trying to claim somebody else's past, so the log says nothing
    // rather than risk the fabrication.
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES
                 (1, 'Ada Collector', 'Ada'), (2, 'Bo Netter', 'Bo')`);
    await add(`INSERT INTO inat_account VALUES (1, 111, 'ada'), (2, 222, 'bo')`);
    await record(promotion);

    await add(`UPDATE inat_account SET inat_user_id = 333, login = 'bo2' WHERE person_id = 2`);
    await add(`UPDATE inat_account SET inat_user_id = 222, login = 'bo' WHERE person_id = 1`);
    await record(promotion);

    expect((await logged()).filter((r) => r[1] === "inat_user_id" && r[2] !== "")).toEqual([
      ["name:Ada Collector", "inat_user_id", "111", "222"],
    ]);
    expect((await record(promotion)).appended).toBe(0);
  });

  it("still refuses a swap once an abandoned history is left holding the account", async () => {
    // The guard used to weaken as the log aged: a person the store stopped
    // naming keeps whatever account they last held forever, and reading that
    // as "two holders, so no holder" switched the swap protection off for
    // every account that had ever moved.
    await add(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Pat Pederson'), (3, 'Pat Pederson')`);
    await add(`INSERT INTO inat_account VALUES (1, 111, 'pandg')`);
    await record(promotion);
    await add(`DELETE FROM inat_account WHERE person_id = 1`);
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (2, 'Robert Pederson', 'Robert')`);
    await add(`INSERT INTO inat_account VALUES (2, 111, 'pandg')`);
    await record(promotion); // Pat's history is now an abandoned holder of 111

    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (4, 'Sam Quill', 'Sam')`);
    await add(`INSERT INTO inat_account VALUES (4, 999, 'samq')`);
    await record(promotion);
    // Robert and Sam are now recorded under each other's names.
    await add(`UPDATE person SET display_name = 'x' WHERE entity_id = 2`);
    await add(`UPDATE person SET display_name = 'Robert Pederson' WHERE entity_id = 4`);
    await add(`UPDATE person SET display_name = 'Sam Quill' WHERE entity_id = 2`);
    await record(promotion);

    const rebindings = (await logged()).filter((r) => r[1] === "inat_user_id" && r[2] !== "");
    expect(rebindings).toEqual([]);
    expect((await record(promotion)).appended).toBe(0);
  });

  it("does not strip a present person's account for a newcomer who took their old name", async () => {
    // One rebuild respells Mary and mints an unrelated new Mary Smith. The
    // newcomer reaches the old history by name; the real Mary still holds the
    // account it records. Neither may have it.
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (1, 'Mary Smith', 'Mary')`);
    await add(`INSERT INTO inat_account VALUES (1, 555, 'msmith')`);
    await record(promotion);

    await add(`UPDATE person SET display_name = 'Mary A Smith' WHERE entity_id = 1`);
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (2, 'Mary Smith', 'Marion')`);
    const pass = await record(promotion);

    expect(pass.contested).toBeGreaterThan(0);
    const damage = (await logged()).filter((r) => r[0] === "name:Mary Smith" && r[2] !== "");
    expect(damage).toEqual([]);
    expect((await record(promotion)).appended).toBe(0);
  });

  it("does not hand a household's incoming partner the login-holder's history", async () => {
    // The Pedersons: a shared login moved off Pat and onto the newly admitted
    // Robert, the way an overlay `create` plus a binding does it. An account
    // passes between people here on purpose, so matching on it alone reads
    // that as Pat being renamed to Robert and gives Robert her whole past.
    await add(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Pat Pederson'), (3, 'Pat Pederson')`);
    await add(`INSERT INTO inat_account VALUES (1, 111, 'pandg')`);
    await record(promotion);
    await add(`DELETE FROM person WHERE entity_id = 3`); // the namesake was a duplicate, now merged away
    await add(`DELETE FROM inat_account WHERE person_id = 1`);
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (2, 'Robert Pederson', 'Robert')`);
    await add(`INSERT INTO inat_account VALUES (2, 111, 'pandg')`);
    await record(promotion);

    const robert = await history({ ref: "name:Robert Pederson", altRef: "inat:111" });
    expect(robert.map((c) => c.new_value)).not.toContain("Pat Pederson");
    expect(robert.filter((c) => c.field === "display_name").map((c) => c.old_value)).toEqual([""]);
    // And Pat is not renamed into Robert. Her own unbinding goes unrecorded
    // too — her history records the account Robert now holds, which is the
    // one shape this cannot read — but silence is the direction to err in.
    expect((await record(promotion)).appended).toBe(0);
    expect((await logged()).filter((r) => r[0] === "inat:111" && r[2] !== "")).toEqual([]);
  });

  it("keeps a person's history when an account, not a name, becomes their reference", async () => {
    // The same shape from the other side: her name became ambiguous, so the
    // account is what names her now. The history was written under the name.
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (1, 'Ada Collector', 'Ada')`);
    await add(`INSERT INTO inat_account VALUES (1, 111, 'adacollects')`);
    await record(promotion);
    await add(`INSERT INTO person (entity_id, display_name) VALUES (2, 'Ada Collector')`);
    await record(promotion);

    // Nothing happened to her when the namesake arrived, so nothing is said.
    expect((await logged()).filter((r) => r[0] === "inat:111")).toEqual([]);

    // Back to a name of her own: her history is one story, not three.
    await add(`DELETE FROM person WHERE entity_id = 2`);
    await record(promotion);
    const hers = await history({ ref: "name:Ada Collector", altRef: "inat:111" });
    expect(hers.map((c) => c.field)).toContain("given_name");
    expect((await logged()).filter((r) => r[3] === "")).toEqual([]);
    expect((await record(promotion)).appended).toBe(0);
  });

  it("cannot name somebody who shares a display name and holds no account", async () => {
    await add(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Ada Collector'), (2, 'Ada Collector')`);
    await add(`INSERT INTO inat_account VALUES (1, 111, 'adacollects')`);
    const result = await record(promotion);

    expect(result.unreferenceable).toBe(1);
    expect((await logged()).map((r) => r[0])).toEqual(["inat:111", "inat:111", "inat:111"]);
  });

  it("appends nothing on a second pass for a delegation grant either", async () => {
    // acts_for is built by one SQL query here and a parallel one in
    // src/app/roster.ts; a formatting difference between them would show up
    // as a change on every single pass.
    await add(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Ada Collector'), (2, 'Bo Netter'), (3, 'Cal Digger')`);
    await add(`INSERT INTO person_delegate (person_id, acts_for_id) VALUES (1, 3), (1, 2)`);
    await record(promotion);

    expect((await logged()).filter((r) => r[1] === "acts_for")).toEqual([
      ["name:Ada Collector", "acts_for", "", "name:Bo Netter;name:Cal Digger"],
    ]);
    expect((await record(promotion)).appended).toBe(0);
  });

  it("records membership and admin in the vocabulary the screen shows", async () => {
    await add(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Ada Collector')`);
    await add(`INSERT INTO person_membership (person_id, kind, atlas_id)
               VALUES (1, 'atlas', (SELECT entity_id FROM atlas WHERE code = 'OBA'))`);
    await add(`INSERT INTO person_admin (person_id) VALUES (1)`);
    await record(promotion);

    expect(await logged()).toEqual([
      ["name:Ada Collector", "membership", "", "OBA"],
      ["name:Ada Collector", "admin", "no", "yes"],
      ["name:Ada Collector", "display_name", "", "Ada Collector"],
    ]);
  });
});

describe("a rename moves the reference, and the history goes with it", () => {
  const renamed: PersonChange = {
    at: "2026-08-01T00:00:00.000Z",
    person_ref: "name:Ada Collector",
    field: "display_name",
    old_value: "Ada Collector",
    new_value: "Ada Collector-Smith",
    author: "staffer",
    source: "app",
    reason: "married",
  };

  it("joins the two names, so a rebuild does not read the new one as an arrival", async () => {
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (1, 'Ada Collector', 'Ada')`);
    await record(promotion);
    // The rename, as the roster screen would record it: filed under the name
    // being left behind, because that is the reference the overlay used too.
    await appendChanges(path, [renamed]);
    await add(`UPDATE person SET display_name = 'Ada Collector-Smith' WHERE entity_id = 1`);

    expect((await record(promotion)).appended).toBe(0);
  });

  it("finds the old name's entries from the new one", async () => {
    const changes = [
      {
        ...renamed,
        at: "2026-07-01T00:00:00.000Z",
        field: "given_name" as const,
        old_value: "",
        new_value: "Ada",
      },
      renamed,
    ];
    const fields = Object.fromEntries(CHANGE_FIELDS.map((f) => [f, ""])) as Record<ChangeField, string>;
    const found = historyFor(changes, new Set(["Ada Collector-Smith"]), {
      ref: "name:Ada Collector-Smith",
      altRef: null,
      fields: { ...fields, display_name: "Ada Collector-Smith" },
    });

    expect(found.map((c) => c.field)).toEqual(["display_name", "given_name"]);
  });

  it("does not hand one person's history to whoever takes the name they left", async () => {
    // Ada is renamed; later somebody else is corrected INTO the name she
    // vacated. Treating every rename as evidence that two names are one
    // person merged them, and then reported the difference between them on
    // every pass, forever.
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (1, 'Ada Collector', 'Ada')`);
    await record(promotion);
    await appendChanges(path, [renamed]);
    await add(`UPDATE person SET display_name = 'Ada Collector-Smith' WHERE entity_id = 1`);
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES (2, 'Cal Digger', 'Cal')`);
    await record(promotion);
    await add(`UPDATE person SET display_name = 'Ada Collector' WHERE entity_id = 2`);
    await record(promotion);

    // Cal's page shows Cal, not Ada.
    const mine = await history({ ref: "name:Ada Collector", altRef: null });
    expect(mine.map((c) => c.new_value)).not.toContain("Ada");
    // And it settles: nothing more to say on the next pass.
    expect((await record(promotion)).appended).toBe(0);
  });

  it("settles after two people swap names, rather than reporting the difference forever", async () => {
    await add(`INSERT INTO person (entity_id, display_name, given_name) VALUES
                 (1, 'Ada Collector', 'Ada'), (2, 'Bo Netter', 'Bo')`);
    await record(promotion);
    await appendChanges(path, [
      { ...renamed, person_ref: "name:Ada Collector", old_value: "Ada Collector", new_value: "Bo Netter" },
      { ...renamed, person_ref: "name:Bo Netter", old_value: "Bo Netter", new_value: "Ada Collector" },
    ]);
    await add(`UPDATE person SET display_name = 'x' WHERE entity_id = 1`);
    await add(`UPDATE person SET display_name = 'Ada Collector' WHERE entity_id = 2`);
    await add(`UPDATE person SET display_name = 'Bo Netter' WHERE entity_id = 1`);

    await record(promotion);
    expect((await record(promotion)).appended).toBe(0);
    expect((await record(promotion)).appended).toBe(0);
  });

  it("takes the last value recorded, whatever timestamp it carries", () => {
    // The file's order is append order, and nothing can restate it after the
    // fact. A timestamp can be skewed or hand-written, so it is a fact stored
    // in an entry rather than the order the entries are read in.
    const first = { ...renamed, field: "given_name" as const, old_value: "", new_value: "Ada" };
    const backdated = { ...first, at: "2026-01-01T00:00:00.000Z", old_value: "Ada", new_value: "Adaline" };
    expect(lastKnown([first, backdated]).of("name:Ada Collector")?.fields.get("given_name")).toBe("Adaline");
  });
});

describe("what a decision on the roster screen records", () => {
  it("says what it was, what it became, who decided, and why", async () => {
    await add(`INSERT INTO person (entity_id, display_name, family_name) VALUES (1, 'Ada Collector', 'Collector')`);
    const read = duckdbReader(conn);
    const before = [...(await readPersonStates(read, "p.entity_id = 1")).states.values()][0];
    await add(`UPDATE person SET family_name = 'Collector-Smith' WHERE entity_id = 1`);
    const after = [...(await readPersonStates(read, "p.entity_id = 1")).states.values()][0];

    const rows = diffPerson("name:Ada Collector", before, after, {
      source: "app",
      author: "staffer",
      reason: "married",
      at: "2026-08-01T00:00:00.000Z",
    });
    expect(rows).toEqual([
      {
        at: "2026-08-01T00:00:00.000Z",
        person_ref: "name:Ada Collector",
        field: "family_name",
        old_value: "Collector",
        new_value: "Collector-Smith",
        author: "staffer",
        source: "app",
        reason: "married",
      },
    ]);
  });

  it("leaves nothing behind for a save that changed nothing", async () => {
    await add(`INSERT INTO person (entity_id, display_name) VALUES (1, 'Ada Collector')`);
    const state = [...(await readPersonStates(duckdbReader(conn), "p.entity_id = 1")).states.values()][0];
    expect(diffPerson("name:Ada Collector", state, state, { source: "app" })).toEqual([]);
  });
});

describe("the file", () => {
  it("survives a value with a comma, a quote, and a newline in it", async () => {
    const row: PersonChange = {
      at: "2026-08-01T00:00:00.000Z",
      person_ref: 'name:Ada "Bee" Collector, Jr.',
      field: "label_name",
      old_value: "",
      new_value: "line one\nline two",
      author: "staffer",
      source: "app",
      reason: "as they sign it",
    };
    await appendChanges(path, [row]);
    expect(await readChanges(path)).toEqual([row]);
  });

  it("skips a row it cannot read rather than refusing the whole file", () => {
    // The opposite of both overlays, and for a stated reason: appending never
    // erases, so a bad row can only cost itself — where refusing would take
    // every screen that reads history down with it.
    const text = [
      "at,person_ref,field,old_value,new_value,author,source,reason",
      "2026-08-01T00:00:00.000Z,name:Ada,display_name,,Ada,staffer,app,",
      "not,enough,fields",
      "2026-08-02T00:00:00.000Z,name:Ada,not_a_field,,x,staffer,app,",
      "2026-08-03T00:00:00.000Z,name:Ada,given_name,,Ada,staffer,app,",
    ].join("\n");
    const { changes, malformed } = parseChanges(text);

    expect(malformed).toBe(2);
    expect(changes.map((c) => c.field)).toEqual(["display_name", "given_name"]);
  });

  it("repairs a last line with no newline instead of fusing onto it", async () => {
    // A hand edit or a crash between the partial write and its completion.
    // Appending blindly would make one unreadable row out of two — and the
    // old one's author and reason are exactly what no later pass can recover.
    await writeFile(
      path,
      "at,person_ref,field,old_value,new_value,author,source,reason\n" +
        "2026-08-01T00:00:00.000Z,name:Ada,given_name,,Ada,staffer,app,first edit",
    );
    await appendChanges(path, [
      { at: "2026-08-02T00:00:00.000Z", person_ref: "name:Ada", field: "family_name", old_value: "", new_value: "Collector", author: "staffer", source: "app", reason: "second edit" },
    ]);
    expect((await readChanges(path)).map((c) => c.reason)).toEqual(["first edit", "second edit"]);
  });

  it("reads a log that does not exist yet as empty", async () => {
    expect(await readChanges(join(tmpdir(), "definitely-not-here.csv"))).toEqual([]);
  });

  it("appends to what is already there, from a second writer", async () => {
    // The app and an ingest CLI are two processes, which is exactly why this
    // file is appended to rather than restated the way the overlays are.
    await writeFile(path, "at,person_ref,field,old_value,new_value,author,source,reason\n");
    await appendChanges(path, [
      { at: "2026-08-01T00:00:00.000Z", person_ref: "name:Ada", field: "given_name", old_value: "", new_value: "Ada", author: "", source: "reconcile", reason: "" },
    ]);
    await appendChanges(path, [
      { at: "2026-08-02T00:00:00.000Z", person_ref: "name:Bo", field: "given_name", old_value: "", new_value: "Bo", author: "", source: "reconcile", reason: "" },
    ]);
    expect((await readChanges(path)).map((c) => c.person_ref)).toEqual(["name:Ada", "name:Bo"]);
    expect((await readFile(path, "utf8")).split("\n").filter((l) => l !== "")).toHaveLength(3);
  });
});

describe("the newest entries, across everybody", () => {
  it("names each one by who that person is called now", () => {
    const at = (n: number) => `2026-08-0${n}T00:00:00.000Z`;
    const base = { author: "staffer", source: "app" as const, reason: "" };
    const changes: PersonChange[] = [
      { ...base, at: at(1), person_ref: "name:Ada Collector", field: "display_name", old_value: "", new_value: "Ada Collector" },
      { ...base, at: at(2), person_ref: "name:Ada Collector", field: "display_name", old_value: "Ada Collector", new_value: "Ada Collector-Smith" },
      { ...base, at: at(3), person_ref: "inat:429964", field: "login", old_value: "old", new_value: "new" },
    ];
    const recent = recentChanges(changes, 3);

    expect(recent.map((c) => c.current_name)).toEqual([
      // Newest first, and the two entries under the old reference now carry
      // the name that reference resolves to.
      null,
      "Ada Collector-Smith",
      "Ada Collector-Smith",
    ]);
  });
});
