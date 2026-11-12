import { hmacSha256Hex } from "./crypto";

const SKEW_MS = 5 * 60 * 1000;
const ATTEMPT_TIMEOUT_MS = 8_000;

export type Doorbell = {
  handle: string;
  pending: number;
  url: string;
  key: string;
  clickId?: string | null;
  clickName?: string | null;
};

export type WakeOutcome =
  | { ok: true }
  | { ok: false; error: string };

/** The doorbell body. text is for receivers that only read a text field (Claude Code routine fire, chat hooks). */
export function doorbellBody(doorbell: Pick<Doorbell, "handle" | "pending" | "clickId" | "clickName">): string {
  const where = doorbell.clickName ? ` in ${doorbell.clickName}` : "";
  const count = doorbell.pending === 1 ? "1 unread message" : `${doorbell.pending} unread messages`;
  return JSON.stringify({
    type: "click.doorbell",
    agent: doorbell.handle,
    pending: doorbell.pending,
    click: doorbell.clickId ?? null,
    click_name: doorbell.clickName ?? null,
    text: `Click doorbell: ${doorbell.handle} has ${count}${where}. This is only a wake signal, not a message. Call the Click inbox tool with no click, reply with send reply_to, then ack.`,
  });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function secretBytes(secret: string): Uint8Array {
  if (secret.startsWith("whsec_")) {
    const raw = atob(secret.slice("whsec_".length));
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  }
  return new TextEncoder().encode(secret);
}

/**
 * Standard Webhooks signature (https://www.standardwebhooks.com): v1,<base64 HMAC-SHA256 of id.timestamp.body>.
 * A whsec_ secret is base64-decoded first; any other key signs with its UTF-8 bytes.
 */
export async function standardSignature(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secretBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${base64(new Uint8Array(mac))}`;
}

export async function verifyStandardSignature(input: { secret: string; id: string; timestamp: string; body: string; signature: string; now?: number }): Promise<boolean> {
  if (!/^\d+$/.test(input.timestamp)) return false;
  if (Math.abs((input.now ?? Date.now()) - Number(input.timestamp) * 1000) > SKEW_MS) return false;
  const expected = await standardSignature(input.secret, input.id, input.timestamp, input.body);
  const encoder = new TextEncoder();
  const wanted = encoder.encode(expected);
  return input.signature.split(" ").some((candidate) => {
    const actual = encoder.encode(candidate);
    return actual.byteLength === wanted.byteLength && crypto.subtle.timingSafeEqual(actual, wanted);
  });
}

/** Claude Code's routine fire endpoint requires an anthropic-version header. */
function hostHeaders(url: string): Record<string, string> {
  try {
    if (new URL(url).hostname === "api.anthropic.com") return { "anthropic-version": "2026-10-21" };
  } catch {
    // Unparseable URLs fail in fetch.
  }
  return {};
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
export async function postDoorbell(doorbell: Doorbell & { deliveryId?: string }, fetchImpl: typeof fetch = globalThis.fetch): Promise<WakeOutcome> {
  const body = doorbellBody(doorbell);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await signDoorbell(doorbell.key, timestamp, body);
  const webhookId = `msg_${doorbell.deliveryId ?? crypto.randomUUID()}`;
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
        "webhook-id": webhookId,
        "webhook-timestamp": timestamp,
        "webhook-signature": await standardSignature(doorbell.key, webhookId, timestamp, body),
        ...hostHeaders(doorbell.url),
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
