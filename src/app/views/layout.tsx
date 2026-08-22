import type { Child } from "hono/jsx";
import type { Session } from "../session.js";

export interface PageEnv {
  /** Non-production instances announce themselves (beeline-2u8). */
  environment: "development" | "sandbox" | "production";
  /** URL of the built islands bundle, or null when it hasn't been built. */
  islandsSrc: string | null;
  session: Session;
}

export function Layout(props: { env: PageEnv; title: string; children?: Child }) {
  const { env, title } = props;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* No search engine has any business here: every page is private. */}
        <meta name="robots" content="noindex" />
        <title>{title} · Beeline</title>
        <link rel="stylesheet" href="/tokens.css" />
        <link rel="stylesheet" href="/static/base.css" />
        {env.islandsSrc && <script type="module" src={env.islandsSrc}></script>}
      </head>
      <body>
        {env.environment !== "production" && (
          <div class="env-banner">
            {env.environment} instance — data here may be blown away and rebuilt at any time
          </div>
        )}
        <header>
          <a href="/" class="brand">
            Beeline
          </a>
          <nav>
            <a href="/patterns">Patterns</a>
          </nav>
          <span style="margin-left: auto">{env.session.login}</span>
        </header>
        <main>{props.children}</main>
      </body>
    </html>
  );
}
