import type { Child } from "hono/jsx";
import { Field } from "./field.js";

/**
 * A combobox: one text box that offers a short list of known values under
 * it (beeline-wn2). Use it wherever a field has values worth offering — a
 * locality suggested from the coordinates, a person, a taxon — instead of a
 * <select> beside a text box, or a bare text box the person has to guess
 * into.
 *
 * What it is, formally:
 *
 * - **Anatomy.** A label (a real `<label for>`, as every field here has); the
 *   box, `role="combobox"`; under it, while open, a panel holding the
 *   `listbox` of choices, each an `option` showing its value and an optional
 *   note in secondary text (where the value came from, say), or a line
 *   saying nothing matches; and the field's hint under the box.
 * - **Choices.** Each is a value, which fills the box and is what the form
 *   submits, with an optional note. The box holds text, not an id: a field
 *   whose answer is an entity takes the entity's name and the route looks
 *   it up, or uses the island's `search` and `pick` (the taxon picker).
 * - **Free or not.** `free` lets any text stand, a choice or not (staff
 *   writing a locality in); without it only a choice will do, and the route
 *   refuses anything else, since the server is where that is enforced.
 * - **Behaviour** (src/app/islands/combobox.ts, the rules in
 *   combobox-model.ts). Focusing or clicking the box opens the list. Typing
 *   narrows it to the choices every typed word begins a word of, and an
 *   empty box, or one holding a choice exactly, shows them all. Down and Up
 *   move the highlight, Enter takes the highlighted choice into the box (and
 *   with nothing highlighted, submits free text as typed), Escape closes the
 *   list and a second Escape puts back what the box held, Tab moves on
 *   without choosing, and clicking a choice takes it. Focus stays in the box
 *   throughout, the highlight named by `aria-activedescendant`.
 * - **Without scripting** it is the same box with a native `<datalist>`:
 *   the browser offers the choices as the person types, and the form submits
 *   the same field. The island takes the box over when it starts, keeping
 *   its id, name and value.
 *
 * Not for: a choice among a few fixed codes that are not text a person
 * would type (a status, a method) — that is a `SelectField`; or a long list
 * the page cannot carry, which wants the island's `search`.
 */
export interface ComboboxChoice {
  value: string;
  note?: string;
}

export function Combobox({
  id,
  name,
  label,
  value,
  choices,
  free = false,
  hint,
  placeholder,
}: {
  id: string;
  name: string;
  label: Child;
  value?: string | null;
  choices: readonly ComboboxChoice[];
  free?: boolean;
  hint?: Child;
  placeholder?: string;
}) {
  const listId = `${id}-choices`;
  return (
    <Field id={id} label={label} hint={hint}>
      {/* Present or absent, never "false": the island reads any value as true. */}
      <beeline-combobox free={free ? "" : undefined}>
        <input id={id} name={name} type="text" value={value ?? ""} list={listId} autocomplete="off" placeholder={placeholder} />
        <datalist id={listId}>
          {choices.map((c) => (
            <option value={c.value} label={c.note} />
          ))}
        </datalist>
      </beeline-combobox>
    </Field>
  );
}
