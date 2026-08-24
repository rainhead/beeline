import type { Child } from "hono/jsx";

/**
 * A labelled form control with an optional hint.
 *
 * The label is always a real `<label for>` — placeholder-as-label is not a
 * pattern here, because it vanishes exactly when the volunteer needs it.
 */
export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: Child;
  hint?: Child;
  children: Child;
}) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {children}
      {hint !== undefined && <p class="field-hint">{hint}</p>}
    </div>
  );
}

/**
 * The common case: a single-line text field. `base` rides along as a hidden
 * input so a save can tell a touched field from a stale prefill
 * (beeline-0br).
 */
export function TextField({
  id,
  name,
  label,
  value,
  hint,
  placeholder,
  base,
}: {
  id: string;
  name: string;
  label: Child;
  value?: string | null;
  hint?: Child;
  placeholder?: string;
  base?: string | null;
}) {
  return (
    <Field id={id} label={label} hint={hint}>
      {base !== undefined && <input type="hidden" name={`base:${name}`} value={base ?? ""} />}
      <input id={id} name={name} type="text" value={value ?? ""} placeholder={placeholder} />
    </Field>
  );
}

/**
 * A `<select>` with the same label-and-hint treatment as a text field.
 * Options are (value, label) pairs so the value stays a stable code and the
 * label stays translatable.
 */
export function SelectField({
  id,
  name,
  label,
  value,
  options,
  hint,
}: {
  id: string;
  name: string;
  label: Child;
  value: string;
  options: ReadonlyArray<readonly [string, Child]>;
  hint?: Child;
}) {
  return (
    <Field id={id} label={label} hint={hint}>
      <select id={id} name={name}>
        {options.map(([optionValue, optionLabel]) => (
          <option value={optionValue} selected={optionValue === value}>
            {optionLabel}
          </option>
        ))}
      </select>
    </Field>
  );
}
