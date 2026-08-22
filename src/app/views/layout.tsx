import type { Child } from "hono/jsx";
import type { Messages } from "../messages/index.js";
import type { Session } from "../session.js";

export interface PageEnv {
  /** Non-production instances announce themselves (beeline-2u8). */
  environment: "development" | "sandbox" | "production";
  /** URL of the built islands bundle, or null when it hasn't been built. */
  islandsSrc: string | null;
  session: Session;
  m: Messages;
}

export function Layout(props: { env: PageEnv; title: string; children?: Child }) {
  const { env, title } = props;
  const { m } = env;
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
        <header>
          <a href="/" class="brand">
            {m.brand}
          </a>
          <nav>
            <a href="/patterns">{m.layout.nav.patterns}</a>
            <a href="/jobs">{m.layout.nav.jobs}</a>
          </nav>
          <form method="post" action="/auth/logout" style="margin-left: auto; display: flex; gap: 0.75rem; align-items: baseline">
            <span>{env.session.login}</span>
            <button class="outlined">{m.layout.signOut}</button>
          </form>
        </header>
        <main>{props.children}</main>
      </body>
    </html>
  );
}
