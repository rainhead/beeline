import { describe, expect, it } from "vitest";
import { NumberIndex, numberTokens, pastedList, MAX_RANGE } from "../src/determination-numbers.js";

// Shaped like one collector's numbers on the dev store: eight-digit numbers
// from 2025 on, seven-digit ones before, and two numbers sharing the tail
// 685 (26019685 and 26027685), which is the case that made a three-digit
// tail unsafe to take on trust.
const specimens = [
  { id: 1, fieldNumber: "26019685" },
  { id: 2, fieldNumber: "26019686" },
  { id: 3, fieldNumber: "26019687" },
  { id: 4, fieldNumber: "26019690" },
  { id: 5, fieldNumber: "26027685" },
  { id: 6, fieldNumber: "26027608" },
  { id: 7, fieldNumber: "2454162" },
  { id: 8, fieldNumber: "2108128" },
  { id: 9, fieldNumber: null },
];
const index = new NumberIndex(specimens);
const spans = [
  { digits: 7, first: "2108128", last: "2454162" },
  { digits: 8, first: "26019685", last: "26027685" },
];

describe("numberTokens", () => {
  it("splits on commas, spaces, semicolons and line breaks, and joins around dashes", () => {
    expect(numberTokens("26019685 - 690, 26027608;2454162\n412")).toEqual(["26019685-690", "26027608", "2454162", "412"]);
  });

  it("treats an en or em dash as a range", () => {
    expect(numberTokens("26019685–690 26019685—690")).toEqual(["26019685-690", "26019685-690"]);
  });
});

describe("pastedList", () => {
  it("turns a spreadsheet column into one comma-separated line", () => {
    expect(pastedList("26027608\r\n26019692\n\n26019693\t")).toBe("26027608, 26019692, 26019693");
  });
});

describe("NumberIndex.resolve", () => {
  it("finds a whole number", () => {
    expect(index.resolve("26027608")).toEqual({ text: "26027608", ids: [6], problem: null });
  });

  it("finds a number of the older, seven-digit kind", () => {
    expect(index.resolve("2454162").ids).toEqual([7]);
  });

  it("takes a tail when exactly one number ends that way, and writes it out whole", () => {
    expect(index.resolve("608")).toEqual({ text: "26027608", ids: [6], problem: null });
  });

  it("refuses a tail several numbers end in, naming some of them", () => {
    expect(index.resolve("685").problem).toEqual({ code: "ambiguous", typed: "685", count: 2, examples: ["26019685", "26027685"] });
  });

  it("does not guess from fewer than three digits", () => {
    expect(index.resolve("85").problem?.code).toBe("notTheirs");
  });

  it("says when a number has a digit count none of theirs has", () => {
    expect(index.resolve("260196850").problem).toEqual({ code: "digits", typed: "260196850", spans });
  });

  it("says a well-formed number is simply not theirs", () => {
    expect(index.resolve("26099999").problem?.code).toBe("notTheirs");
  });

  it("refuses what is not a number", () => {
    expect(index.resolve("abc").problem).toEqual({ code: "notNumber" });
  });

  it("expands an abbreviated range end from the start", () => {
    expect(index.resolve("26019685-690")).toEqual({ text: "26019685–26019690", ids: [1, 2, 3, 4], problem: null });
  });

  it("takes a full range end as written", () => {
    expect(index.resolve("26019685-26019687").ids).toEqual([1, 2, 3]);
  });

  it("lets a range begin in a gap between their numbers", () => {
    expect(index.resolve("26019680-686").ids).toEqual([1, 2]);
  });

  it("lets a range start with a tail, when it names one number", () => {
    expect(index.resolve("9685-687")).toEqual({ text: "26019685–26019687", ids: [1, 2, 3], problem: null });
  });

  it("answers a dropped digit with the span of each length, so the slip shows", () => {
    // The case that surfaced the old wording, "start a range with a whole
    // number": seven digits is a real length here — numbers before 2025 —
    // so the range is well formed and simply holds none of theirs.
    expect(index.resolve("2607065-2607200").problem).toEqual({ code: "emptyRange", digits: 7, spans });
  });

  it("explains a range whose start is a tail several numbers share, in terms of the start", () => {
    expect(index.resolve("685-690").problem).toEqual({
      code: "rangeStart",
      problem: { code: "ambiguous", typed: "685", count: 2, examples: ["26019685", "26027685"] },
    });
  });

  it("refuses a range that runs backwards", () => {
    expect(index.resolve("26019690-685").problem).toEqual({ code: "backwards" });
  });

  it("refuses a range too long to be a box", () => {
    expect(index.resolve(`26000000-${26000000 + MAX_RANGE}`).problem).toEqual({ code: "tooLong", max: MAX_RANGE });
  });

  it("refuses a range whose ends cannot be the same length", () => {
    expect(index.resolve("26019685-123456789").problem).toEqual({ code: "lengthsDiffer", start: "26019685", end: "123456789" });
  });

  it("says when a range holds none of their numbers", () => {
    expect(index.resolve("26080000-100").problem?.code).toBe("emptyRange");
  });

  it("never mixes digit counts within a range", () => {
    // 2454162 is numerically inside 2000000-3000000 but is the only seven-digit match.
    expect(index.resolve("2000000-2001999").ids).toEqual([]);
  });

  it("says so when the person has no specimens at all", () => {
    expect(new NumberIndex([]).resolve("26019685").problem).toEqual({ code: "noSpecimens" });
  });
});

describe("NumberIndex.resolveAll", () => {
  it("resolves each entry in the order given", () => {
    expect(index.resolveAll("26027608, 9685-686, 685").map((e) => [e.text, e.ids, e.problem?.code ?? null])).toEqual([
      ["26027608", [6], null],
      ["26019685–26019686", [1, 2], null],
      ["685", [], "ambiguous"],
    ]);
  });
});

describe("what a problem says", async () => {
  const { problemText } = await import("../src/app/islands/determine/problems.js");

  it("names a dropped digit rather than doing arithmetic at the volunteer", () => {
    expect(problemText(index.resolve("2607065-2607200").problem!)).toBe(
      "None of your field numbers fall in that range. Is a digit missing? Your newest have 8 digits, like 26027685.",
    );
  });

  it("gives the spans where a missing digit is not the likely story", () => {
    expect(problemText(index.resolve("26080000-100").problem!)).toBe(
      "None of your field numbers fall in that range. Yours run 2108128 to 2454162 (7 digits) and 26019685 to 26027685 (8 digits).",
    );
  });

  it("says which numbers share a tail", () => {
    expect(problemText(index.resolve("685").problem!)).toBe(
      "2 of your field numbers end in 685 (26019685, 26027685). Type more of it.",
    );
  });
});

describe("what a problem says, for a dropped digit at the start of a range", async () => {
  const { problemText } = await import("../src/app/islands/determine/problems.js");
  const eightOnly = new NumberIndex([{ id: 1, fieldNumber: "26001001" }, { id: 2, fieldNumber: "26001021" }]);

  it("asks about the missing digit and nothing else", () => {
    expect(problemText(eightOnly.resolve("2600101-2600105").problem!)).toBe(
      "2600101 has 7 digits. Is one missing? Your newest have 8, like 26001021.",
    );
  });
});
