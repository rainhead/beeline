/**
 * Losing a write race, and trying again.
 *
 * DuckDB has no row locks: when two transactions write one row, the second
 * does not wait, it fails — `TransactionContext Error: Conflict on update!` —
 * and its transaction is rolled back. bench/contention.ts measured who loses
 * when a small write lands on a row the nightly promotion is rewriting: the
 * promotion, every time, since it holds its transaction open for seconds and
 * the small writer commits in milliseconds (beeline-lpx). A lost transaction
 * that is idempotent can simply run again once the winner has committed,
 * which is what this does, a bounded number of times.
 *
 * Only that class of error. A duplicate key is a constraint violation, not a
 * race the next attempt would win, and anything else is the caller's
 * problem. src/app/session.ts lets its bookkeeping writes lose to the same
 * error instead, because there the winner wrote the same value.
 */

const CONFLICT = /TransactionContext Error:.*conflict|write-write conflict/i;

export function isWriteConflict(err: unknown): boolean {
  return err instanceof Error && CONFLICT.test(err.message);
}

export interface ConflictRetryOptions {
  /** One wait per retry, so its length is the number of retries. */
  delaysMs?: readonly number[];
  /** Stop retrying once aborted: a job being shut down should not start over. */
  signal?: AbortSignal;
  /** Injectable for tests; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

const timer = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt`, and run it again after each delay for as long as it loses a
 * write conflict. `attempt` must be safe to repeat — one transaction that
 * rolls back whole when it fails. Resolves with the value and how many
 * retries it took, so a caller can record that it had to.
 */
export async function retryOnWriteConflict<T>(
  attempt: () => Promise<T>,
  opts: ConflictRetryOptions = {},
): Promise<{ value: T; retries: number }> {
  const delays = opts.delaysMs ?? [1_000, 5_000, 15_000];
  const sleep = opts.sleep ?? timer;
  for (let retries = 0; ; retries++) {
    try {
      return { value: await attempt(), retries };
    } catch (err) {
      if (!isWriteConflict(err) || retries >= delays.length || opts.signal?.aborted) throw err;
      await sleep(delays[retries]!);
      // Aborted while waiting: shutdown has begun, so do not start over.
      if (opts.signal?.aborted) throw err;
    }
  }
}
