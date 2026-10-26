import type { Messages } from "../../messages/index.js";
import type { LocalityBasis } from "../../../locality-rule.js";

/**
 * A locality named from the sample's coordinates (beeline-7i6), with a
 * button that copies it, so a volunteer pastes the name into the
 * observation on iNaturalist rather than inventing one. The button is
 * `hidden` until src/app/islands/copy.ts finds it: without script the name
 * is still there to select, and a button that does nothing is worse than
 * none.
 */
export function SuggestedLocality({
  m,
  locality,
  basis,
}: {
  m: Messages;
  locality: string;
  basis: LocalityBasis;
}) {
  const t = m.suggestedLocality;
  return (
    <span class="suggested-locality">
      {t.lead} <strong>{locality}</strong> <span class="meta">({t.basis[basis]})</span>{" "}
      <button type="button" class="outlined copy-button" data-copy={locality} data-copied={t.copied} hidden>
        {t.copy}
      </button>
    </span>
  );
}
