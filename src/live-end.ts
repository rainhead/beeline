/**
 * What the Method form shows as a sample's end day: the stored end, or blank for a one-day sample, since a blank end
 * means one day for every sample whatever its method (beeline-ni5m.15, stage three). Read by the form, the save that
 * compares against it and the samples upload's plan, so the three cannot disagree. The plan derives its base end
 * from the exported eventDate separately (src/app/samples-upload-plan.ts, `changeFor`), so a change to the date format
 * must check both.
 */
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export const liveEndOf = (start: Date, end: Date): string => (isoDate(end) === isoDate(start) ? "" : isoDate(end));
