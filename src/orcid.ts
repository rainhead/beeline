/**
 * ORCID iDs (https://orcid.org), which credit a person in Darwin Core's
 * recordedByID and identifiedByID (beeline-0544).
 *
 * Stored bare — `0000-0002-1825-0097` — and written out as the URL ORCID
 * asks every display and export to use. An iD's last character is a check
 * digit (ISO 7064 MOD 11-2, where 10 is written X), so a typo in the
 * sixteen digits is refused rather than crediting a stranger:
 * https://support.orcid.org/hc/en-us/articles/360006897674.
 */

const BARE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

/** The check digit of an iD's first fifteen digits. */
function checkDigit(digits: string): string {
  let total = 0;
  for (const d of digits) total = (total + Number(d)) * 2;
  const result = (12 - (total % 11)) % 11;
  return result === 10 ? "X" : String(result);
}

/**
 * The bare iD in what someone typed or iNaturalist reported — a bare iD, or
 * one as a URL (`https://orcid.org/…`, with or without the scheme) — or null
 * if it is not a valid one. A lowercase x is read as the X it means.
 */
export function parseOrcid(text: string): string | null {
  const bare = text
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?orcid\.org\//i, "")
    .replace(/\/$/, "")
    .toUpperCase();
  if (!BARE.test(bare)) return null;
  const digits = bare.replaceAll("-", "");
  return checkDigit(digits.slice(0, 15)) === digits[15] ? bare : null;
}

/** The iD as ORCID asks it to be shown and exported. */
export const orcidUrl = (orcid: string) => `https://orcid.org/${orcid}`;
