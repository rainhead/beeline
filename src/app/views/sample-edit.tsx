import type { Messages } from "../messages/index.js";
import { EDITABLE_FIELDS, type EditableSample } from "../sample-edit.js";

/**
 * The edit form for a non-iNat-backed sample (beeline-2c3.8): the fields the
 * correction overlay can carry, prefilled with current values. Plain form
 * POST — no island; the redirect back to the QC home shows the effect.
 */
export function SampleEditForm({ m, sample }: { m: Messages; sample: EditableSample }) {
  return (
    <>
      <h1>{m.sampleEdit.heading(sample.sample_number)}</h1>
      <p style="font: var(--md-sys-typescale-label); color: var(--md-sys-color-on-surface-variant)">
        {m.qc.sampleTitle(sample.sample_number, sample.date_start)}
      </p>
      <p>{m.sampleEdit.intro}</p>
      <form method="post" style="max-width: 28rem">
        {EDITABLE_FIELDS.map((f) => (
          <>
            <label for={`edit-${f.name}`}>{m.sampleEdit.fields[f.name]}</label>
            {/* The rendered value rides along so the save can tell a touched
                field from a stale prefill (beeline-0br). */}
            <input type="hidden" name={`base:${f.name}`} value={sample[f.name] ?? ""} />
            <input id={`edit-${f.name}`} name={f.name} type="text" value={sample[f.name] ?? ""} />
          </>
        ))}
        <label for="edit-note">{m.sampleEdit.noteLabel}</label>
        <input id="edit-note" name="note" type="text" placeholder={m.sampleEdit.noteHint} />
        <p style="display: flex; gap: 0.75rem; align-items: center">
          <button type="submit">{m.sampleEdit.save}</button>
          <a href="/">{m.sampleEdit.cancel}</a>
        </p>
      </form>
    </>
  );
}
