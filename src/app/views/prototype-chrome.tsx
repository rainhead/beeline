/**
 * PROTOTYPE (beeline-d0u4) — throwaway, never merged to main.
 *
 * Question: what would Beeline's main pages look like brought closer to
 * Material 3 than the colour roles it already takes from a seed? Three
 * variants on the real pages, switched by `?variant=` and the bar at the foot
 * of the window; `current` is today's design for comparison.
 *
 *   A  Top app bar and tabs — outlined cards, outlined fields, system font.
 *   B  Navigation rail — panes on a tonal background, elevated cards, filled
 *      fields, Roboto Flex; a navigation bar at the foot on a phone.
 *   C  Navigation drawer — every destination always visible, filled cards,
 *      lists rather than definition grids, dense tables.
 *
 * The chrome here only rearranges what Layout already renders: the same
 * links, the same menus, the same messages.
 */
import type { Child } from "hono/jsx";
import type { Messages } from "../messages/index.js";
import { SYMBOLS } from "./prototype-symbols.js";

export const VARIANTS = ["current", "A", "B", "C"] as const;
export type Variant = (typeof VARIANTS)[number];
export const VARIANT_NAMES: Record<Variant, string> = {
  current: "Today's design",
  A: "Top app bar and tabs",
  B: "Navigation rail",
  C: "Navigation drawer",
};

export function prototypeVariant(raw: string | undefined): Variant | null {
  return raw !== undefined && (VARIANTS as readonly string[]).includes(raw) ? (raw as Variant) : null;
}

/** A Material Symbol, aria-hidden like every icon here. */
export function Sym({ name, fill = false }: { name: string; fill?: boolean }) {
  const d = SYMBOLS[fill && SYMBOLS[`${name}_fill1`] ? `${name}_fill1` : name] ?? "";
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="24" height="24" class="sym" aria-hidden="true" fill="currentColor">
      <path d={d} />
    </svg>
  );
}

export interface Destination {
  href: string;
  label: string;
  /** The short label a rail or navigation bar has room for. */
  short: string;
  icon: string;
  shown: boolean;
  group: "records" | "reference" | "staff";
}

export function destinations(m: Messages, admin: boolean): Destination[] {
  const n = m.layout.nav;
  return [
    { href: "/", label: "Home", short: "Home", icon: "home", shown: true, group: "records" },
    { href: "/samples", label: n.samples, short: n.samples, icon: "science", shown: true, group: "records" },
    { href: "/specimens", label: n.specimens, short: n.specimens, icon: "pest_control", shown: true, group: "records" },
    { href: "/determinations", label: n.identify, short: "Identify", icon: "biotech", shown: true, group: "records" },
    { href: "/how-it-works", label: n.howItWorks, short: "Guide", icon: "help", shown: true, group: "reference" },
    { href: "/glossary", label: n.glossary, short: n.glossary, icon: "menu_book", shown: true, group: "reference" },
    { href: "/taxonomy", label: n.taxonomy, short: n.taxonomy, icon: "account_tree", shown: true, group: "reference" },
    { href: "/programs", label: n.programs, short: n.programs, icon: "groups", shown: true, group: "reference" },
    { href: "/people", label: n.people, short: n.people, icon: "group", shown: admin, group: "staff" },
    { href: "/unclaimed", label: n.unclaimed, short: n.unclaimed, icon: "person_search", shown: admin, group: "staff" },
    { href: "/jobs", label: n.jobs, short: n.jobs, icon: "schedule", shown: admin, group: "staff" },
    { href: "/print-runs", label: n.printRuns, short: n.printRuns, icon: "print", shown: admin, group: "staff" },
    { href: "/exports", label: n.exports, short: n.exports, icon: "download", shown: admin, group: "staff" },
    { href: "/design", label: n.design, short: n.design, icon: "palette", shown: admin, group: "staff" },
  ].filter((d) => d.shown) as Destination[];
}

export const isActive = (href: string, path: string) =>
  href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);

/** The link to this same page under another variant. */
function withVariant(href: string, v: Variant): string {
  const url = new URL(href, "http://x");
  url.searchParams.set("variant", v);
  return `${url.pathname}${url.search}`;
}

/**
 * The floating bar: previous, which variant this is, next. Plain links, so
 * it works with no script; the islands add ← and → and keep the variant on
 * every link and GET form of the page.
 */
export function PrototypeSwitcher({ variant, href }: { variant: Variant; href: string }) {
  const i = VARIANTS.indexOf(variant);
  const prev = VARIANTS[(i + VARIANTS.length - 1) % VARIANTS.length]!;
  const next = VARIANTS[(i + 1) % VARIANTS.length]!;
  return (
    <div class="proto-switcher" role="navigation" aria-label="Prototype variants">
      <a href={withVariant(href, prev)} data-proto="prev" aria-label={`Previous: ${prev}`}>
        ←
      </a>
      <span>
        <strong>{variant}</strong> · {VARIANT_NAMES[variant]}
      </span>
      <a href={withVariant(href, next)} data-proto="next" aria-label={`Next: ${next}`}>
        →
      </a>
    </div>
  );
}

/** A: the brand row, then primary tabs for the records. */
export function TopBarChrome(props: {
  m: Messages;
  admin: boolean;
  path: string;
  menu: Child;
  feedback: Child;
  account: Child;
}) {
  const tabs = destinations(props.m, props.admin).filter((d) => d.group === "records" || d.href === "/how-it-works");
  return (
    <>
      <header class="md-top-app-bar">
        {props.menu}
        <a href="/" class="brand">
          {props.m.brand}
        </a>
        <span class="md-spacer" />
        {props.feedback}
        {props.account}
      </header>
      <nav class="md-tabs" aria-label={props.m.layout.records}>
        {tabs.map((d) => (
          <a href={d.href} aria-current={isActive(d.href, props.path) ? "page" : undefined}>
            {/* On a phone, the short label, so every tab fits without scrolling. */}
            <span class="tab-icon">
              <Sym name={d.icon} fill={isActive(d.href, props.path)} />
            </span>
            <span class="tab-long">{d.label}</span>
            <span class="tab-short">{d.href === "/how-it-works" ? "How it works" : d.short}</span>
          </a>
        ))}
      </nav>
    </>
  );
}

/** B: a rail of the records at the left (a bar at the foot on a phone). */
export function Rail(props: { m: Messages; admin: boolean; path: string; menu: Child }) {
  const items = destinations(props.m, props.admin).filter((d) => ["/", "/samples", "/specimens", "/how-it-works"].includes(d.href));
  return (
    <nav class="md-rail" aria-label={props.m.layout.records}>
      <div class="md-rail-top">
        {props.menu}
        <a class="md-fab" href="/determinations" aria-label={props.m.layout.nav.identify} title={props.m.layout.nav.identify}>
          <Sym name="biotech" />
        </a>
      </div>
      <div class="md-rail-items">
        {items.map((d) => {
          const active = isActive(d.href, props.path);
          return (
            <a href={d.href} aria-current={active ? "page" : undefined}>
              <span class="md-indicator">
                <Sym name={d.icon} fill={active} />
              </span>
              <span class="md-rail-label">{d.short}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}

/** C: every destination, grouped, with headlines. Used both standing and in the narrow-screen menu. */
export function DrawerList(props: { m: Messages; admin: boolean; path: string }) {
  const all = destinations(props.m, props.admin);
  const groups: Array<{ key: Destination["group"]; label: string | null }> = [
    { key: "records", label: null },
    { key: "reference", label: "Reference" },
    { key: "staff", label: "Staff" },
  ];
  return (
    <>
      {groups.map((g) => {
        const items = all.filter((d) => d.group === g.key);
        if (items.length === 0) return null;
        return (
          <div class="md-drawer-section">
            {g.label !== null && <div class="md-drawer-headline">{g.label}</div>}
            {items.map((d) => {
              const active = isActive(d.href, props.path);
              return (
                <a href={d.href} aria-current={active ? "page" : undefined}>
                  <Sym name={d.icon} fill={active} />
                  <span>{d.label}</span>
                </a>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
