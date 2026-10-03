import { secureHeaders } from "hono/secure-headers";

/**
 * Security headers on every response, from one place (beeline-m9o) — the
 * way the session gate covers every route: registered first in createApp, so
 * a route cannot be added without them, error pages and static files
 * included.
 *
 * The policy is what the app actually loads, stated narrowly:
 * - scripts: the one Vite-built island bundle, same-origin. No inline script
 *   and no inline handlers anywhere; the `application/json` data block on
 *   /determinations is not script and CSP does not apply to it.
 * - styles: same-origin stylesheets (tokens.css included). Inline `style=`
 *   attributes are allowed through `style-src-attr` alone — the /design pages
 *   and the static error page use them (Peter, 2026-10-03) — and inline
 *   `<style>` elements stay forbidden, since nothing uses one.
 * - images: same-origin, plus iNaturalist's static host for the account
 *   menu's avatar (`private.inat_oauth_token.icon_url`). Pinned to the host
 *   rather than `https:`.
 * - connections: the islands fetch only same-origin JSON.
 * - forms: same-origin only. Sign-in starts from a link, not a form, so the
 *   redirect to iNaturalist is a top-level navigation `form-action` does not
 *   govern.
 * - framing: nobody, which `frame-ancestors` says and the old
 *   X-Frame-Options header repeats for browsers that predate it.
 *
 * Referrer-Policy is NOT hono's `no-referrer`: the error page's way back
 * reads the Referer of a same-site page that linked there (errorResponse in
 * server.tsx), so the full URL is kept same-origin and only the origin goes
 * elsewhere.
 *
 * HSTS is left off in development, where the app runs over plain http.
 */
export function securityHeaders(environment: string) {
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      styleSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "https://static.inaturalist.org"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      objectSrc: ["'none'"],
    },
    xFrameOptions: "DENY",
    referrerPolicy: "strict-origin-when-cross-origin",
    strictTransportSecurity: environment === "development" ? false : "max-age=15552000; includeSubDomains",
  });
}
