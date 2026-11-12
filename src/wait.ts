/**
 * wait_for_message without holding a ClickHub awake. The worker does the waiting: it asks
 * each hub a cheap "anything unread?" question, then sleeps with backoff (2s, 3s, 4.5s, then
 * every 5s) until something lands or the time is up. Awaiting a timer costs the worker no CPU,
 * and each hub check is a few milliseconds, so a 50 second wait no longer keeps a Durable
 * Object active for 50 seconds.
 *
 * A send handled by this same isolate nudges waiters on that click, so the common case
 * (both agents on one colo) still wakes within a quarter second instead of at the next poll.
 */
export const FIRST_POLL_MS = 2_000;
export const MAX_POLL_MS = 5_000;
const BACKOFF = 1.5;

export const TICK_MS = 250;

/**
 * Sends seen by this isolate, per click. A waiter cannot be resolved from another request's
 * context (Workers forbid cross-request I/O), so instead of a callback a send bumps a counter
 * and each napping waiter notices it on its own short timer tick. A tick is a timer and a
 * map lookup: no I/O and next to no CPU.
 */
const sends = new Map<string, number>();
let napping = 0;

/** Tell this isolate's waiters on a click to check now. */
export function nudgeWaiters(clickId: string): void {
  sends.set(clickId, (sends.get(clickId) ?? 0) + 1);
  if (sends.size > 1_000) sends.clear();
}

function seen(clickIds: string[]): string {
  return clickIds.map((id) => sends.get(id) ?? 0).join(",");
}

/** Sleep up to ms, or less if a send on one of these clicks nudges us. */
async function nap(ms: number, clickIds: string[], now: () => number): Promise<void> {
  const until = now() + ms;
  const before = seen(clickIds);
  napping += 1;
  try {
    for (;;) {
      const left = until - now();
      if (left <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(TICK_MS, left)));
      if (seen(clickIds) !== before) return;
    }
  } finally {
    napping -= 1;
  }
}

/**
 * Resolve true as soon as check() reports mail, false once ms has passed with none.
 * check() runs at once, after every nap, and one last time at the deadline.
 */
export async function pollUntil(
  check: () => Promise<boolean>,
  ms: number,
  clickIds: string[],
  options: { now?: () => number; first?: number; max?: number } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(0, ms);
  let interval = options.first ?? FIRST_POLL_MS;
  const cap = options.max ?? MAX_POLL_MS;
  for (;;) {
    if (await check()) return true;
    const left = deadline - now();
    if (left <= 0) return false;
    await nap(Math.min(interval, left), clickIds, now);
    interval = Math.min(cap, Math.round(interval * BACKOFF));
  }
}

/** Waiters currently napping in this isolate, for tests. */
export function nappingCount(): number {
  return napping;
}
