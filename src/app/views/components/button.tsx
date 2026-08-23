import type { Child } from "hono/jsx";

/**
 * Buttons and links-dressed-as-buttons.
 *
 * Variant is about weight on the page, not about what the action does:
 * `filled` for the one thing this screen wants you to do, `tonal` for
 * secondary actions, `outlined` for actions that sit beside content rather
 * than beneath it. A screen has at most one filled button.
 */
export type ButtonVariant = "filled" | "tonal" | "outlined";

const classes = (variant: ButtonVariant, base: string) =>
  variant === "filled" ? base : `${base} ${variant}`.trim();

export function Button({
  variant = "filled",
  type = "submit",
  children,
}: {
  variant?: ButtonVariant;
  type?: "submit" | "button";
  children: Child;
}) {
  const cls = classes(variant, "");
  return (
    <button type={type} class={cls === "" ? undefined : cls}>
      {children}
    </button>
  );
}

/**
 * A link that looks like a button. Used when the action is a navigation —
 * "Fix on iNaturalist", "Edit this sample" — so it stays a real link:
 * middle-clickable, copyable, and reachable without JavaScript.
 */
export function LinkButton({
  href,
  variant = "filled",
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  children: Child;
}) {
  return (
    <a class={classes(variant, "button")} href={href}>
      {children}
    </a>
  );
}

export const BUTTON_VARIANTS: ButtonVariant[] = ["filled", "tonal", "outlined"];
