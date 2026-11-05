import { randomBytes } from "node:crypto";
import * as Sentry from "@sentry/node";
import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import { html } from "hono/html";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { parseOrcid } from "../orcid.js";
import { cookieJar, SESSION_COOKIE } from "./cookies.js";
import { createSession, type AppEnv } from "./session.js";
import { PublicPage } from "./views/layout.js";
import { styleVersion } from "./assets.js";
import type { PageEnv } from "./views/layout.js";

const SITE = "https://www.inaturalist.org";
const API = "https://api.inaturalist.org/v1";
const STATE_COOKIE = "beeline_oauth_state";
/**
 * Where to land once signed in. A separate cookie rather than a query
 * parameter on the callback, because everything the callback receives came
 * back through iNaturalist and is therefore attacker-suppliable: the cookie
 * was set by us, on this site, in the same request that minted the state.
 */
const NEXT_COOKIE = "beeline_oauth_next";

/**
 * The requested URL, if it is somewhere on this site worth returning to.
 * Same-site paths only — an absolute URL, a scheme-relative `//evil.example`,
 * or a backslash Chrome would read as one, would turn sign-in into an open
 * redirect. `/auth/…` is refused too: landing back on the way in is a loop,
 * not a destination.
 */
export function returnTo(raw: string | undefined | null): string | null {
  if (!raw || raw.length > 2000) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (raw === "/" || raw.startsWith("/auth/")) return null;
  return raw;
}

/** The sign-in link for a request that was refused: `/auth/inat`, plus where to come back to. */
export function signInHref(path: string | null): string {
  const next = returnTo(path);
  return next === null ? "/auth/inat" : `/auth/inat?next=${encodeURIComponent(next)}`;
}

export interface InatIdentity {
  inatUserId: number;
  login: string;
  /** Profile picture URL, when the account has one. */
  iconUrl: string | null;
  /**
   * The ORCID iD the account has connected, bare, or null for none
   * (beeline-yaaj). Absent where a client does not say, which is not the
   * same as saying there is none.
   */
  orcid?: string | null;
}

/** The iNaturalist side of sign-in — injectable so tests never hit the network. */
export interface InatClient {
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  /** Who the token belongs to (mints a short-lived JWT, then /users/me). */
  identity(accessToken: string): Promise<InatIdentity>;
}

export interface InatCredentials {
  client_id: string;
  client_secret: string;
}

/**
 * Client credentials: INAT_CLIENT_ID/INAT_CLIENT_SECRET, falling back to the
 * dev registration the pipeline already uses (data/secrets/inat-oauth.json).
 */
export async function loadInatCredentials(env: NodeJS.ProcessEnv = process.env): Promise<InatCredentials> {
  if (env.INAT_CLIENT_ID && env.INAT_CLIENT_SECRET) {
    return { client_id: env.INAT_CLIENT_ID, client_secret: env.INAT_CLIENT_SECRET };
  }
  return JSON.parse(await readFile("data/secrets/inat-oauth.json", "utf8")) as InatCredentials;
}

export function inatClient(creds: InatCredentials): InatClient {
  return {
    authorizeUrl(state, redirectUri) {
      const url = new URL(`${SITE}/oauth/authorize`);
      url.searchParams.set("client_id", creds.client_id);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      return url.href;
    },
    async exchangeCode(code, redirectUri) {
      const response = await fetch(`${SITE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...creds, code, redirect_uri: redirectUri, grant_type: "authorization_code" }),
      });
      // One line, whatever the body holds: the message is logged at sign-in.
      if (!response.ok) {
        const body = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 200);
        throw new Error(`code exchange failed: ${response.status} ${body}`);
      }
      return ((await response.json()) as { access_token: string }).access_token;
    },
    async identity(accessToken) {
      const jwtRes = await fetch(`${SITE}/users/api_token`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!jwtRes.ok) throw new Error(`JWT mint failed: ${jwtRes.status}`);
      const { api_token: jwt } = (await jwtRes.json()) as { api_token: string };
      const meRes = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${jwt}` } });
      if (!meRes.ok) throw new Error(`identity fetch failed: ${meRes.status}`);
      const me = (await meRes.json()) as {
        results: Array<{ id: number; login: string; icon_url?: string | null; orcid?: string | null }>;
      };
      const user = me.results[0];
      if (!user) throw new Error("identity fetch returned no user");
      return {
        inatUserId: user.id,
        login: user.login,
        iconUrl: user.icon_url ?? null,
        // iNaturalist reports the iD as the URL its profile links to. One
        // that does not read as an iD says nothing either way, so it leaves
        // what is stored alone rather than erasing it as "none".
        orcid: user.orcid ? (parseOrcid(user.orcid) ?? undefined) : null,
      };
    },
  };
}

export interface AuthDeps {
  db: Kysely<Database>;
  inat: InatClient;
  origin: string;
  /** Non-production instances say so, on the pre-session pages too (beeline-2u8). */
  environment: PageEnv["environment"];
  /**
   * Keep what iNaturalist just said about the account's ORCID iD
   * (beeline-yaaj). Sign-in is when Beeline asks iNaturalist who somebody
   * is, so it is when an iD they connected arrives — no schedule needed.
   */
  recordOrcid?: (inatUserId: number, orcid: string | null) => Promise<void>;
  /** Where each callback's outcome goes; the metric and the console unless a test listens. */
  reportSignIn?: (outcome: SignInOutcome, line: string) => void;
}

/**
 * How one return from iNaturalist to the callback ended (beeline-87rn). Until
 * these were logged, the only trace of a person turned away at sign-in was
 * their sign-in record, and a failed callback left none at all: on
 * the first two days after cutover 18 of 57 callbacks failed and 8 turned
 * somebody away, and finding out who took decrypting a copy of what was then
 * an encrypted private store.
 *
 * - `signed-in`: a session was made.
 * - `turned-away`: iNaturalist says who they are, but no person holds that
 *   account, so they got the holding page.
 * - `declined`: iNaturalist sent back an `error` instead of a code, as it does
 *   when somebody presses Cancel on its authorisation page.
 * - `no-state-cookie`: the attempt's cookie was gone — it lasts ten minutes,
 *   and a callback opened in another browser, or reached again with Back
 *   after it had been used, has none.
 * - `state-mismatch`: a cookie, but from a different attempt, as when two
 *   sign-ins were started in two tabs.
 * - `no-code`: neither a code nor an error.
 * - `exchange-failed`: iNaturalist would not trade the code for a token, or
 *   would not say whose it was.
 */
export type SignInOutcome =
  | "signed-in"
  | "turned-away"
  | "declined"
  | "no-state-cookie"
  | "state-mismatch"
  | "no-code"
  | "exchange-failed";

/**
 * Counted as the metric `sign_in` by outcome, and logged as one line. The
 * line names the iNaturalist login where the callback learnt it: a login is a
 * public handle, which the slow-request line already carries, and for someone
 * turned away it is what staff need to connect them. Never quoted, since
 * `redact` blanks anything in quotes.
 */
export function reportSignIn(outcome: SignInOutcome, line: string): void {
  try {
    Sentry.metrics.count("sign_in", 1, { attributes: { outcome } });
  } catch (err) {
    console.error(`sign_in not counted: ${(err as Error).stack ?? String(err)}`);
  }
  if (outcome === "signed-in" || outcome === "declined") console.info(line);
  else console.warn(line);
}

/**
 * The `error` iNaturalist put on the callback, if it reads as an OAuth error
 * code. Anyone can craft the callback's query, so anything else is reported
 * as unrecognised rather than written into the log.
 */
function oauthError(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  return /^[a-z_]{1,40}$/.test(raw) ? raw : "an unrecognised error";
}

/**
 * The sign-in routes, registered on the public surface (they are how a
 * session comes to exist). The approval gate is an inat_account row: known
 * people get a session; anyone else gets a sign-in record, which is how
 * staff find who was turned away, and a holding page.
 */
export function registerAuthRoutes(app: Hono<AppEnv>, deps: AuthDeps): void {
  const redirectUri = `${deps.origin}/auth/inat/callback`;
  const cookies = cookieJar(deps.origin);
  const report = deps.reportSignIn ?? reportSignIn;

  app.get("/auth/inat", (c) => {
    const state = randomBytes(16).toString("hex");
    cookies.set(c, STATE_COOKIE, state, { maxAge: 600 });
    // Revalidated on the way in as well as on the way out: this one arrives
    // in a query parameter anyone can craft a link to.
    const next = returnTo(c.req.query("next"));
    if (next === null) cookies.delete(c, NEXT_COOKIE);
    else cookies.set(c, NEXT_COOKIE, next, { maxAge: 600 });
    return c.redirect(deps.inat.authorizeUrl(state, redirectUri));
  });

  app.get("/auth/inat/callback", async (c) => {
    const expected = cookies.get(c, STATE_COOKIE);
    // Both cookies belong to this one attempt, however it ends: a failure
    // that left them behind would send the next attempt somewhere stale.
    const next = returnTo(cookies.get(c, NEXT_COOKIE));
    cookies.delete(c, STATE_COOKIE);
    cookies.delete(c, NEXT_COOKIE);
    const m = c.get("m");
    const code = c.req.query("code");
    // The error first: it is the person's own answer, whatever else is wrong.
    const declined = oauthError(c.req.query("error"));
    if (declined !== null) {
      report("declined", `[sign-in] declined: iNaturalist returned ${declined}`);
      return c.text(m.signIn.failed, 400);
    }
    if (!expected) {
      report("no-state-cookie", "[sign-in] failed: the attempt's cookie was missing (expired, another browser, or a callback reached twice)");
      return c.text(m.signIn.failed, 400);
    }
    if (c.req.query("state") !== expected) {
      report("state-mismatch", "[sign-in] failed: the state did not match this browser's attempt");
      return c.text(m.signIn.failed, 400);
    }
    if (!code) {
      report("no-code", "[sign-in] failed: iNaturalist returned neither a code nor an error");
      return c.text(m.signIn.failed, 400);
    }
    // A failed exchange is a user-visible sign-in failure, not a 500 — and
    // anyone can reach this route, so the error must not feed Hono's default
    // handler on a loop of garbage codes (beeline-j5z).
    let accessToken: string;
    let identity: InatIdentity;
    try {
      accessToken = await deps.inat.exchangeCode(code, redirectUri);
      identity = await deps.inat.identity(accessToken);
    } catch (err) {
      // A string, never the error object: the log integration would send it
      // as JSON. And no "token" before a word, which redact() would blank.
      report("exchange-failed", `[sign-in] failed: iNaturalist would not exchange the code, or say whose account it was: ${(err as Error).message}`);
      return c.text(m.signIn.failed, 400);
    }

    await deps.db
      .insertInto("inat_sign_in")
      .values({
        inat_user_id: identity.inatUserId,
        login: identity.login,
        icon_url: identity.iconUrl,
      })
      .onConflict((oc) =>
        oc.column("inat_user_id").doUpdateSet({
          login: identity.login,
          icon_url: identity.iconUrl,
          // Bare current_timestamp binds as a column ref in DuckDB's DO UPDATE SET; now() doesn't.
          last_login_at: sql`now()`,
        }),
      )
      .execute();

    // Never fails the sign-in: an iD recorded at the next sign-in instead of
    // this one costs nothing, and a person turned away for it would.
    if (identity.orcid !== undefined && deps.recordOrcid !== undefined) {
      try {
        await deps.recordOrcid(identity.inatUserId, identity.orcid);
      } catch (err) {
        console.warn(`sign-in: could not record the ORCID iD: ${(err as Error).message}`);
      }
    }

    const account = await deps.db
      .selectFrom("inat_account")
      .where("inat_user_id", "=", BigInt(identity.inatUserId))
      .select("person_id")
      .executeTakeFirst();

    if (account === undefined) {
      report(
        "turned-away",
        `[sign-in] turned away: no person holds iNaturalist account ${identity.login} (${identity.inatUserId})`,
      );
      return c.html(
        html`<!doctype html>${(
          <PublicPage
            environment={deps.environment}
            m={m}
            title={m.pendingApproval.title}
            styleVersion={await styleVersion()}
          >
            <h1>{m.pendingApproval.heading}</h1>
            <p>{m.pendingApproval.body(identity.login)}</p>
          </PublicPage>
        )}`,
        403,
      );
    }

    const sessionId = await createSession(deps.db, identity.inatUserId);
    report("signed-in", `[sign-in] signed in: ${identity.login}`);
    cookies.set(c, SESSION_COOKIE, sessionId);
    // Back to whatever was asked for before the gate got in the way; home
    // when sign-in was the errand itself (beeline-2c3.31).
    return c.redirect(next ?? "/");
  });
}
