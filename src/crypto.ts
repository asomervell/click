const HASH_HEX = /^[0-9a-f]{64}$/;

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

export function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}${base64url(bytes)}`;
}

export function ownerKeyConfigured(hash: string | undefined): boolean {
  return HASH_HEX.test(hash?.trim().toLowerCase() ?? "");
}

/** Compare a presented owner key to the stored sha256 hex. Fixed-length digest compare. */
export async function ownerKeyMatches(presented: string, expectedHash: string | undefined): Promise<boolean> {
  const expected = expectedHash?.trim().toLowerCase() ?? "";
  if (!HASH_HEX.test(expected)) return false;
  if (presented.length === 0 || presented.length > 256) return false;
  const actual = await sha256Hex(presented);
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(actual), encoder.encode(expected));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return hex(new Uint8Array(mac));
}
