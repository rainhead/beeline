/**
 * What a person typed in the search box, read as an iNaturalist observation
 * when it is one (beeline-slkv). Two things count: the address of an
 * observation page on any site of the iNaturalist Network, and a bare number.
 * Anything else is `null`, and the box searches as it always did.
 *
 * The Network's sites share observation numbers, so the host is only checked
 * to be one of them: `www.` is optional, and the scheme, a trailing slash, a
 * query string and a fragment are ignored. An observation's UUID address is
 * not read, because Beeline keeps only the number.
 */

/** The Network's own domains, a bare name each. A copy of iNaturalist's list: a new member is added here. */
const NETWORK_DOMAINS = new Set([
  "inaturalist.org",
  "inaturalist.ca",
  "inaturalist.nz",
  "inaturalist.lu",
  "inaturalist.se",
  "inaturalist.fi",
  "naturalista.mx",
  "biodiversity4all.org",
]);

/** A number that fits the store's BIGINT with room to spare; a longer run of digits is not an observation number. */
const MAX_DIGITS = 15;

export interface ObservationSearch {
  /** The observation's number. */
  id: number;
  /** Typed as an address, so the text can mean nothing else; a bare number could also be part of a sample or field number. */
  fromUrl: boolean;
}

const ID = new RegExp(`^[0-9]{1,${MAX_DIGITS}}$`);
const ADDRESS = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+)\/observations\/([0-9]+)\/?(?:[?#].*)?$/i;

export function observationFromSearch(typed: string): ObservationSearch | null {
  const text = typed.trim();
  if (ID.test(text)) return { id: Number(text), fromUrl: false };
  const address = ADDRESS.exec(text);
  if (address === null) return null;
  const [, domain, digits] = address;
  if (!NETWORK_DOMAINS.has(domain!.toLowerCase()) || !ID.test(digits!)) return null;
  return { id: Number(digits), fromUrl: true };
}
