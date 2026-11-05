import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

/**
 * Every cookie Beeline sets, with one set of attributes (beeline-73c9).
 *
 * Browsers treat every subdomain of a site as the same site, and
 * melittologist.org's subdomains reach servers Beeline does not run: old
 * Beeline's on old.melittologist.org and every name the zone's wildcard
 * catches, and a separate host on member.melittologist.org. A cookie set by
 * any of them for the whole domain would arrive here as though Beeline had
 * set it — a session signed in as somebody else, so a volunteer's work lands
 * in the wrong account, or an OAuth state that defeats the check it exists
 * for. A browser lets no host but this one set a cookie whose name begins
 * `__Host-`, so whenever the cookie can be Secure, which that prefix
 * requires, that is its name.
 *
 * Secure follows the origin, so it is off on a plain-http development
 * origin, where the prefix cannot apply and the bare name is used.
 * Everything else is the same for every cookie: the whole site's path, no
 * Domain (which the prefix also requires), HttpOnly, and SameSite=Lax.
 */
export interface CookieJar {
  get(c: Context, base: string): string | undefined;
  set(c: Context, base: string, value: string, opts?: { maxAge?: number }): void;
  delete(c: Context, base: string): void;
  /** The name a cookie goes by here: `__Host-` + base whenever it is Secure. */
  name(base: string): string;
  secure: boolean;
}

export function cookieJar(origin: string): CookieJar {
  const secure = origin.startsWith("https:");
  const name = (base: string) => (secure ? `__Host-${base}` : base);
  return {
    secure,
    name,
    get: (c, base) => getCookie(c, name(base)),
    set: (c, base, value, opts = {}) =>
      setCookie(c, name(base), value, { path: "/", httpOnly: true, sameSite: "Lax", secure, ...opts }),
    delete: (c, base) => deleteCookie(c, name(base), { path: "/", secure }),
  };
}

/** The session cookie's base name; see {@link cookieJar} for the name it goes by. */
export const SESSION_COOKIE = "beeline_session";
