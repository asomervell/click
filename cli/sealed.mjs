// Sealed clicks, client side. Zero dependencies: WebCrypto only, so it runs in Node 20+ and in
// Workers. HPKE (RFC 9180) DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base and auth
// modes, single-shot. Plus the Click envelope: padding, sealed sender, and blinded names.

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = globalThis.crypto.subtle;
const PKCS8_X25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

export const PAD_BUCKETS = [512, 2048, 8192, 32768];
export const ENVELOPE_OVERHEAD = 113; // version(1) + outer enc(32) + outer tag(16) + sender(16) + inner enc(32) + inner tag(16)
export const ENVELOPE_VERSION = 1;

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fromHex(value) {
  if (!/^(?:[0-9a-f]{2})*$/i.test(value)) throw new Error("bad hex");
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

export function b64u(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromB64u(value) {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("bad base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

function i2osp(value, length) {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return out;
}

async function hmac(key, data) {
  const k = await subtle.importKey("raw", key.length ? key : new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data));
}

async function sha256(data) {
  return new Uint8Array(await subtle.digest("SHA-256", data));
}

async function expand(prk, info, length) {
  let previous = new Uint8Array(0);
  const out = [];
  let total = 0;
  for (let i = 1; total < length; i++) {
    previous = await hmac(prk, concat(previous, info, Uint8Array.of(i)));
    out.push(previous);
    total += previous.length;
  }
  return concat(...out).slice(0, length);
}

const KEM_SUITE = concat(te.encode("KEM"), i2osp(0x20, 2));
const HPKE_SUITE = concat(te.encode("HPKE"), i2osp(0x20, 2), i2osp(1, 2), i2osp(1, 2));
const V1 = te.encode("HPKE-v1");

function labeledExtract(suite, salt, label, ikm) {
  return hmac(salt, concat(V1, suite, te.encode(label), ikm));
}

function labeledExpand(suite, prk, label, info, length) {
  return expand(prk, concat(i2osp(length, 2), V1, suite, te.encode(label), info), length);
}

// ---- X25519 keys ----

export async function importPrivate(raw) {
  return subtle.importKey("pkcs8", concat(PKCS8_X25519, raw), { name: "X25519" }, true, ["deriveBits"]);
}

async function importPublic(raw) {
  return subtle.importKey("raw", raw, { name: "X25519" }, true, []);
}

export async function publicFromPrivate(raw) {
  const key = await importPrivate(raw);
  const jwk = await subtle.exportKey("jwk", key);
  return fromB64u(jwk.x);
}

/** A new key pair as raw 32-byte arrays. */
export async function generateKeyPair() {
  const sk = randomBytes(32);
  return { sk, pk: await publicFromPrivate(sk) };
}

async function dh(skRaw, pkRaw) {
  const params = { name: "X25519", public: await importPublic(pkRaw) };
  const bits = new Uint8Array(await subtle.deriveBits(params, await importPrivate(skRaw), 256));
  if (bits.every((byte) => byte === 0)) throw new Error("bad key");
  return bits;
}

async function extractAndExpand(dhBytes, kemContext) {
  const prk = await labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dhBytes);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", kemContext, 32);
}

async function keySchedule(mode, shared, info) {
  const empty = new Uint8Array(0);
  const pskIdHash = await labeledExtract(HPKE_SUITE, empty, "psk_id_hash", empty);
  const infoHash = await labeledExtract(HPKE_SUITE, empty, "info_hash", info);
  const context = concat(Uint8Array.of(mode), pskIdHash, infoHash);
  const secret = await labeledExtract(HPKE_SUITE, shared, "secret", empty);
  return {
    key: await labeledExpand(HPKE_SUITE, secret, "key", context, 16),
    nonce: await labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12),
  };
}

async function aead(encrypt, key, nonce, aad, data) {
  const k = await subtle.importKey("raw", key, { name: "AES-GCM" }, false, [encrypt ? "encrypt" : "decrypt"]);
  const params = { name: "AES-GCM", iv: nonce, additionalData: aad };
  return new Uint8Array(encrypt ? await subtle.encrypt(params, k, data) : await subtle.decrypt(params, k, data));
}

/**
 * HPKE single-shot seal. Base mode, or auth mode when senderSk is given. ephemeralSk is for test
 * vectors only. Returns { enc, ct }.
 */
export async function hpkeSeal({ pkR, info, aad = new Uint8Array(0), pt, senderSk, ephemeralSk }) {
  const skE = ephemeralSk ?? randomBytes(32);
  const enc = await publicFromPrivate(skE);
  let shared;
  if (senderSk) {
    const pkS = await publicFromPrivate(senderSk);
    shared = await extractAndExpand(concat(await dh(skE, pkR), await dh(senderSk, pkR)), concat(enc, pkR, pkS));
  } else {
    shared = await extractAndExpand(await dh(skE, pkR), concat(enc, pkR));
  }
  const { key, nonce } = await keySchedule(senderSk ? 2 : 0, shared, info);
  return { enc, ct: await aead(true, key, nonce, aad, pt) };
}

/** HPKE single-shot open. Auth mode when pkS is given. */
export async function hpkeOpen({ skR, enc, info, aad = new Uint8Array(0), ct, pkS }) {
  const pkR = await publicFromPrivate(skR);
  let shared;
  if (pkS) {
    shared = await extractAndExpand(concat(await dh(skR, enc), await dh(skR, pkS)), concat(enc, pkR, pkS));
  } else {
    shared = await extractAndExpand(await dh(skR, enc), concat(enc, pkR));
  }
  const { key, nonce } = await keySchedule(pkS ? 2 : 0, shared, info);
  return aead(false, key, nonce, aad, ct);
}

// ---- Click names, fingerprints, padding ----

async function tag(secret, label, value, bytes = 16) {
  return hex((await hmac(secret, te.encode(`${label}|${value}`))).slice(0, bytes));
}

/** A member's blinded mailbox id: only members (who hold the group secret) can tell whose it is. */
export function mailboxOf(group, handle) {
  return tag(group, "click/mailbox/v1", handle.toLowerCase());
}

export function blindTopic(group, topic) {
  return tag(group, "click/topic/v1", topic.toLowerCase());
}

export async function groupFingerprint(group) {
  return hex((await sha256(concat(te.encode("click/group/v1|"), group))).slice(0, 16));
}

/** Key fingerprint, shown grouped for people to compare: "1a2b 3c4d ...". */
export async function fingerprint(pk) {
  return hex((await sha256(concat(te.encode("click/sealed/fp/v1|"), pk))).slice(0, 16));
}

export function groupedFingerprint(fp) {
  return fp.match(/.{4}/g).join(" ");
}

export function pad(bytes) {
  const need = bytes.length + 4;
  const bucket = PAD_BUCKETS.find((size) => size >= need);
  if (!bucket) throw new Error("Message too large for a sealed click.");
  const out = new Uint8Array(bucket);
  out.set(i2osp(bytes.length, 4), 0);
  out.set(bytes, 4);
  return out;
}

export function unpad(bytes) {
  const length = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  if (length > bytes.length - 4) throw new Error("bad padding");
  return bytes.slice(4, 4 + length);
}

/** Valid envelope byte lengths: one per padding bucket. The server accepts only these. */
export function envelopeSizes() {
  return PAD_BUCKETS.map((bucket) => bucket + ENVELOPE_OVERHEAD);
}

function infoFor(layer, clickId, mailbox) {
  return te.encode(`click/sealed/${layer}/v1|${clickId}|${mailbox}`);
}

/**
 * Seal one message for one recipient. The inner layer (HPKE auth mode) proves the sender to the
 * recipient; the outer layer (base mode) hides who sent it from the server.
 */
export async function sealEnvelope({ clickId, recipient, sender, payload }) {
  const body = pad(te.encode(JSON.stringify(payload)));
  const pkR = fromB64u(recipient.public_key);
  const inner = await hpkeSeal({ pkR, info: infoFor("inner", clickId, recipient.mailbox), pt: body, senderSk: sender.sk });
  const outerPt = concat(fromHex(sender.mailbox), inner.enc, inner.ct);
  const outer = await hpkeSeal({ pkR, info: infoFor("outer", clickId, recipient.mailbox), pt: outerPt });
  return b64u(concat(Uint8Array.of(ENVELOPE_VERSION), outer.enc, outer.ct));
}

/**
 * Open an envelope addressed to me. lookup(mailbox) returns the sender's directory entry
 * { public_key }. Returns { payload, senderMailbox }.
 */
export async function openEnvelope({ clickId, me, envelope, lookup }) {
  const bytes = fromB64u(envelope);
  if (bytes[0] !== ENVELOPE_VERSION) throw new Error("unknown envelope version");
  const outer = await hpkeOpen({ skR: me.sk, enc: bytes.slice(1, 33), info: infoFor("outer", clickId, me.mailbox), ct: bytes.slice(33) });
  const senderMailbox = hex(outer.slice(0, 16));
  const sender = await lookup(senderMailbox);
  if (!sender) throw new Error("unknown sender");
  const inner = await hpkeOpen({
    skR: me.sk,
    enc: outer.slice(16, 48),
    info: infoFor("inner", clickId, me.mailbox),
    ct: outer.slice(48),
    pkS: fromB64u(sender.public_key),
  });
  return { payload: JSON.parse(td.decode(unpad(inner))), senderMailbox };
}

/** Invite lines for sealed clicks carry the group secret and the inviter's key fingerprint after '#'. */
export function sealedInviteLine(invite, group, inviterFingerprint) {
  return `${invite}#sealed=${b64u(group)}.${inviterFingerprint}`;
}

export function parseInvite(line) {
  const [invite, fragment = ""] = line.trim().split("#", 2);
  const match = /^sealed=([A-Za-z0-9_-]{43})\.([0-9a-f]{32})$/.exec(fragment);
  return match ? { invite, group: fromB64u(match[1]), inviterFingerprint: match[2] } : { invite, group: null, inviterFingerprint: null };
}
