import type { Child } from "hono/jsx";

/**
 * The icon set. Two vocabularies are allowed and they never mix: Heroicons
 * outline for UI chrome (what you see here), and a bespoke set for domain
 * meaning — sample, trap, label, determination — which does not exist yet
 * (beeline-2c3.14). See /design/icons.
 *
 * Icons sit beside copy, never inside it, and never carry meaning on their
 * own: every one is aria-hidden, and its control supplies the accessible
 * name.
 */

function Icon({ children }: { children: Child }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      width="24"
      height="24"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function MenuIcon() {
  return (
    <Icon>
      <path stroke-linecap="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
    </Icon>
  );
}

export function PersonIcon() {
  return (
    <Icon>
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
      />
    </Icon>
  );
}

/** Every icon in the set, for the proofing page. */
export const ICON_SET = [
  { name: "MenuIcon", use: "Opens the nav drawer on narrow screens", render: MenuIcon },
  { name: "PersonIcon", use: "Account menu, when the volunteer has no iNaturalist avatar", render: PersonIcon },
] as const;
