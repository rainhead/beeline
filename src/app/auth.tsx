import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { sql, type Kysely } from "kysely";
import type { Database } from "../model.js";
import { SESSION_COOKIE, createSession, type AppEnv } from "./session.js";

const SITE = "https://www.inaturalist.org";
const API = "https://api.inaturalist.org/v1";
const STATE_COOKIE = "beeline_oauth_state";

export interface InatIdentity {
  inatUserId: number;
  login: string;
  /** Profile picture URL, when the account has one. */
  iconUrl: string | null;
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
      if (!response.ok) throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
      return ((await response.json()) as { access_token: string }).access_token;
    },
    async identity(accessToken) {
      const jwtRes = await fetch(`${SITE}/users/api_token`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!jwtRes.ok) throw new Error(`JWT mint failed: ${jwtRes.status}`);
      const { api_token: jwt } = (await jwtRes.json()) as { api_token: string };
      const meRes = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${jwt}` } });
      if (!meRes.ok) throw new Error(`identity fetch failed: ${meRes.status}`);
      const me = (await meRes.json()) as { results: Array<{ id: number; login: string; icon_url?: string | null }> };
      const user = me.results[0];
      if (!user) throw new Error("identity fetch returned no user");
      return { inatUserId: user.id, login: user.login, iconUrl: user.icon_url ?? null };
    },
  };
}

export interface AuthDeps {
  db: Kysely<Database>;
  inat: InatClient;
  origin: string;
}

/**
 * The sign-in routes, registered on the public surface (they are how a
 * session comes to exist). The approval gate is an inat_account row: known
 * people get a session; anyone else gets their token stored (ADR 0003:
 * stored at first login, not used until approved) and a holding page.
 */
export function registerAuthRoutes(app: Hono<AppEnv>, deps: AuthDeps): void {
  const redirectUri = `${deps.origin}/auth/inat/callback`;
  const secure = deps.origin.startsWith("https:");

  app.get("/auth/inat", (c) => {
    const state = randomBytes(16).toString("hex");
    setCookie(c, STATE_COOKIE, state, { httpOnly: true, sameSite: "Lax", secure, path: "/", maxAge: 600 });
    return c.redirect(deps.inat.authorizeUrl(state, redirectUri));
  });

  app.get("/auth/inat/callback", async (c) => {
    const expected = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    const m = c.get("m");
    const code = c.req.query("code");
    if (!code || !expected || c.req.query("state") !== expected) {
      return c.text(m.signIn.failed, 400);
    }
    const accessToken = await deps.inat.exchangeCode(code, redirectUri);
    const identity = await deps.inat.identity(accessToken);

    await deps.db
      .insertInto("private.inat_oauth_token")
      .values({
        inat_user_id: identity.inatUserId,
        login: identity.login,
        icon_url: identity.iconUrl,
        access_token: accessToken,
      })
      .onConflict((oc) =>
        oc.column("inat_user_id").doUpdateSet({
          login: identity.login,
          icon_url: identity.iconUrl,
          access_token: accessToken,
          // Bare current_timestamp binds as a column ref in DuckDB's DO UPDATE SET; now() doesn't.
          last_login_at: sql`now()`,
        }),
      )
      .execute();

    const account = await deps.db
      .selectFrom("inat_account")
      .where("inat_user_id", "=", BigInt(identity.inatUserId))
      .select("person_id")
      .executeTakeFirst();

    if (account === undefined) {
      return c.html(
        html`<!doctype html>${(
          <html lang={m.locale}>
            <head>
              <meta charset="utf-8" />
              <title>{m.layout.pageTitle(m.pendingApproval.title)}</title>
              <link rel="stylesheet" href="/tokens.css" />
              <link rel="stylesheet" href="/static/base.css" />
            </head>
            <body>
              <main>
                <h1>{m.pendingApproval.heading}</h1>
                <p>{m.pendingApproval.body(identity.login)}</p>
              </main>
            </body>
          </html>
        )}`,
        403,
      );
    }

    const sessionId = await createSession(deps.db, account.person_id);
    setCookie(c, SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: "Lax", secure, path: "/" });
    return c.redirect("/");
  });
}
