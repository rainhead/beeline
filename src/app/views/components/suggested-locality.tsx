import type { Messages } from "../../messages/index.js";
import type { LocalityBasis } from "../../../locality-rule.js";

/** What the reader may do with the suggestion. */
export type SuggestedLocalityAction =
  /** Make it the sample's locality: a form posting to `action`. */
  | { kind: "use"; action: string; returnTo: "home" | "sample" }
  /** It is the sample's locality already. */
  | { kind: "inUse" }
  /** Labels have printed, so the locality no longer changes. */
  | { kind: "printed" }
  /** Not theirs to change: the name alone. */
  | { kind: "none" };

/**
 * A locality named from the sample's coordinates (beeline-7i6), with why it
 * was chosen and, for the sample's collector, a button that makes it the
 * sample's locality in one click. The form posts the name it showed, so a
 * suggestion that changed in between is refused rather than adopted unseen.
 */
export function SuggestedLocality({
  m,
  locality,
  basis,
  action,
}: {
  m: Messages;
  locality: string;
  basis: LocalityBasis;
  action: SuggestedLocalityAction;
}) {
  const t = m.suggestedLocality;
  return (
    <span class="suggested-locality">
      {t.lead} <strong>{locality}</strong> <span class="meta">({t.basis[basis]})</span>{" "}
      {action.kind === "use" ? (
        <form method="post" action={action.action} class="inline-form">
          <input type="hidden" name="locality" value={locality} />
          <input type="hidden" name="return" value={action.returnTo} />
          <button type="submit" class="outlined compact-button">
            {t.use}
          </button>
        </form>
      ) : action.kind === "inUse" ? (
        <span class="meta">{t.inUse}</span>
      ) : action.kind === "printed" ? (
        <span class="meta">{t.printed}</span>
      ) : null}
    </span>
  );
}
