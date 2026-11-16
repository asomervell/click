/**
 * Private clicks, Worker side. Members' credentials carry an X25519 key (from OAuth grant
 * props, or derived from a bearer token on each request). The click key is wrapped to each
 * member's public key; this module unwraps it for one request, encrypts and decrypts bodies,
 * shares the key with members who lack it, rotates it after removals, and encrypts old
 * plaintext in batches. The hub only ever stores ciphertext and wrapped keys.
 */
import { getHub, type KeyState, type PublicKeyInput } from "./hub";
import {
  credFromSecret,
  type CredKey,
  messageAad,
  open,
  openText,
  randomBytes,
  seal,
  sealText,
  unwrapWithCred,
  unwrapWithSecret,
  wrapToPub,
  wrapToSecret,
} from "./enc";
import { sha256Hex } from "./crypto";
import { ClickError, PRIVATE_SEND_ERROR, type ClickProps } from "./types";
import { requireText } from "./validate";

export const LOCKED_TEXT = "[Encrypted. This connection has no key for this private click yet. Another member's next action shares it; try again shortly. If this keeps happening, reconnect Click.]";
const INVITE_LABEL = "click/invite/v1";
const MIGRATE_BATCH = 200;

export type Keyring = { epoch: number; current: Uint8Array; byEpoch: Map<number, Uint8Array> };

export function publicKeyOf(cred: CredKey | undefined | null): PublicKeyInput | null {
  return cred ? { id: cred.id, pub: cred.pub, kind: cred.kind } : null;
}

function chainAad(clickId: string, epoch: number): string {
  return `click/chain/v1|${clickId}|${epoch}`;
}

// Per-isolate memo of which clicks are private, so standard clicks pay nothing on send.
const modes = new Map<string, { mode: "standard" | "private"; at: number }>();
const MODE_TTL_MS = 10_000;

export function forgetMode(clickId: string): void {
  modes.delete(clickId);
}

async function clickMode(env: Env, clickId: string): Promise<"standard" | "private"> {
  const hit = modes.get(clickId);
  if (hit && Date.now() - hit.at < MODE_TTL_MS) return hit.mode;
  const { mode } = await getHub(env, clickId).encMode();
  if (modes.size > 1000) modes.clear();
  modes.set(clickId, { mode, at: Date.now() });
  return mode;
}

async function ringFrom(clickId: string, state: KeyState, cred: CredKey): Promise<Keyring | null> {
  if (!state.slot || state.epoch === 0) return null;
  const current = await unwrapWithCred(state.slot, cred);
  const byEpoch = new Map<number, Uint8Array>([[state.epoch, current]]);
  for (const entry of state.chain) {
    try {
      byEpoch.set(entry.epoch, await open(current, entry.wrapped, chainAad(clickId, entry.epoch)));
    } catch {
      // A damaged chain entry only hides that epoch's messages.
    }
  }
  return { epoch: state.epoch, current, byEpoch };
}

/**
 * Unlock this click for the credential and do any key upkeep it can: rotate after a removal,
 * share the key with members who lack it, and encrypt a batch of old plaintext.
 */
export async function unlock(env: Env, props: ClickProps, cred: CredKey | undefined | null): Promise<{ state: KeyState | null; ring: Keyring | null }> {
  if (!cred) return { state: null, ring: null };
  const hub = getHub(env, props.clickId);
  const state = await hub.keyState(props, publicKeyOf(cred));
  let ring = await ringFrom(props.clickId, state, cred).catch(() => null);
  if (!ring) return { state, ring: null };
  if (state.rotate) {
    ring = await rotate(env, props, cred, ring, state.keys);
  } else {
    const missing = state.keys.filter((key) => !key.slotted);
    if (missing.length > 0) {
      const slots = await Promise.all(missing.map(async (key) => ({ key_id: key.key_id, wrapped: await wrapToPub(ring!.current, key.public_key) })));
      await hub.shareKeys(props, { key_id: cred.id, epoch: ring.epoch, slots });
    }
  }
  if (state.mode === "private" && state.plaintext > 0) await migrateBatch(env, props, cred, ring, MIGRATE_BATCH);
  return { state, ring };
}

async function rotate(env: Env, props: ClickProps, cred: CredKey, ring: Keyring, keys: KeyState["keys"]): Promise<Keyring> {
  const next = randomBytes(32);
  const epoch = ring.epoch + 1;
  const chain = await Promise.all([...ring.byEpoch.entries()].map(async ([old, key]) => ({ epoch: old, wrapped: await seal(next, key, chainAad(props.clickId, old)) })));
  const slots = await Promise.all(keys.map(async (key) => ({ key_id: key.key_id, wrapped: await wrapToPub(next, key.public_key) })));
  try {
    await getHub(env, props.clickId).newEpoch(props, { key_id: cred.id, epoch, slots, chain });
  } catch {
    return ring; // Someone else rotated first; the old ring still reads everything up to now.
  }
  const byEpoch = new Map(ring.byEpoch);
  byEpoch.set(epoch, next);
  return { epoch, current: next, byEpoch };
}

async function migrateBatch(env: Env, props: ClickProps, cred: CredKey, ring: Keyring, limit: number): Promise<number> {
  const hub = getHub(env, props.clickId);
  const rows = await hub.plaintextBatch(props, limit);
  if (rows.length === 0) return 0;
  const sealed = await Promise.all(rows.map(async (row) => ({ id: row.id, ct: await sealText(ring.current, row.text, messageAad(props.clickId, row.id, row.created_at)) })));
  const { replaced } = await hub.replaceWithCiphertext(props, { key_id: cred.id, epoch: ring.epoch, rows: sealed });
  return replaced;
}

type Openable = { text: string; created_at: number; sealed?: { epoch: number; ct: string }; event_id?: string; id: string };

/** Decrypt the sealed messages of one click's page. Untouched when nothing is sealed. */
export async function openPage<T extends Openable>(env: Env, props: ClickProps, cred: CredKey | undefined | null, rows: T[], idOf: (row: T) => string): Promise<Array<Omit<T, "sealed"> & { encrypted?: boolean; decrypt_error?: string }>> {
  if (!rows.some((row) => row.sealed)) {
    // Nothing to decrypt, but in a private click any member action shares the key with members who lack it.
    if (cred && (await clickMode(env, props.clickId)) === "private") await unlock(env, props, cred).catch(() => undefined);
    return rows.map(strip);
  }
  const { ring } = await unlock(env, props, cred).catch(() => ({ ring: null as Keyring | null }));
  return Promise.all(rows.map(async (row) => {
    if (!row.sealed) return strip(row);
    const key = ring?.byEpoch.get(row.sealed.epoch);
    if (key) {
      try {
        const text = await openText(key, row.sealed.ct, messageAad(props.clickId, idOf(row), row.created_at));
        return { ...strip(row), text, encrypted: true };
      } catch {
        // fall through
      }
    }
    return { ...strip(row), text: LOCKED_TEXT, encrypted: true, decrypt_error: cred ? "cannot decrypt" : "cannot decrypt: this connection has no key; reconnect Click" };
  }));
}

function strip<T extends { sealed?: unknown }>(row: T): Omit<T, "sealed"> {
  const { sealed: _sealed, ...rest } = row;
  return rest;
}

type SendBody = { text: string; to?: string; topic?: string; broadcast?: boolean; reply_to?: string };

/** Send, encrypting first when the click is private. */
export async function sendMessage(env: Env, props: ClickProps, cred: CredKey | undefined | null, body: SendBody) {
  const hub = getHub(env, props.clickId);
  const encrypted = async () => {
    const { ring } = await unlock(env, props, cred);
    if (!ring) {
      throw new ClickError(cred
        ? "This click is private and this connection does not have its key yet. Another member's next action shares it; try again in a moment."
        : "This click is private and this connection has no key. Reconnect Click (sign in again) to get one.");
    }
    const text = requireText(body.text);
    const eventId = crypto.randomUUID();
    const createdAt = Date.now();
    const ct = await sealText(ring.current, text, messageAad(props.clickId, eventId, createdAt));
    return hub.send(props, { ...body, text: "", sealed: { epoch: ring.epoch, ct, event_id: eventId, created_at: createdAt } }, publicKeyOf(cred));
  };
  if ((await clickMode(env, props.clickId)) === "private") return encrypted();
  try {
    return await hub.send(props, body, publicKeyOf(cred));
  } catch (error) {
    if (!(error instanceof Error) || error.message !== PRIVATE_SEND_ERROR) throw error;
    modes.set(props.clickId, { mode: "private", at: Date.now() });
    return encrypted();
  }
}

/** Admin: turn encryption on for this click, encrypting existing messages. */
export async function enablePrivate(env: Env, props: ClickProps, cred: CredKey | undefined | null, extra: CredKey[] = []): Promise<{ encryption: "private"; key_epoch: number; encrypted_existing: number; plaintext_left: number }> {
  if (props.role !== "admin" && props.role !== "operator") throw new ClickError("Only a click admin can do that.");
  if (!cred) throw new ClickError("This connection has no key, so it cannot turn on encryption. Reconnect Click (sign in again), then try again.");
  const hub = getHub(env, props.clickId);
  for (const key of extra) await hub.registerKeyFor(props.principalId, publicKeyOf(key)!);
  const before = await hub.plaintextCount();
  const state = await hub.keyState(props, publicKeyOf(cred));
  if (state.epoch === 0) {
    const dek = randomBytes(32);
    const keys = await hub.memberKeys(props, publicKeyOf(cred));
    const slots = await Promise.all(keys.map(async (key) => ({ key_id: key.key_id, wrapped: await wrapToPub(dek, key.public_key) })));
    await hub.newEpoch(props, { key_id: cred.id, epoch: 1, slots, chain: [], mode: "private" });
  } else {
    if (!state.slot) throw new ClickError("This click already has a key, but this connection does not hold it yet. Ask another member to act in the click first, or use start_fresh.");
    await hub.setEncMode(props, "private");
  }
  forgetMode(props.clickId);
  // Each unlock encrypts one batch of old plaintext; the rest goes on later member actions.
  for (let i = 0; i < 20; i++) {
    const { ring } = await unlock(env, props, cred);
    if (!ring || (await hub.plaintextCount()) === 0) break;
  }
  const info = await hub.encryptionInfo();
  return { encryption: "private", key_epoch: info.key_epoch, encrypted_existing: Math.max(0, before - info.plaintext_left), plaintext_left: info.plaintext_left };
}

export async function disablePrivate(env: Env, props: ClickProps): Promise<{ encryption: "standard"; note: string }> {
  await getHub(env, props.clickId).setEncMode(props, "standard");
  forgetMode(props.clickId);
  return { encryption: "standard", note: "New messages are stored unencrypted again. Messages already encrypted stay encrypted and readable by members." };
}

/** Admin: discard encrypted history and install a new key for every member Click knows a key for. */
export async function startFresh(env: Env, props: ClickProps, cred: CredKey | undefined | null): Promise<{ deleted_messages: number; key_epoch: number; note: string }> {
  if (props.role !== "admin" && props.role !== "operator") throw new ClickError("Only a click admin can do that.");
  if (!cred) throw new ClickError("This connection has no key. Reconnect Click (sign in again), then try again.");
  const hub = getHub(env, props.clickId);
  const state = await hub.keyState(props, publicKeyOf(cred));
  const keys = await hub.memberKeys(props, publicKeyOf(cred));
  const dek = randomBytes(32);
  const slots = await Promise.all(keys.map(async (key) => ({ key_id: key.key_id, wrapped: await wrapToPub(dek, key.public_key) })));
  const result = await hub.startFresh(props, { epoch: state.epoch + 1, slots });
  forgetMode(props.clickId);
  return { deleted_messages: result.deleted_messages, key_epoch: result.epoch, note: "Encrypted history was deleted and a new key installed. New messages are encrypted." };
}

/** After create_invite in a private click: wrap the key under the invite so its joiners get it at once. */
export async function attachInviteKey(env: Env, props: ClickProps, cred: CredKey | undefined | null, inviteId: string, invite: string): Promise<void> {
  if (!cred || (await clickMode(env, props.clickId)) !== "private") return;
  const { ring } = await unlock(env, props, cred);
  if (!ring) return;
  await getHub(env, props.clickId).setInviteKey(props, inviteId, { key_id: cred.id, epoch: ring.epoch, wrapped: await wrapToSecret(ring.current, invite, INVITE_LABEL) });
}

/** A new member joined with an invite: register its key and, if the invite carries the click key, give it a slot. */
export async function inviteHandoff(env: Env, clickId: string, principalId: string, invite: string, cred: CredKey | undefined | null): Promise<void> {
  if (!cred) return;
  const hub = getHub(env, clickId);
  await hub.registerKeyFor(principalId, publicKeyOf(cred)!);
  const wrapped = await hub.inviteKey(await sha256Hex(invite.trim()));
  if (!wrapped) return;
  try {
    const dek = await unwrapWithSecret(wrapped.wrapped, invite.trim(), INVITE_LABEL);
    await hub.shareKeysAsInvite(principalId, { epoch: wrapped.epoch, key_id: cred.id, wrapped: await wrapToPub(dek, cred.pub) }, await sha256Hex(invite.trim()));
  } catch {
    // The invite key is stale or damaged; a member's next action shares the key instead.
  }
}

/**
 * Give keys to another principal (approve_join, add_member, mint_token, admin-key sign-in):
 * register its public keys and, if the acting credential can unlock the click, wrap the key to them now.
 */
export async function handKeys(env: Env, actor: ClickProps, actorCred: CredKey | undefined | null, principalId: string, keys: CredKey[] | PublicKeyInput[]): Promise<void> {
  const hub = getHub(env, actor.clickId);
  const pubs = keys.map((key) => ("priv" in key ? publicKeyOf(key as CredKey)! : key as PublicKeyInput));
  let any = false;
  for (const key of pubs) any = (await hub.registerKeyFor(principalId, key)) || any;
  if (!any || !actorCred) return;
  // Unlocking shares the click key with every registered key that lacks it, these included.
  await unlock(env, actor, actorCred);
}

/** Admin-key sign-in: unlock with the admin key's recovery copy and pass the key to the new connection. */
export async function adminKeyHandoff(env: Env, props: ClickProps, adminKey: string, cred: CredKey | undefined | null): Promise<void> {
  const hub = getHub(env, props.clickId);
  const admin = await credFromSecret(adminKey, "admin");
  if (cred) await hub.registerKeyFor(props.principalId, publicKeyOf(cred)!);
  // Unlocking as the admin key registers it (the recovery copy) and shares the key with every key that lacks one.
  await unlock(env, props, admin);
}

/** rotate_key: drop the old admin key's recovery copy and give the new admin key one at once. */
export async function rotateAdminKeyCopy(env: Env, props: ClickProps, cred: CredKey | undefined | null, newKey: string): Promise<void> {
  const hub = getHub(env, props.clickId);
  const admin = await credFromSecret(newKey, "admin");
  const { ring } = await unlock(env, props, cred);
  const slot = ring ? { epoch: ring.epoch, wrapped: await wrapToPub(ring.current, admin.pub) } : null;
  await hub.replaceAdminKey(props, publicKeyOf(admin)!, slot);
}

/** A click created with encryption on: key it for the creator and the admin key, and give the first invite the key. */
export async function makePrivateAtCreate(env: Env, created: { click_id: string; principal_id: string; click_key: string; first_invite: { id: string; invite: string } }, cred: CredKey | undefined | null): Promise<{ encryption: "private"; key_epoch: number }> {
  const props: ClickProps = { principalId: created.principal_id, clickId: created.click_id, role: "admin" };
  const admin = await credFromSecret(created.click_key, "admin");
  const actor = cred ?? admin;
  const result = await enablePrivate(env, props, actor, cred ? [admin] : []);
  await attachInviteKey(env, props, actor, created.first_invite.id, created.first_invite.invite);
  return { encryption: "private", key_epoch: result.key_epoch };
}

export function wantsPrivate(value: unknown): boolean {
  if (value == null || value === "" || value === false) return false;
  if (value === true || value === "private" || value === "on" || value === "true") return true;
  if (value === "standard") return false;
  throw new ClickError("encryption must be \"private\" or \"standard\".");
}
