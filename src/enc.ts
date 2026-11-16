/**
 * Private clicks: the crypto. X25519 credential keys, ECDH-ES key slots, and AES-256-GCM
 * for message bodies and key chains. Everything here runs in the Worker; the click's
 * Durable Object stores only ciphertext, wrapped keys, and public keys.
 */
import { base64url, sha256Hex } from "./crypto";

const enc = new TextEncoder();
const dec = new TextDecoder();

// PKCS#8 header for a raw 32-byte X25519 private key (RFC 8410).
const PKCS8_X25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

export type CredKind = "cred" | "admin";

/** One credential's key pair. The private half lives only in memory for one request. */
export type CredKey = { id: string; pub: string; priv: CryptoKey; kind: CredKind };

export function fromB64(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded + "===".slice((padded.length + 3) % 4)), (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function randomBytes(n = 32): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** A fresh credential seed (base64url), kept in OAuth grant props. */
export function newSeed(): string {
  return base64url(randomBytes(32));
}

async function hkdf(ikm: Uint8Array, info: string, salt: Uint8Array = new Uint8Array(32)): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) }, key, 256);
  return new Uint8Array(bits);
}

/** The seed for a bearer secret (member token, account token, admin key). Never stored. */
export async function seedFromSecret(secret: string): Promise<string> {
  return base64url(await hkdf(enc.encode(secret), "click/cred/v1"));
}

export async function credFromSeed(seed: string, kind: CredKind = "cred"): Promise<CredKey> {
  const raw = fromB64(seed);
  if (raw.length !== 32) throw new Error("bad seed");
  const priv = await crypto.subtle.importKey("pkcs8", concat(PKCS8_X25519, raw), { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", priv) as JsonWebKey;
  const pub = String(jwk.x);
  return { id: (await sha256Hex(`click/key/${pub}`)).slice(0, 32), pub, priv, kind };
}

export async function credFromSecret(secret: string, kind: CredKind = "cred"): Promise<CredKey> {
  return credFromSeed(await seedFromSecret(secret), kind);
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM under a raw key. Output: v1.<iv>.<ciphertext>, base64url. */
export async function seal(keyRaw: Uint8Array, plaintext: Uint8Array, aad: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aesKey(keyRaw), plaintext);
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(ct))}`;
}

export async function open(keyRaw: Uint8Array, sealed: string, aad: string): Promise<Uint8Array> {
  const [version, iv, ct] = sealed.split(".");
  if (version !== "v1" || !iv || !ct) throw new Error("bad ciphertext");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv), additionalData: enc.encode(aad) }, await aesKey(keyRaw), fromB64(ct));
  return new Uint8Array(pt);
}

// Workers types name the field $public; the runtime takes the standard name.
function x25519(publicKey: CryptoKey): SubtleCryptoDeriveKeyAlgorithm {
  return { name: "X25519", public: publicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
}

/** Wrap a click data key to one credential's public key: ephemeral X25519, HKDF, AES-GCM. */
export async function wrapToPub(dek: Uint8Array, pub: string): Promise<string> {
  const recipient = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "X25519", x: pub }, { name: "X25519" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const shared = new Uint8Array(await crypto.subtle.deriveBits(x25519(recipient), eph.privateKey, 256));
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey) as ArrayBuffer);
  const kek = await hkdf(shared, "click/slot/v1", concat(ephPub, fromB64(pub)));
  return `x1.${base64url(ephPub)}.${await seal(kek, dek, "click/slot/v1")}`;
}

export async function unwrapWithCred(wrapped: string, cred: CredKey): Promise<Uint8Array> {
  const [version, ephPub, ...rest] = wrapped.split(".");
  if (version !== "x1" || !ephPub || rest.length !== 3) throw new Error("bad slot");
  const eph = await crypto.subtle.importKey("raw", fromB64(ephPub), { name: "X25519" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(x25519(eph), cred.priv, 256));
  const kek = await hkdf(shared, "click/slot/v1", concat(fromB64(ephPub), fromB64(cred.pub)));
  return open(kek, rest.join("."), "click/slot/v1");
}

/** Wrap a data key under a secret string (an invite). */
export async function wrapToSecret(dek: Uint8Array, secret: string, label: string): Promise<string> {
  return seal(await hkdf(enc.encode(secret), label), dek, label);
}

export async function unwrapWithSecret(wrapped: string, secret: string, label: string): Promise<Uint8Array> {
  return open(await hkdf(enc.encode(secret), label), wrapped, label);
}

export function messageAad(clickId: string, eventId: string, createdAt: number): string {
  return `click/msg/v1|${clickId}|${eventId}|${createdAt}`;
}

export async function sealText(dek: Uint8Array, text: string, aad: string): Promise<string> {
  return seal(dek, enc.encode(text), aad);
}

export async function openText(dek: Uint8Array, sealed: string, aad: string): Promise<string> {
  return dec.decode(await open(dek, sealed, aad));
}
