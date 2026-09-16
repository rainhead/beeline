import type { Child } from "hono/jsx";

/**
 * Where a page sits in a hierarchy, as the links above it.
 *
 * A trail is the ancestors only: the page's own title already says where you
 * are, and repeating it as a dead last link is noise. A real ordered list in a
 * labelled nav, so a screen reader announces it as the path it is; the
 * separators are drawn by the stylesheet and never read aloud.
 */
export function Breadcrumbs({
  label,
  trail,
}: {
  /** What the trail is — "Filed under" — for the nav's accessible name. */
  label: string;
  trail: ReadonlyArray<{ href: string; label: Child }>;
}) {
  if (trail.length === 0) return null;
  return (
    <nav class="breadcrumbs" aria-label={label}>
      <ol>
        {trail.map((step) => (
          <li>
            <a href={step.href}>{step.label}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
