import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Kysely } from "kysely";
import type { Database } from "../model.js";
import { keyRateLimiter, resolveKey, type KeyHolder } from "./api-keys.js";
import { reportAppError } from "./error-reporting.js";

/**
 * The API, under /api/v1/ (beeline-pnqr).
 *
 * For programs, not browsers: every request carries a personal API key as a
 * bearer header (src/app/api-keys.ts) and every answer is JSON, errors
 * included. It is mounted ahead of the session gate and never calls it, so a
 * session cookie means nothing here; and no page reads a bearer header, so a
 * key means nothing there. The CSRF check does not apply for the same
 * reason: it protects a credential a browser sends by itself, and a browser
 * never sends this one.
 *
 * A key acts as its own person and nobody else. There is no acting for
 * another person and no impersonation through a key.
 */
export type ApiEnv = {
  Variables: {
    /** Whose key the request carries. */
    key: KeyHolder;
    /**
     * Whether the request may do what staff do: the key was made as a staff
     * key and its person holds staff rights now. Asked on every request, so
     * taking the rights away stops the key at once.
     */
    staff: boolean;
  };
};

export interface ApiDeps {
  db: Kysely<Database>;
  /** Whether a person holds staff rights now (person_admin; everyone in development). */
  isStaff: (personId: number) => Promise<boolean>;
  /** How often one key may ask; the default unless a test says otherwise. */
  limiter?: ReturnType<typeof keyRateLimiter>;
}

/** An error, in the one shape every failure under /api/ has. */
export const apiError = (c: Context, status: 400 | 401 | 403 | 404 | 429 | 500, error: string, message: string, extra: Record<string, unknown> = {}) =>
  c.json({ error, message, ...extra }, status);

const unauthorized = (c: Context, message: string) => {
  c.header("www-authenticate", 'Bearer realm="Beeline API"');
  return apiError(c, 401, "unauthorized", message);
};

/** The key a request carries, or null. Only the bearer form; a key in a query string would end up in logs. */
export function bearerKey(c: Context): string | null {
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(c.req.header("authorization") ?? "");
  return match === null ? null : match[1]!;
}

/**
 * Refuse a request that carries credentials to an address the old Beeline's
 * redirects would answer (src/app/old-beeline.ts): any path under /api/ that
 * is not this API's, and the old interface's pages. Without this the answer
 * would be a redirect to old.melittologist.org, and some HTTP clients resend
 * the Authorization header when a redirect stays within the same site, so one
 * mistyped path would hand the key to another server.
 */
export const refuseStrayCredentials: MiddlewareHandler = async (c, next) => {
  if (c.req.header("authorization") === undefined) return next();
  c.header("cache-control", "no-store");
  return unauthorized(c, "No API lives at this path. Beeline's API is under /api/v1/.");
};

export function createApi({ db, isStaff, limiter = keyRateLimiter() }: ApiDeps): Hono<ApiEnv> {
  const api = new Hono<ApiEnv>();

  api.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const reference = reportAppError(err, c);
    return apiError(c, 500, "failed", "Something went wrong on Beeline's side.", { reference });
  });

  api.use(async (c, next) => {
    // An answer may hold a person's records, and none is worth caching.
    c.header("cache-control", "no-store");
    const key = bearerKey(c);
    if (key === null) {
      return unauthorized(c, "Send your API key in an Authorization header: Authorization: Bearer <key>.");
    }
    const holder = await resolveKey(db, key);
    if (holder === null) {
      return unauthorized(c, "This API key does not work. It may have expired or been revoked.");
    }
    const wait = limiter.take(holder.ref);
    if (wait > 0) {
      c.header("retry-after", String(wait));
      return apiError(c, 429, "too many requests", `This key is asking too often. Wait ${wait} seconds.`);
    }
    c.set("key", holder);
    c.set("staff", holder.scope === "staff" && (await isStaff(holder.personId)));
    await next();
  });

  // Who the key belongs to and what it may do: the first thing a program
  // asks, to check that its key works.
  api.get("/me", (c) => {
    const key = c.get("key");
    return c.json({
      person: { name: key.displayName, inat_login: key.login },
      key: { reference: key.ref, scope: key.scope, expires_at: key.expiresAt.toISOString() },
      staff: c.get("staff"),
    });
  });

  // After the key check on purpose: someone without a key learns nothing
  // about which paths exist.
  api.all("*", (c) => apiError(c, 404, "not found", "No such endpoint."));

  return api;
}
