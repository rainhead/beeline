import type { Env, Hono } from "hono";

/**
 * Where the old Beeline runs from cutover (beeline-83b8.12). New Beeline takes
 * melittologist.org on 3 November 2026, and the old system moves here and
 * keeps running, its volunteer determination screens open, at least through
 * February (Peter, 2026-11-03): volunteers were not warned about the new
 * interface, so they are not pushed onto it. What they enter there comes into
 * this store by another route (beeline-c43w).
 *
 * Everything in this file is temporary, and goes when the old Beeline does.
 */
export const OLD_BEELINE_ORIGIN = "https://old.melittologist.org";

/**
 * The old interface's own pages (its client/src/Main.jsx), none of which this
 * app uses, so a bookmark to one is sent to the same page on the old
 * Beeline's new address. `/determinations` is missing on purpose: it is this
 * app's own page, so a volunteer who bookmarked the old one lands on the
 * sign-in page here, which says where the old Beeline went.
 */
export const OLD_BEELINE_PAGES = [
  "/volunteerLogin",
  "/adminLogin",
  "/dashboard",
  "/tasks",
  "/datasets",
  "/scripts",
  "/admin",
] as const;

/**
 * Registered ahead of the session gate, since nobody arriving from an old
 * bookmark is signed in here. The target's origin is fixed and its path is one
 * of the routes above, so nothing a visitor writes can send them elsewhere.
 * Temporary redirects (302, and 307 for the API, which keeps the method and
 * body), because the old Beeline goes away.
 */
export function registerOldBeelineRedirects<E extends Env>(app: Hono<E>): void {
  const target = (url: string) => {
    const { pathname, search } = new URL(url);
    return `${OLD_BEELINE_ORIGIN}${pathname}${search}`;
  };
  for (const page of OLD_BEELINE_PAGES) {
    app.get(page, (c) => c.redirect(target(c.req.url), 302));
  }
  // The old interface's API, should anything still call it here.
  app.all("/api/*", (c) => c.redirect(target(c.req.url), 307));
}
