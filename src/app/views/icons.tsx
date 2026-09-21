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

/**
 * `small` is the size an icon takes beside a line of label text — a column
 * heading, a sort direction. Heroicons' outline set is drawn for 24px at a
 * 1.5 stroke; shrunk to 16px that stroke thins to a hairline, so the small
 * size carries a heavier one to stay legible.
 */
function Icon({ children, small = false }: { children: Child; small?: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={small ? "2.25" : "1.5"}
      width={small ? "16" : "24"}
      height={small ? "16" : "24"}
      class={small ? "icon icon-small" : "icon"}
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

export function FeedbackIcon() {
  return (
    <Icon>
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"
      />
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

export function SearchIcon() {
  return (
    <Icon>
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
      />
    </Icon>
  );
}

/** "There is a menu here": the one affordance every column heading's menu wears. */
export function ChevronDownIcon() {
  return (
    <Icon small>
      <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
    </Icon>
  );
}

/** The table is ordered by this column, lowest first. */
export function ArrowUpIcon() {
  return (
    <Icon small>
      <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
    </Icon>
  );
}

/** The table is ordered by this column, highest first. */
export function ArrowDownIcon() {
  return (
    <Icon small>
      <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 13.5 12 21m0 0-7.5-7.5M12 21V3" />
    </Icon>
  );
}

/** Every icon in the set, for the proofing page. */
export const ICON_SET = [
  { name: "MenuIcon", use: "Opens the menu left of the brand: reference pages and staff tools, and the nav on narrow screens", render: MenuIcon },
  { name: "PersonIcon", use: "Account menu, when the volunteer has no iNaturalist avatar", render: PersonIcon },
  { name: "SearchIcon", use: "The search button on a listing", render: SearchIcon },
  { name: "ChevronDownIcon", use: "A column heading that opens a menu — the same mark on every one", render: ChevronDownIcon },
  { name: "ArrowUpIcon", use: "The table is ordered by this column, lowest first", render: ArrowUpIcon },
  { name: "ArrowDownIcon", use: "The table is ordered by this column, highest first", render: ArrowDownIcon },
] as const;
