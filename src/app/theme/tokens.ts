import { argbFromHex, hexFromArgb, themeFromSourceColor } from "@material/material-color-utilities";

/**
 * Seed for the Material 3 color scheme — everything else is derived.
 * Honey gold; change it and the whole palette follows.
 */
export const SEED_COLOR = "#b26a00";

const kebab = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

function schemeVars(scheme: Record<string, number>): string {
  return Object.entries(scheme)
    .map(([name, argb]) => `  --md-sys-color-${kebab(name)}: ${hexFromArgb(argb)};`)
    .join("\n");
}

/**
 * The generated stylesheet: MD3 color roles as custom properties, light and
 * dark. Served as /tokens.css; computed once at startup. The hand-rolled
 * base stylesheet (static/base.css) consumes these — it never names a color.
 */
export function tokensCss(seed: string = SEED_COLOR): string {
  const theme = themeFromSourceColor(argbFromHex(seed));
  const light = theme.schemes.light.toJSON();
  const dark = theme.schemes.dark.toJSON();
  return `/* Generated Material 3 color scheme, seed ${seed}. Do not hand-edit; see src/app/theme/tokens.ts */
:root {
  color-scheme: light dark;
${schemeVars(light)}
}
@media (prefers-color-scheme: dark) {
  :root {
${schemeVars(dark)}
  }
}
`;
}
