import type { Messages } from "../messages/index.js";
import { EDITABLE_FIELDS, type EditableSample } from "../sample-edit.js";
import { Button, PageHeader, TextField } from "./components/index.js";

/**
 * The edit form for a non-iNat-backed sample (beeline-2c3.8): the fields the
 * correction overlay can carry, prefilled with current values. Plain form
 * POST — no island; the redirect back to the QC home shows the effect.
 */
export function SampleEditForm({ m, sample }: { m: Messages; sample: EditableSample }) {
  return (
    <>
      <PageHeader
        title={m.sampleEdit.heading(sample.sample_number)}
        meta={m.qc.sampleTitle(sample.sample_number, sample.date_start)}
        lede={m.sampleEdit.intro}
      />
      <form method="post" class="form-column">
        {EDITABLE_FIELDS.map((f) => (
          /* The rendered value rides along as `base:` so the save can tell a
             touched field from a stale prefill (beeline-0br). */
          <TextField
            id={`edit-${f.name}`}
            name={f.name}
            label={m.sampleEdit.fields[f.name]}
            value={sample[f.name]}
            base={sample[f.name]}
          />
        ))}
        <TextField id="edit-note" name="note" label={m.sampleEdit.noteLabel} placeholder={m.sampleEdit.noteHint} />
        <p class="row">
          <Button>{m.sampleEdit.save}</Button>
          <a href="/">{m.sampleEdit.cancel}</a>
        </p>
      </form>
    </>
  );
}
