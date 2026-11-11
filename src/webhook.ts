import { hmacSha256Hex } from "./crypto";

const SKEW_MS = 5 * 60 * 1000;
const ATTEMPT_TIMEOUT_MS = 8_000;

export type Doorbell = {
  handle: string;
  pending: number;
  url: string;
  key: string;
};

export type WakeOutcome =
  | { ok: true }
  | { ok: false; error: string };

export function doorbellBody(doorbell: Pick<Doorbell, "handle" | "pending">): string {
  return JSON.stringify({
    type: "click.doorbell",
    agent: doorbell.handle,
    pending: doorbell.pending,
  });
}

export async function signDoorbell(key: string, timestamp: string, body: string): Promise<string> {
  const mac = await hmacSha256Hex(key, `${timestamp}.${body}`);
  return `v1=${mac}`;
}

export async function verifyDoorbell(input: {
  key: string;
  timestamp: string;
  body: string;
  signature: string;
  now?: number;
}): Promise<boolean> {
  if (!/^\d+$/.test(input.timestamp)) return false;
  const skew = Math.abs((input.now ?? Date.now()) - Number(input.timestamp) * 1000);
  if (skew > SKEW_MS) return false;
  const expected = await signDoorbell(input.key, input.timestamp, input.body);
  const encoder = new TextEncoder();
  const actual = encoder.encode(input.signature);
  const wanted = encoder.encode(expected);
  if (actual.byteLength !== wanted.byteLength) return false;
  return crypto.subtle.timingSafeEqual(actual, wanted);
}

function safeError(message: string, url: string): string {
  return message.replaceAll(url, "[url]").slice(0, 180);
}

/** POST a signed doorbell. Does not follow redirects, so the bearer key stays on the registered host. */
export async function postDoorbell(doorbell: Doorbell, fetchImpl: typeof fetch = globalThis.fetch): Promise<WakeOutcome> {
  const body = doorbellBody(doorbell);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await signDoorbell(doorbell.key, timestamp, body);
  try {
    const response = await fetchImpl(doorbell.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${doorbell.key}`,
        "user-agent": "Click",
        "x-click-timestamp": timestamp,
        "x-click-signature": signature,
      },
      body,
    });
    await response.body?.cancel();
    if (response.status >= 200 && response.status < 300) return { ok: true };
    return { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "network error";
    return { ok: false, error: safeError(message, doorbell.url) };
  }
}

/** Delay before the next attempt. Null means the delivery is exhausted. */
export function retryDelayMs(attempts: number): number | null {
  if (attempts >= 5) return null;
  const schedule = [15_000, 60_000, 300_000, 1_800_000];
  return schedule[attempts - 1] ?? 1_800_000;
}
