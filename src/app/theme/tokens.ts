import { argbFromHex, hexFromArgb, themeFromSourceColor, type CustomColor } from "@material/material-color-utilities";

/**
 * Seed for the Material 3 color scheme — everything else is derived.
 * Honey gold; change it and the whole palette follows.
 *
 * This file is the only place in the app that names a hex value. The
 * hand-written stylesheets consume the roles it generates and never name a
 * color; see /design/color.
 */
export const SEED_COLOR = "#b26a00";

/**
 * MD3 generates `error` but has no opinion about warning or success, and
 * Beeline needs both: QC separates findings that block label printing from
 * heads-up findings, and job runs succeed or fail. Declared as custom colors
 * with `blend: true` so they are *harmonized* toward the seed rather than
 * pasted in — an amber and a green that belong to this palette, in light and
 * dark, derived like everything else.
 */
const CUSTOM_COLORS: ReadonlyArray<Omit<CustomColor, "value"> & { hex: string }> = [
  { name: "warning", hex: "#f79234", blend: true },
  { name: "success", hex: "#2e7d32", blend: true },
];

const kebab = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

const cssVar = (name: string, argb: number) => `  --md-sys-color-${name}: ${hexFromArgb(argb)};`;

function schemeVars(scheme: Record<string, number>): string {
  return Object.entries(scheme)
    .map(([name, argb]) => cssVar(kebab(name), argb))
    .join("\n");
}

/** A custom color group, flattened into the same four-role shape MD3 uses. */
function customVars(groups: ReadonlyArray<{ name: string; group: { color: number; onColor: number; colorContainer: number; onColorContainer: number } }>): string {
  return groups
    .flatMap(({ name, group }) => [
      cssVar(name, group.color),
      cssVar(`on-${name}`, group.onColor),
      cssVar(`${name}-container`, group.colorContainer),
      cssVar(`on-${name}-container`, group.onColorContainer),
    ])
    .join("\n");
}

/** A seed is only usable if it is a six-digit hex; anything else falls back. */
export function normalizeSeed(seed: string | undefined | null): string {
  return typeof seed === "string" && /^#[0-9a-fA-F]{6}$/.test(seed) ? seed.toLowerCase() : SEED_COLOR;
}

/**
 * The generated stylesheet: MD3 color roles as custom properties, light and
 * dark, plus the harmonized warning/success groups. Served as /tokens.css;
 * the default seed is computed once at startup, and `?seed=` regenerates on
 * demand so per-atlas colorways can be proofed at /design/identity before
 * any atlas's real color is known.
 */
export function tokensCss(seed: string = SEED_COLOR): string {
  const theme = themeFromSourceColor(
    argbFromHex(seed),
    CUSTOM_COLORS.map(({ name, hex, blend }) => ({ name, blend, value: argbFromHex(hex) })),
  );
  const named = (mode: "light" | "dark") =>
    theme.customColors.map((c) => ({ name: c.color.name, group: c[mode] }));
  return `/* Generated Material 3 color scheme, seed ${seed}. Do not hand-edit; see src/app/theme/tokens.ts */
:root {
  color-scheme: light dark;
${schemeVars(theme.schemes.light.toJSON())}
${customVars(named("light"))}
}
@media (prefers-color-scheme: dark) {
  :root {
${schemeVars(theme.schemes.dark.toJSON())}
${customVars(named("dark"))}
  }
}
`;
}
