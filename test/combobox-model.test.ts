import { describe, expect, it } from "vitest";
import { filterOptions, keyAction, matchesWords, type KeyState } from "../src/app/islands/combobox-model.js";

/** The combobox's rules (beeline-wn2), apart from any DOM. */

describe("matchesWords", () => {
  it.each([
    ["bom vos", "Bombus vosnesenskii", true],
    ["b vos", "Bombus vosnesenskii", true],
    ["vos bom", "Bombus vosnesenskii", false],
    ["fin", "Finley NWR", true],
    ["nwr", "Finley NWR", true],
    ["melan", "Andrena (Melandrena)", true],
    ["inley", "Finley NWR", false],
    ["", "Finley NWR", false],
  ])("%s in %s: %s", (query, text, expected) => {
    expect(matchesWords(query, text)).toBe(expected);
  });
});

describe("filterOptions", () => {
  const options = [{ value: "Finley NWR" }, { value: "Muddy Creek CG" }, { value: "Philomath", label: "Philomath (town)" }];
  it("shows every option for an empty box, and for one holding an option exactly", () => {
    expect(filterOptions(options, "")).toHaveLength(3);
    expect(filterOptions(options, "Muddy Creek CG")).toHaveLength(3);
  });
  it("narrows to the options a query matches, by value or label", () => {
    expect(filterOptions(options, "mud").map((o) => o.value)).toEqual(["Muddy Creek CG"]);
    expect(filterOptions(options, "town").map((o) => o.value)).toEqual(["Philomath"]);
    expect(filterOptions(options, "Corvallis")).toEqual([]);
  });
});

describe("keyAction", () => {
  const closed: KeyState = { open: false, active: -1, count: 3, free: true };
  const open: KeyState = { open: true, active: 1, count: 3, free: true };

  it("opens on Down, and moves the highlight within the list", () => {
    expect(keyAction(closed, "ArrowDown")).toMatchObject({ open: true, active: 0, prevent: true });
    expect(keyAction(open, "ArrowDown")).toMatchObject({ active: 2 });
    expect(keyAction({ ...open, active: 2 }, "ArrowDown")).toMatchObject({ active: 2 });
    expect(keyAction(open, "ArrowUp")).toMatchObject({ active: 0 });
    expect(keyAction({ ...open, active: 0 }, "ArrowUp")).toMatchObject({ active: 0 });
  });

  it("takes the highlighted option on Enter, and otherwise lets free text submit", () => {
    expect(keyAction(open, "Enter")).toMatchObject({ open: false, pick: true, prevent: true });
    expect(keyAction({ ...open, active: -1 }, "Enter")).toMatchObject({ pick: false, prevent: false });
    expect(keyAction({ ...open, active: -1, free: false }, "Enter")).toMatchObject({ pick: false, prevent: true });
  });

  it("closes on the first Escape and puts the value back on the second, telling the page each time", () => {
    expect(keyAction(open, "Escape")).toMatchObject({ open: false, revert: false, cancel: true });
    expect(keyAction(closed, "Escape")).toMatchObject({ revert: true, cancel: true });
  });

  it("never picks on Tab", () => {
    expect(keyAction(open, "Tab")).toMatchObject({ open: false, pick: false, prevent: false });
  });
});
