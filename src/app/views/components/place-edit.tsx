import type { Messages } from "../../messages/index.js";
import type { LocalitySuggestion } from "../../record.js";
import { InlineEdit } from "./inline-edit.js";
import { Combobox, type ComboboxChoice } from "./combobox.js";
import { Meta } from "./text.js";

/**
 * Changing a sample's locality where its place is shown (beeline-7ywr,
 * beeline-8w8n): the place as usual, and a pencil that opens, in its place,
 * a choice of iNaturalist's own locality, the names suggested from the
 * coordinates, and where `free`, a box to write any name in (`InlineEdit`:
 * the place text goes in an `inline-edit-text` element beside it). Posts to
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
  printed = false,
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
  /** The names suggested from the coordinates, best first, each with why it was offered. */
  suggestions: readonly LocalitySuggestion[];
  /** Whether any name may be written in, not only one offered. */
  free: boolean;
  /** Whether labels have printed, which only staff are offered the editor on: it then says the labels keep the old name. */
  printed?: boolean;
  /** Where Save and Cancel return to. */
  back: string;
}) {
  const t = m.listings.samples.placeEdit;
  // iNaturalist's own name first, then Beeline's, best first, then what the
  // sample holds if it is none of those: one name, one choice. Each is shown
  // with the sample's county and state, as the Place column writes the place
  // (Peter, 2026-11-04); only the locality is saved, since the county and
  // state are fields of their own. A suggested name's note says in a word or
  // two why it was offered ("nearby town", Peter 2026-11-06), which tells
  // the reader more than that it was suggested.
  const choices: ComboboxChoice[] = [];
  const add = (value: string | null, note: string) => {
    if (value !== null && value !== "" && !choices.some((c) => c.value === value))
      choices.push({ value, label: m.format.place([value, county, stateProvince]), note });
  };
  add(observed, t.noteInaturalist);
  suggestions.forEach((s) => add(s.locality, t.noteBasis[s.basis]));
  add(locality, t.noteCurrent);
  const id = `place-${sampleId}`;
  return (
    <InlineEdit label={t.open(sampleNumber)} action={`/samples/${sampleId}/place`} back={back} save={t.save} cancel={t.cancel}>
      <Combobox id={id} name="locality" label={t.label} labelHidden value={locality} choices={choices} free={free} />
      {printed && <Meta block>{t.printed}</Meta>}
    </InlineEdit>
  );
}
