import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { exec } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * iNaturalist OAuth login for development QA (beeline-zcf.6). Runs the
 * authorization-code flow against a registered app (credentials in
 * data/secrets/inat-oauth.json), stores the non-expiring access token, and
 * mints a 24h JWT into data/secrets/inat-jwt — the file inat:sync reads.
 * With a stored access token, re-running skips the browser and just mints a
 * fresh JWT; --relogin forces the full flow.
 */

const SITE = "https://www.inaturalist.org";
// iNat OAuth apps register exactly ONE callback URL, shared with the web
// app's sign-in — so this CLI binds the app's port. Stop the dev server
// first; a held port fails loudly below.
const REDIRECT_URI = "http://localhost:3054/auth/inat/callback";
const CREDENTIALS_PATH = "data/secrets/inat-oauth.json";
const TOKEN_PATH = "data/secrets/inat-oauth-token";
const JWT_PATH = "data/secrets/inat-jwt";

interface Credentials { client_id: string; client_secret: string }

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** Wait for the OAuth redirect and hand back the authorization code. */
function awaitCallback(state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== new URL(REDIRECT_URI).pathname) {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const ok = !err && code && url.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(ok
        ? "<p>Signed in — you can close this tab and return to the terminal.</p>"
        : `<p>Login failed: ${err ?? "state mismatch"}.</p>`);
      server.close();
      if (ok) resolve(code);
      else reject(new Error(`OAuth callback: ${err ?? "state mismatch or missing code"}`));
    });
    server.on("error", reject); // port bound (dev server running?) — fail loudly
    server.listen(Number(new URL(REDIRECT_URI).port));
  });
}

async function fullLogin(creds: Credentials): Promise<string> {
  const state = randomBytes(16).toString("hex");
  const authorizeUrl = new URL(`${SITE}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", creds.client_id);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);

  console.log("Opening browser for iNaturalist sign-in…");
  exec(`open '${authorizeUrl.href}'`);
  const code = await awaitCallback(state);

  const response = await fetch(`${SITE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
  const token = (await response.json()) as { access_token: string };
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2));
  await chmod(TOKEN_PATH, 0o600);
  return token.access_token;
}

async function mintJwt(accessToken: string): Promise<string> {
  const response = await fetch(`${SITE}/users/api_token`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`JWT mint failed: ${response.status} — access token revoked? rerun with --relogin`);
  const { api_token: jwt } = (await response.json()) as { api_token: string };
  await writeFile(JWT_PATH, jwt);
  await chmod(JWT_PATH, 0o600);
  return jwt;
}

// CLI: pnpm inat:login [--relogin]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const relogin = process.argv.includes("--relogin");
  const creds = await readJson<Credentials>(CREDENTIALS_PATH);
  let accessToken: string | undefined;
  if (!relogin) {
    try {
      accessToken = (await readJson<{ access_token: string }>(TOKEN_PATH)).access_token;
    } catch { /* no stored token — full flow */ }
  }
  accessToken ??= await fullLogin(creds);
  const jwt = await mintJwt(accessToken);

  const me = await fetch("https://api.inaturalist.org/v1/users/me", {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const identity = me.ok
    ? (await me.json() as { results: Array<{ id: number; login: string }> }).results[0]
    : undefined;
  console.log(JSON.stringify({
    login: identity?.login ?? "(unknown)",
    user_id: identity?.id,
    jwt_written_to: JWT_PATH,
  }, null, 2));
}
