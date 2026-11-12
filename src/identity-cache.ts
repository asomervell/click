import type { ClickProps, Identity } from "./types";

/**
 * A short per-isolate memo of what a credential can reach, so an agent polling its
 * inbox or waiting for messages does not cost a Directory round trip every call.
 * Only live identities are kept, never a failed lookup, and never the bearer token
 * check itself, so a revoked key or deleted click stops working at once. Anything
 * this isolate does that can change memberships (join, leave, remove, rename,
 * create, approve) clears the memo. Another isolate's change shows up within TTL_MS.
 */
export const IDENTITY_TTL_MS = 10_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { identity: Identity; at: number }>();

function keyOf(home: ClickProps): string {
  return `${home.role}|${home.clickId}|${home.principalId}`;
}

export function cachedIdentity(home: ClickProps, now = Date.now()): Identity | null {
  const key = keyOf(home);
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > IDENTITY_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return structuredClone(hit.identity);
}

export function rememberIdentity(home: ClickProps, identity: Identity | null, now = Date.now()): void {
  if (!identity) {
    cache.delete(keyOf(home));
    return;
  }
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(keyOf(home), { identity: structuredClone(identity), at: now });
}

/** Drop every memo in this isolate. Called after anything that can change memberships. */
export function forgetIdentities(): void {
  cache.clear();
}
