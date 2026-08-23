import { describe, expect, test } from "vitest";
import { fullName, labelName } from "../src/person-name.js";

/**
 * Every case here is a real name from the legacy data (beeline-77j) — these
 * are the shapes that break a "last whitespace token" rule.
 */
describe("the label form of a person's name", () => {
  test("abbreviates the given name and prints the family name", () => {
    expect(labelName({ display_name: "Peter Abrahamsen", given_name: "Peter", family_name: "Abrahamsen" })).toBe(
      "P. Abrahamsen",
    );
  });

  test("keeps a particle with the family name", () => {
    expect(
      labelName({ display_name: "Maarten Van Otterloo", given_name: "Maarten", family_name: "Van Otterloo" }),
    ).toBe("M. Van Otterloo");
    expect(
      labelName({ display_name: "Charlie Vanden Heuvel", given_name: "Charlie", family_name: "Vanden Heuvel" }),
    ).toBe("C. Vanden Heuvel");
  });

  test("keeps a second family name", () => {
    expect(
      labelName({
        display_name: "Juan Manuel Benitez Alvarez",
        given_name: "Juan Manuel",
        family_name: "Benitez Alvarez",
      }),
    ).toBe("J. Benitez Alvarez");
  });

  test("abbreviates only the first given name", () => {
    expect(labelName({ display_name: "Mary Jo Mosby", given_name: "Mary Jo", family_name: "Mosby" })).toBe("M. Mosby");
  });

  test("leaves a hyphenated family name whole", () => {
    expect(labelName({ display_name: "Sarah Red-Laird", given_name: "Sarah", family_name: "Red-Laird" })).toBe(
      "S. Red-Laird",
    );
  });

  test("an override wins over the derived form", () => {
    expect(
      labelName({
        display_name: "Karen G. Barron",
        given_name: "Karen",
        family_name: "G. Barron",
        label_name: "K. Barron",
      }),
    ).toBe("K. Barron");
  });

  test("without parts, the full name prints — a long name beats a wrong one", () => {
    expect(labelName({ display_name: "Michael O'Loughlin | Dan O'Loughlin" })).toBe(
      "Michael O'Loughlin | Dan O'Loughlin",
    );
    expect(labelName({ display_name: "Prince", given_name: null, family_name: null })).toBe("Prince");
  });

  test("a family name with no given name stands alone", () => {
    expect(labelName({ display_name: "Melathopoulos", family_name: "Melathopoulos" })).toBe("Melathopoulos");
  });

  test("blank parts count as absent, and an initial is upper-cased", () => {
    expect(labelName({ display_name: "ac Quinn", given_name: "  ", family_name: "Quinn" })).toBe("Quinn");
    expect(labelName({ display_name: "ac Quinn", given_name: "ac", family_name: "Quinn" })).toBe("A. Quinn");
    expect(labelName({ display_name: "Jo Noren", given_name: "Jo", family_name: "Noren", label_name: "  " })).toBe(
      "J. Noren",
    );
  });

  test("the full form is the display name, untouched", () => {
    expect(fullName({ display_name: "Andony Melathopoulos", given_name: "Andony", family_name: "Melathopoulos" })).toBe(
      "Andony Melathopoulos",
    );
  });
});
