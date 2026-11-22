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

/**
 * Sites of the iNaturalist Network that are not under inaturalist.org, a bare
 * name each (a leading `www.` is dropped before the lookup). From iNaturalist's
 * own list, `GET https://api.inaturalist.org/v1/sites`, read 2026-11-22. Every
 * other member is `inaturalist.org` or a subdomain of it (uk.inaturalist.org).
 * A new member outside that domain is added here.
 */
const OTHER_NETWORK_DOMAINS = new Set([
  "inaturalist.nz",
  "inaturalist.ca",
  "biodiversity4all.org",
  "inaturalist.ala.org.au",
  "argentinat.org",
  "inaturalist.mma.gob.cl",
  "inaturalist.laji.fi",
  "inaturalist.se",
  "inaturalist.lu",
  "naturalista.uy",
]);

const onNetwork = (host: string) => {
  const bare = host.toLowerCase().replace(/^www\./, "");
  return bare === "inaturalist.org" || bare.endsWith(".inaturalist.org") || OTHER_NETWORK_DOMAINS.has(bare);
};

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
  if (!onNetwork(domain!) || !ID.test(digits!)) return null;
  return { id: Number(digits), fromUrl: true };
}
