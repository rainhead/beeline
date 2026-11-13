/**
 * One save at a time for a sample, from reading it to recording the change
 * (beeline-p8y1). A save writes the corrections file, the live sample and the
 * sample change log; two saves of one sample interleaving could leave the
 * file holding one's value and the sample the other's, which a rebuild would
 * then act on, or record both under the first author (CodeRabbit and the
 * independent review on PR #314). The app is the one process that writes
 * any of them (ADR 0005), so a promise chain per sample is the whole lock.
 * Every route that writes a sample's corrections goes through it: the
 * collector's edit form, the staff place editor and the Method pencil.
 */
const queues = new Map<number, Promise<unknown>>();

export function onSample<T>(sampleId: number, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(sampleId) ?? Promise.resolve()).catch(() => {}).then(work);
  queues.set(sampleId, run);
  void run
    .catch(() => {})
    .finally(() => {
      if (queues.get(sampleId) === run) queues.delete(sampleId);
    });
  return run;
}
