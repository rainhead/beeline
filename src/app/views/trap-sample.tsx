import type { Messages } from "../messages/index.js";
import { type FieldProblems, type TrapSampleForm } from "../../trap-sample.js";
import { Button, Callout, Field, Meta, PageHeader, SelectField, TextField } from "./components/index.js";
import { Combobox } from "./components/combobox.js";

/** How many collector boxes the form offers: the old records name at most three. */
export const COLLECTOR_SLOTS = 3;

/**
 * The form for entering a trap sample, or editing one entered here
 * (beeline-3vs.2). Plain form POST, as the other sample forms are; a refused
 * save comes back to the same form with what was typed and a line under
 * each field that was wrong.
 */
export function TrapSampleFormPage({
  m,
  form,
  problems,
  collectorNames,
  methods,
  action,
  sampleId,
  releasesLabels = false,
}: {
  m: Messages;
  form: TrapSampleForm;
  problems: FieldProblems;
  collectorNames: readonly { name: string; trap: boolean }[];
  /** The codes of the methods the form offers (`methodCodes` with `trapOnly`, src/trap-sample.ts). */
  methods: readonly string[];
  action: string;
  /** The sample being edited; absent when entering a new one. */
  sampleId?: number;
  /** Staff saving a sample from a settled season: the save releases its labels for printing (beeline-3vs.7). */
  releasesLabels?: boolean;
}) {
  const t = m.trapSample;
  const problem = (field: keyof TrapSampleForm) =>
    problems[field] === undefined ? undefined : <span class="field-problem">{problems[field]}</span>;
  const people = collectorNames.map((p) => ({ value: p.name, note: p.trap ? t.trapCollectorNote : undefined }));
  const date = (name: "date_start" | "date_end", label: string, hint: string) => (
    <Field id={`trap-${name}`} label={label} hint={problem(name) ?? hint}>
      <input id={`trap-${name}`} name={name} type="date" value={form[name]} />
    </Field>
  );
  return (
    <>
      <PageHeader title={sampleId === undefined ? t.newHeading : t.editHeading(form.sample_number)} lede={t.intro} />
      {Object.keys(problems).length > 0 && <Callout tone="blocking">{t.notSaved}</Callout>}
      <form method="post" action={action} class="form-column">
        <TextField id="trap-sample_number" name="sample_number" label={t.fields.sampleNumber} value={form.sample_number} hint={problem("sample_number") ?? t.hints.sampleNumber} />
        {Array.from({ length: COLLECTOR_SLOTS }, (_, i) => (
          <Combobox
            id={`trap-collector-${i}`}
            name="collector"
            label={i === 0 ? t.fields.collector : t.fields.otherCollector(i + 1)}
            value={form.collectors[i] ?? ""}
            choices={people}
            hint={i === 0 ? (problem("collectors") ?? t.hints.collector) : undefined}
          />
        ))}
        {date("date_start", t.fields.dateStart, t.hints.dateStart)}
        {date("date_end", t.fields.dateEnd, t.hints.dateEnd)}
        <SelectField
          id="trap-method"
          name="method"
          label={t.fields.method}
          value={form.method}
          options={[
            ["", t.hints.methodChoose],
            // The sample's own words, where they are not a listed method: kept unless another is chosen.
            ...(form.method.trim() === "" || methods.includes(form.method) ? [] : [[form.method, m.record.sample.methodEdit.protocolAsWritten(form.method)] as const]),
            ...methods.map((code) => [code, code] as const),
          ]}
          hint={problem("method") ?? t.hints.method}
        />
        <TextField id="trap-trap_count" name="trap_count" label={t.fields.trapCount} value={form.trap_count} hint={problem("trap_count") ?? t.hints.trapCount} />
        <TextField id="trap-specimen_count" name="specimen_count" label={t.fields.specimenCount} value={form.specimen_count} hint={problem("specimen_count") ?? t.hints.specimenCount} />
        <TextField id="trap-latitude" name="latitude" label={t.fields.latitude} value={form.latitude} hint={problem("latitude") ?? t.hints.latitude} />
        <TextField id="trap-longitude" name="longitude" label={t.fields.longitude} value={form.longitude} hint={problem("longitude") ?? t.hints.longitude} />
        <TextField id="trap-uncertainty" name="uncertainty" label={t.fields.uncertainty} value={form.uncertainty} hint={problem("uncertainty") ?? t.hints.uncertainty} />
        <TextField id="trap-country" name="country" label={t.fields.country} value={form.country} hint={problem("country")} />
        <TextField id="trap-state_province" name="state_province" label={t.fields.stateProvince} value={form.state_province} hint={problem("state_province") ?? t.hints.stateProvince} />
        <TextField id="trap-county" name="county" label={t.fields.county} value={form.county} hint={t.hints.county} />
        <TextField id="trap-locality" name="locality" label={t.fields.locality} value={form.locality} hint={t.hints.locality} />
        {releasesLabels && <Meta block>{sampleId === undefined ? t.releasesLabelsNew : t.releasesLabelsEdit}</Meta>}
        <p class="row">
          <Button>{sampleId === undefined ? t.create : t.save}</Button>
          <a href={sampleId === undefined ? "/samples" : `/samples/${sampleId}`}>{t.cancel}</a>
        </p>
      </form>
    </>
  );
}

/**
 * Staff deleting a trap sample entered in Beeline (beeline-kgyd.4.10): a page that says what goes, and a form that
 * does it. Where the sample cannot be deleted, the page says why and offers nothing.
 */
export function TrapSampleDelete({ m, sampleId, sampleNumber, refusal }: { m: Messages; sampleId: number; sampleNumber: string; refusal: string | null }) {
  const t = m.trapSample.delete;
  return (
    <>
      <PageHeader title={t.heading(sampleNumber)} />
      {refusal !== null ? (
        <>
          <Callout tone="warning">{refusal}</Callout>
          <p>
            <a href={`/samples/${sampleId}`}>{t.cancel}</a>
          </p>
        </>
      ) : (
        <>
          <p>{t.explain}</p>
          <form method="post" action={`/samples/${sampleId}/delete`} class="form-column">
            <p class="row">
              <Button>{t.confirm}</Button>
              <a href={`/samples/${sampleId}`}>{t.cancel}</a>
            </p>
          </form>
        </>
      )}
    </>
  );
}
