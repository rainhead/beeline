import type { Child } from "hono/jsx";
import type { Messages } from "../messages/index.js";
import type { Session } from "../session.js";
import { MenuIcon, PersonIcon } from "./icons.js";

export interface PageEnv {
  /** Stamp appended to stylesheet URLs so a CSS change is not cached past it. */
  styleVersion: string;
  /** Non-production instances announce themselves (beeline-2u8). */
  environment: "development" | "sandbox" | "production";
  /** URL of the built islands bundle, or null when it hasn't been built. */
  islandsSrc: string | null;
  session: Session;
  /** Whether this session may see the admin surface (/jobs, /design, beeline-6va). */
  admin: boolean;
  m: Messages;
}

/**
 * The stylesheets, in cascade order. Split by concern so a design change
 * lands in one obvious file; served statically rather than bundled so that
 * `pnpm app:dev` picks up a CSS edit without restarting the server.
 */
const STYLESHEETS = ["/tokens.css", "/static/elements.css", "/static/layout.css", "/static/components.css"];

/** Stylesheet URL with the cache-busting stamp attached. */
const versioned = (href: string, version: string) => `${href}${href.includes("?") ? "&" : "?"}v=${version}`;

/** The nav destinations, rendered twice: inline on wide screens, in the hamburger menu on narrow ones. */
function NavLinks({ m, admin }: { m: Messages; admin: boolean }) {
  return (
    <>
      <a href="/samples">{m.layout.nav.samples}</a>
      <a href="/specimens">{m.layout.nav.specimens}</a>
      <a href="/glossary">{m.layout.nav.glossary}</a>
      {admin && <a href="/design">{m.layout.nav.design}</a>}
      {admin && <a href="/jobs">{m.layout.nav.jobs}</a>}
    </>
  );
}

/**
 * The pages that exist before a session does — the sign-in door and the
 * pending-approval holding page. Same head and same environment banner as
 * the app proper (beeline-2u8 asks for the banner on the front door
 * specifically: a volunteer must not mistake a sandbox for the real thing
 * *before* signing in either), minus every piece of chrome that needs a
 * session.
 */
export function PublicPage(props: {
  environment: PageEnv["environment"];
  m: Messages;
  title: string;
  styleVersion?: string;
  children?: Child;
}) {
  const { m } = props;
  return (
    <html lang={m.locale}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{m.layout.pageTitle(props.title)}</title>
        {STYLESHEETS.map((href) => (
          <link rel="stylesheet" href={versioned(href, props.styleVersion ?? "0")} />
        ))}
      </head>
      <body>
        {props.environment !== "production" && (
          <div class="env-banner">{m.layout.envBanner(props.environment)}</div>
        )}
        <main>{props.children}</main>
      </body>
    </html>
  );
}

export function Layout(props: {
  env: PageEnv;
  title: string;
  /** Extra stylesheets for this page only — /design's proofing chrome. */
  stylesheets?: readonly string[];
  children?: Child;
}) {
  const { env, title } = props;
  const { m, session } = env;
  return (
    <html lang={m.locale}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* No search engine has any business here: every page is private. */}
        <meta name="robots" content="noindex" />
        <title>{m.layout.pageTitle(title)}</title>
        {[...STYLESHEETS, ...(props.stylesheets ?? [])].map((href) => (
          <link rel="stylesheet" href={versioned(href, env.styleVersion)} />
        ))}
        {env.islandsSrc && <script type="module" src={env.islandsSrc}></script>}
      </head>
      <body>
        {env.environment !== "production" && <div class="env-banner">{m.layout.envBanner(env.environment)}</div>}
        {/* The dropdowns are <details> so they work with no JavaScript at all;
            the islands bundle adds outside-click/Escape dismissal on top. */}
        <header>
          <details class="menu nav-menu">
            <summary aria-label={m.layout.menu} title={m.layout.menu}>
              <MenuIcon />
            </summary>
            <nav class="menu-panel">
              <NavLinks m={m} admin={env.admin} />
            </nav>
          </details>
          <a href="/" class="brand">
            {m.brand}
          </a>
          <nav class="nav-inline">
            <NavLinks m={m} admin={env.admin} />
          </nav>
          <details class="menu account-menu">
            <summary aria-label={m.layout.account(session.login)} title={m.layout.account(session.login)}>
              {session.iconUrl !== null ? <img class="avatar" src={session.iconUrl} alt="" /> : <PersonIcon />}
            </summary>
            <div class="menu-panel">
              <div class="menu-identity">{session.login}</div>
              {session.stub === true ? (
                // A dev-login session has no cookie behind it to end.
                <div class="menu-identity">{m.layout.devSession}</div>
              ) : (
                <form method="post" action="/auth/logout">
                  <button>{m.layout.signOut}</button>
                </form>
              )}
            </div>
          </details>
        </header>
        <main>{props.children}</main>
      </body>
    </html>
  );
}
