import type { Child } from "hono/jsx";

export interface Tab {
  href: string;
  label: Child;
  current: boolean;
}

/**
 * Pages that are views of one thing, as links in a row (beeline-fiay). Links
 * rather than a script-driven tab panel, because each is its own page with
 * its own address: it can be bookmarked and shared, and it works without
 * script. The current one is marked for assistive technology with
 * aria-current, which is also what the stylesheet draws.
 */
export function Tabs({ label, tabs }: { label: string; tabs: Tab[] }) {
  return (
    <nav class="tabs" aria-label={label}>
      {tabs.map((t) => (
        <a href={t.href} aria-current={t.current ? "page" : undefined}>
          {t.label}
        </a>
      ))}
    </nav>
  );
}
