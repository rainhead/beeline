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

/**
 * The other names offered for the point (beeline-4hxe), each with its own
 * button where the reader may change the sample. The button is the same form
 * as the suggestion's, so the route checks the name against the candidates
 * the store holds now.
 */
export function LocalityAlternatives({
  m,
  alternatives,
  current,
  action,
}: {
  m: Messages;
  alternatives: ReadonlyArray<{ locality: string; basis: LocalityBasis }>;
  /** The sample's locality, which is marked rather than offered. */
  current: string | null;
  action: SuggestedLocalityAction;
}) {
  const t = m.suggestedLocality;
  if (alternatives.length === 0) return null;
  return (
    <span class="suggested-locality locality-alternatives">
      {t.alternativesLead}{" "}
      {alternatives.map((a) => (
        <span class="locality-alternative">
          <strong>{a.locality}</strong> <span class="meta">({t.basis[a.basis]})</span>{" "}
          {a.locality === current ? (
            <span class="meta">{t.inUseShort}</span>
          ) : action.kind === "use" ? (
            <form method="post" action={action.action} class="inline-form">
              <input type="hidden" name="locality" value={a.locality} />
              <input type="hidden" name="return" value={action.returnTo} />
              <button type="submit" class="outlined compact-button">
                {t.useShort}
              </button>
            </form>
          ) : null}
        </span>
      ))}
    </span>
  );
}
