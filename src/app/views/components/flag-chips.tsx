import type { ListedFlag } from "../../listings.js";
import type { Messages } from "../../messages/index.js";
import { sampleHref } from "../../record.js";
import { FindingDetail } from "./finding.js";

/** At most this many chips; the rest are a link to the sample. */
const FLAGS_SHOWN = 3;
/** A hold's reason as a chip is cut here, with its whole text in the panel. */
const HOLD_CHIP_LENGTH = 24;

/**
 * A flag's chip text (beeline-ik0d): the problem in a word or two. A missing
 * field names the field, and a hold uses its reason (Peter, 2026-11-04),
 * since the staffer's words say more than "held by staff".
 */
function flagName(m: Messages, flag: ListedFlag): string {
  const names = m.listings.status;
  const detail = flag.details[0];
  if (flag.rule === "missing_required_field" && detail !== undefined) {
    const fields = detail.split(", ").map((f) => names.flagMissing[f]);
    if (fields.every((f) => f !== undefined)) return fields.join(", ");
  }
  if (flag.rule === "staff_hold" && detail !== undefined) {
    const reason = detail.trim();
    if (reason !== "") return reason.length > HOLD_CHIP_LENGTH ? `${reason.slice(0, HOLD_CHIP_LENGTH - 1).trimEnd()}…` : reason;
  }
  return names.flag[flag.rule];
}

/**
 * A sample's flags as chips (beeline-ik0d, Peter 2026-11-04): one chip per
 * kind of flag, named for the problem, its colour for whether it blocks
 * printing, and the rule's explanation and this sample's details on click or
 * tap — a <details> menu, so it opens without scripting, from the keyboard
 * and on a phone, where there is no hover; the hover text says the same for
 * a mouse. Colour is not the only signal: the severity is in each chip's
 * accessible name and at the head of its panel. A symbol for it waits on the
 * domain icon set (beeline-2c3.14).
 *
 * Drawn in the samples listing's Flags cell and after the sample's name on
 * a specimen page (beeline-8w8n). Each panel links to the sample, whose
 * page lists every flag in full. Draws nothing for no flags: where a clean
 * sample is worth saying, the caller says it.
 */
export function FlagChips({ m, flags, sampleId }: { m: Messages; flags: readonly ListedFlag[]; sampleId: number }) {
  const s = m.listings.status;
  if (flags.length === 0) return null;
  const more = flags.length - FLAGS_SHOWN;
  return (
    <span class="flag-chips">
      {flags.slice(0, FLAGS_SHOWN).map((flag) => {
        const name = flagName(m, flag);
        const severity = s.flagSeverity[flag.severity];
        const instruction = m.qcInstructions[flag.rule];
        return (
          <details class="menu flag-menu">
            <summary class={`chip ${flag.severity}`} title={`${severity}: ${instruction}`}>
              {name}
              <span class="visually-hidden">: {severity}</span>
            </summary>
            <div class="menu-panel flag-panel">
              <p class="flag-severity">{severity}</p>
              <p>{instruction}</p>
              {flag.details.map((d) => (
                <p>
                  <FindingDetail details={d} ruleName={flag.rule} />
                </p>
              ))}
              <a href={sampleHref(sampleId)}>{s.flagSeeSample}</a>
            </div>
          </details>
        );
      })}
      {more > 0 && <a href={sampleHref(sampleId)}>{s.flagMore(more)}</a>}
    </span>
  );
}
