import type { Messages } from "../../messages/index.js";
import { PencilIcon } from "../icons.js";
import { Combobox, type ComboboxChoice } from "./combobox.js";

/**
 * Changing a sample's locality where its place is shown (beeline-7ywr,
 * beeline-8w8n): the place as usual, and a pencil that opens, in its place,
 * a choice of iNaturalist's own locality, the names suggested from the
 * coordinates, and where `free`, a box to write any name in. A <details>,
 * so it opens without scripting, and the place text (`.place-text` beside
 * it) gives way to the form while it is open (components.css). Posts to
 * /samples/:id/place, which makes every locality write there is: adopting a
 * suggestion, following iNaturalist again, and a name staff write in.
 *
 * The samples listing draws it in the Place cell and the sample page in its
 * Place row, from the same choices in the same order, so the two cannot
 * offer different things. Who is offered it is the caller's to say.
 */
export function PlaceEdit({
  m,
  sampleId,
  sampleNumber,
  locality,
  county,
  stateProvince,
  observed,
  suggestions,
  free,
  back,
}: {
  m: Messages;
  sampleId: number;
  sampleNumber: string;
  /** The locality the sample holds now. */
  locality: string | null;
  county: string | null;
  stateProvince: string | null;
  /** What the observation yields, or null where the sample has none. Choosing it follows iNaturalist again. */
  observed: string | null;
  /** The names suggested from the coordinates, best first. */
  suggestions: readonly string[];
  /** Whether any name may be written in, not only one offered. */
  free: boolean;
  /** Where Save and Cancel return to. */
  back: string;
}) {
  const t = m.listings.samples.placeEdit;
  // iNaturalist's own name first, then Beeline's, best first, then what the
  // sample holds if it is none of those: one name, one choice. Each is shown
  // with the sample's county and state, as the Place column writes the place
  // (Peter, 2026-11-04); only the locality is saved, since the county and
  // state are fields of their own.
  const choices: ComboboxChoice[] = [];
  const add = (value: string | null, note: string) => {
    if (value !== null && value !== "" && !choices.some((c) => c.value === value))
      choices.push({ value, label: m.format.place([value, county, stateProvince]), note });
  };
  add(observed, t.noteInaturalist);
  suggestions.forEach((name, i) => add(name, i === 0 ? t.noteSuggested : t.noteAlternative));
  add(locality, t.noteCurrent);
  const id = `place-${sampleId}`;
  // Editing shows only the box and its two buttons: the pencil gives way
  // (components.css), and Cancel is a link back, which closes the editor
  // without scripting and is intercepted to close it in place.
  return (
    <details class="place-edit">
      <summary class="icon-button" aria-label={t.open(sampleNumber)} title={t.open(sampleNumber)}>
        <PencilIcon />
      </summary>
      <form method="post" action={`/samples/${sampleId}/place`} class="place-edit-form">
        <input type="hidden" name="back" value={back} />
        <Combobox id={id} name="locality" label={t.label} labelHidden value={locality} choices={choices} free={free} />
        <div class="row">
          <button type="submit" class="outlined compact-button">
            {t.save}
          </button>
          <a href={back} data-close-details="">
            {t.cancel}
          </a>
        </div>
      </form>
    </details>
  );
}
