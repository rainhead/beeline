/**
 * How to write a person's name.
 *
 * Two forms, one source. The **full** form is what screens and Darwin Core
 * exports use (`recordedBy`); the **label** form is what a 3pt label has room
 * for — "P. Abrahamsen". Deriving the second from the first is guesswork the
 * moment a family name has more than one word, so the parts are stored
 * (`person.given_name`, `person.family_name`) and the label form is derived
 * from them — with `person.label_name` as the override for whatever
 * derivation gets wrong or a person would rather see.
 *
 * Not JSX: label rendering will happen outside the HTML views, and both paths
 * must produce the same string.
 */

export interface PersonNameParts {
  display_name: string;
  given_name?: string | null;
  family_name?: string | null;
  /** Overrides the derived label form entirely. */
  label_name?: string | null;
}

const trimmed = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

/** The full form: what a screen shows, and what an export writes. */
export function fullName(person: PersonNameParts): string {
  return person.display_name;
}

/**
 * The label form. `label_name` wins; otherwise the given name contributes an
 * initial and the family name is printed whole — particles and hyphens ride
 * along, because a family name is never re-split here. With no family name to
 * abbreviate against (a mononym, or an import nobody has parted yet) the full
 * form is the honest answer: a label with a too-long name beats a wrong one.
 */
export function labelName(person: PersonNameParts): string {
  const override = trimmed(person.label_name);
  if (override !== null) return override;

  const family = trimmed(person.family_name);
  if (family === null) return person.display_name;

  const given = trimmed(person.given_name);
  if (given === null) return family;
  // Only the first given name is abbreviated: "Mary Jo Mosby" prints as
  // "M. Mosby", and anyone who wants "M. J. Mosby" sets label_name.
  const initial = [...given][0]!;
  return `${initial.toUpperCase()}. ${family}`;
}
