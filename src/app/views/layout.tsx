import type { Child } from "hono/jsx";
import type { Messages } from "../messages/index.js";
import type { Session } from "../session.js";

export interface PageEnv {
  /** Non-production instances announce themselves (beeline-2u8). */
  environment: "development" | "sandbox" | "production";
  /** URL of the built islands bundle, or null when it hasn't been built. */
  islandsSrc: string | null;
  session: Session;
  /** Whether this session may see the admin surface (/jobs, beeline-6va). */
  admin: boolean;
  m: Messages;
}

/** The nav destinations, rendered twice: inline on wide screens, in the hamburger menu on narrow ones. */
function NavLinks({ m, admin }: { m: Messages; admin: boolean }) {
  return (
    <>
      <a href="/patterns">{m.layout.nav.patterns}</a>
      {admin && <a href="/jobs">{m.layout.nav.jobs}</a>}
    </>
  );
}

function HamburgerIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24" aria-hidden="true">
      <path stroke-linecap="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24" aria-hidden="true">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
      />
    </svg>
  );
}

export function Layout(props: { env: PageEnv; title: string; children?: Child }) {
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
        <link rel="stylesheet" href="/tokens.css" />
        <link rel="stylesheet" href="/static/base.css" />
        {env.islandsSrc && <script type="module" src={env.islandsSrc}></script>}
      </head>
      <body>
        {env.environment !== "production" && <div class="env-banner">{m.layout.envBanner(env.environment)}</div>}
        {/* The dropdowns are <details> so they work with no JavaScript at all;
            the islands bundle adds outside-click/Escape dismissal on top. */}
        <header>
          <details class="menu nav-menu">
            <summary aria-label={m.layout.menu} title={m.layout.menu}>
              <HamburgerIcon />
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
              <form method="post" action="/auth/logout">
                <button>{m.layout.signOut}</button>
              </form>
            </div>
          </details>
        </header>
        <main>{props.children}</main>
      </body>
    </html>
  );
}
