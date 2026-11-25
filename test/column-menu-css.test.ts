import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * A column menu's panel is `position: fixed`, which gives it no place of its
 * own: it opened at its heading's left edge and ran off the right of the window
 * for the last columns (beeline-re6e). It is tied to its heading with CSS anchor
 * positioning. A browser test would cover the geometry; this holds the pieces
 * that make it work from being edited away.
 */
describe("column menu panel", () => {
  it("is anchored to its own heading, with fallbacks that keep it in the window", async () => {
    const css = await readFile("src/app/static/components.css", "utf8");
    // Each menu names its own anchor, so a panel never anchors to another column's heading.
    expect(css).toMatch(/th details\.col-menu \{ anchor-scope: --col-menu; \}/);
    expect(css).toMatch(/th details\.col-menu > summary \{ anchor-name: --col-menu; \}/);
    const panel = css.match(/@supports \(anchor-name: --col-menu\) and \(anchor-scope: --col-menu\) \{[\s\S]*?position-anchor: --col-menu;[\s\S]*?\n  \}/);
    expect(panel, "the anchored panel rule").not.toBeNull();
    expect(panel![0]).toContain("top: anchor(bottom)");
    expect(panel![0]).toContain("left: anchor(left)");
    expect(panel![0]).toContain("position-try-fallbacks: --col-menu-right");
    // The panel stays fixed so the table wrapper's sideways scroll cannot clip it.
    expect(css).toMatch(/th details\.col-menu > \.menu-panel \{\s*position: fixed;/);
  });
});

/**
 * A flag chip's box is fixed in the same way and ran off the bottom of the
 * window for a chip near it, where scrolling could not reach it (beeline-zlqm).
 * It is tied to its chip, with a fallback above it, and capped to the window;
 * islands/menus.ts places it by hand where anchors are missing.
 */
describe("flag chip panel", () => {
  it("is anchored to its own chip, can open above it, and is never taller than the window", async () => {
    const css = await readFile("src/app/static/components.css", "utf8");
    expect(css).toMatch(/details\.flag-menu \{ anchor-scope: --flag-chip; \}/);
    expect(css).toMatch(/details\.flag-menu > summary \{ anchor-name: --flag-chip; \}/);
    const panel = css.match(/@supports \(anchor-name: --flag-chip\) and \(anchor-scope: --flag-chip\) \{[\s\S]*?position-anchor: --flag-chip;[\s\S]*?\n  \}/);
    expect(panel, "the anchored panel rule").not.toBeNull();
    expect(panel![0]).toContain("top: anchor(bottom)");
    expect(panel![0]).toContain("--flag-chip-above");
    const base = css.match(/details\.flag-menu > \.flag-panel \{[^}]*\}/);
    expect(base![0]).toContain("position: fixed");
    expect(base![0]).toContain("max-height:");
    expect(base![0]).toContain("overflow-y: auto");
    const script = await readFile("src/app/islands/menus.ts", "utf8");
    expect(script).toContain('CSS.supports("anchor-scope: --flag-chip")');
  });
});
