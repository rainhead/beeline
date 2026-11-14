/**
 * A short line for the API's read endpoints, shared by every key (beeline-pnqr.2).
 *
 * A listing takes a fraction of a second of DuckDB's time on the whole store,
 * and production's machine is small. The request limit counts how often a
 * person asks, not how many requests are being answered at once, so this
 * bounds the second: at most `max` run at a time, at most `maxWaiting` wait,
 * and a request that would make the line longer is turned away at once. A page
 * request never goes through it.
 */
export class ReadQueue {
  private running = 0;
  private readonly waiting: Array<(release: () => void) => void> = [];

  constructor(
    readonly max = 2,
    readonly maxWaiting = 20,
  ) {}

  /** How many are running and how many are waiting, for tests and logs. */
  get state() {
    return { running: this.running, waiting: this.waiting.length };
  }

  /**
   * A turn: resolves with the function that gives it back, or with null when
   * the line is full, or when `signal` aborts while waiting (the client went
   * away). The turn must be given back on every path, and giving it back twice
   * does no harm.
   */
  acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    if (this.running < this.max) {
      this.running += 1;
      return Promise.resolve(this.releaser());
    }
    if (this.waiting.length >= this.maxWaiting) return Promise.resolve(null);
    return new Promise((resolve) => {
      const grant = (release: () => void) => {
        signal?.removeEventListener("abort", leave);
        resolve(release);
      };
      const leave = () => {
        const at = this.waiting.indexOf(grant);
        if (at >= 0) this.waiting.splice(at, 1);
        resolve(null);
      };
      this.waiting.push(grant);
      signal?.addEventListener("abort", leave, { once: true });
      if (signal?.aborted === true) leave();
    });
  }

  private releaser(): () => void {
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.running -= 1;
      const next = this.waiting.shift();
      if (next !== undefined) {
        this.running += 1;
        next(this.releaser());
      }
    };
  }
}
