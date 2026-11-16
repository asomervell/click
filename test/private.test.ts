import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getHub, type ClickHub } from "../src/hub";
import { LOCKED_TEXT } from "../src/private";
import { api, callTool, createClick, handle, initialize, LOCAL, lastCode, signIn, startCreate, testEmail } from "./helpers";

type Message = { text: string; encrypted?: boolean; decrypt_error?: string; from?: string };

function sql<T>(hub: ClickHub, query: string, ...args: unknown[]): T[] {
  return (hub as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(query, ...args).toArray() as T[];
}

async function stored(clickId: string): Promise<Array<{ id: string; body: string; enc: number; key_epoch: number | null; body_ct: string | null }>> {
  return runInDurableObject(getHub(env, clickId), (hub) => sql(hub, "SELECT id, text AS body, enc, key_epoch, body_ct FROM events"));
}

async function member(clickKey: string, prefix: string): Promise<{ token: string; handle: string }> {
  const name = handle(prefix);
  const minted = (await callTool(LOCAL, clickKey, "mint_token", { handle: name })) as { token: string };
  await initialize(LOCAL, minted.token);
  return { token: minted.token, handle: name };
}

async function inbox(token: string): Promise<Message[]> {
  return ((await callTool(LOCAL, token, "inbox")) as { messages: Message[] }).messages;
}

async function history(token: string): Promise<Message[]> {
  return ((await callTool(LOCAL, token, "history", { limit: 50 })) as { events: Message[] }).events;
}

/** A click with an admin (the admin key bearer) and two minted members. */
async function privateClick() {
  const created = await createClick();
  await initialize(LOCAL, created.click_key);
  const boss = handle("boss");
  await callTool(LOCAL, created.click_key, "register", { handle: boss });
  const ada = await member(created.click_key, "ada");
  const grace = await member(created.click_key, "grace");
  const on = (await callTool(LOCAL, created.click_key, "set_encryption", { encryption: "private" })) as { encryption: string; key_epoch: number };
  expect(on).toMatchObject({ encryption: "private", key_epoch: 1 });
  return { created, ada, grace, boss };
}

describe("Private tier", () => {
  it("stores only ciphertext and members read plaintext", async () => {
    const { created, ada, grace } = await privateClick();
    const secret = `private-secret-${crypto.randomUUID()}`;
    await callTool(LOCAL, ada.token, "send", { to: grace.handle, text: secret });
    const rows = await stored(created.click_id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.body).not.toContain(secret);
      expect(row.body_ct ?? "").not.toContain(secret);
    }
    expect(rows.some((row) => row.enc === 1 && row.key_epoch === 1)).toBe(true);
    const got = await inbox(grace.token);
    expect(got.find((message) => message.text === secret)).toMatchObject({ encrypted: true });
    const who = (await callTool(LOCAL, grace.token, "whoami")) as { encryption: string };
    expect(who.encryption).toBe("private");
    // HTTP API reads and sends too.
    const viaApi = await api(LOCAL, grace.token, "/api/v1/inbox");
    expect(JSON.stringify(viaApi.body)).toContain(secret);
    const sent = await api(LOCAL, grace.token, "/api/v1/messages", { method: "POST", body: { to: ada.handle, text: "over http" } });
    expect(sent.status).toBeLessThan(300);
    expect((await inbox(ada.token)).some((message) => message.text === "over http")).toBe(true);
    for (const row of await stored(created.click_id)) expect(row.body).not.toContain("over http");
  });

  it("encrypts existing plaintext when turned on, and keeps reading it after turning off", async () => {
    const created = await createClick();
    await initialize(LOCAL, created.click_key);
    await callTool(LOCAL, created.click_key, "register", { handle: handle("boss") });
    const ada = await member(created.click_key, "ada");
    const grace = await member(created.click_key, "grace");
    await callTool(LOCAL, ada.token, "send", { to: grace.handle, text: "old plain words" });
    const on = (await callTool(LOCAL, created.click_key, "set_encryption", { encryption: "private" })) as { encrypted_existing: number; plaintext_left: number };
    expect(on.encrypted_existing).toBeGreaterThan(0);
    expect(on.plaintext_left).toBe(0);
    for (const row of await stored(created.click_id)) expect(row.body).not.toContain("old plain words");
    expect((await inbox(grace.token)).some((message) => message.text === "old plain words")).toBe(true);

    const off = (await callTool(LOCAL, created.click_key, "set_encryption", { encryption: "standard" })) as { encryption: string };
    expect(off.encryption).toBe("standard");
    await callTool(LOCAL, ada.token, "send", { to: grace.handle, text: "new plain words" });
    const rows = await stored(created.click_id);
    expect(rows.some((row) => row.body.includes("new plain words") && row.enc === 0)).toBe(true);
    const texts = (await inbox(grace.token)).map((message) => message.text);
    expect(texts).toContain("old plain words");
    expect(texts).toContain("new plain words");
  });

  it("refuses plaintext sends from a client that cannot encrypt, and only admins can switch modes", async () => {
    const { created, ada } = await privateClick();
    await expect(callTool(LOCAL, ada.token, "set_encryption", { encryption: "standard" })).rejects.toThrow(/admin/i);
    const principal = await runInDurableObject(getHub(env, created.click_id), (hub) => sql<{ principal_id: string }>(hub, "SELECT principal_id FROM agents WHERE handle = ?", ada.handle));
    await expect(runInDurableObject(getHub(env, created.click_id), (hub) => hub.send({ principalId: principal[0]!.principal_id, clickId: created.click_id, role: "member" }, { text: "plain", to: ada.handle }))).rejects.toThrow(/private/i);
  });

  it("hands the key to invite joiners, minted tokens, and members approved by an admin", async () => {
    const { created } = await privateClick();
    // Invite (no account): the joiner reads at once.
    const invite = (await callTool(LOCAL, created.click_key, "create_invite", {})) as { invite: string };
    const joined = (await api(LOCAL, "", "/api/v1/clicks/join", { method: "POST", body: { invite: invite.invite } })).body as { token: string };
    expect(typeof joined.token).toBe("string");
    await initialize(LOCAL, joined.token);
    const newbie = handle("newbie");
    await callTool(LOCAL, joined.token, "register", { handle: newbie });
    await callTool(LOCAL, created.click_key, "send", { to: newbie, text: "welcome aboard" });
    expect((await inbox(joined.token)).find((message) => message.text === "welcome aboard")?.decrypt_error).toBeUndefined();

    // Standalone agent: request_join, then the admin approves and hands over the key.
    const agentHandle = handle("solo");
    const solo = await signIn(LOCAL, { agentHandle });
    await initialize(LOCAL, solo);
    const soloHandle = agentHandle;
    await callTool(LOCAL, solo, "request_join", { click: created.click_id });
    await callTool(LOCAL, created.click_key, "approve_join", { handle: soloHandle });
    await callTool(LOCAL, created.click_key, "send", { to: soloHandle, text: "approved and keyed" });
    const soloInbox = await inbox(solo);
    expect(soloInbox.find((message) => message.text === "approved and keyed")).toBeTruthy();
  });

  it("shares the key with a member that lacks it on another member's next action", async () => {
    const { created, ada, grace } = await privateClick();
    await callTool(LOCAL, ada.token, "send", { to: grace.handle, text: "shared later" });
    // Drop grace's slot, as if her connection were new.
    const hub = getHub(env, created.click_id);
    await runInDurableObject(hub, (instance) => sql(instance, "DELETE FROM key_slots WHERE key_id IN (SELECT key_id FROM member_keys WHERE principal_id IN (SELECT principal_id FROM agents WHERE handle = ?))", grace.handle));
    const locked = (await inbox(grace.token)).find((message) => message.encrypted);
    expect(locked?.text).toBe(LOCKED_TEXT);
    expect(locked?.decrypt_error).toMatch(/cannot decrypt/);
    await expect(callTool(LOCAL, grace.token, "send", { to: ada.handle, text: "x" })).rejects.toThrow(/key/);
    await inbox(ada.token); // ada's touch shares the key
    expect((await inbox(grace.token)).some((message) => message.text === "shared later")).toBe(true);
  });

  it("shows cannot decrypt for damaged ciphertext", async () => {
    const { created, ada, grace } = await privateClick();
    await callTool(LOCAL, ada.token, "send", { to: grace.handle, text: "will be damaged" });
    const hub = getHub(env, created.click_id);
    await runInDurableObject(hub, (instance) => sql(instance, "UPDATE events SET body_ct = substr(body_ct, 1, length(body_ct) - 4) || 'AAAA' WHERE enc = 1"));
    const got = (await inbox(grace.token)).find((message) => message.encrypted);
    expect(got?.text).toBe(LOCKED_TEXT);
    expect(got?.decrypt_error).toMatch(/cannot decrypt/);
  });

  it("rotates the key when a member is removed, and history stays readable", async () => {
    const { created, ada, grace } = await privateClick();
    await callTool(LOCAL, ada.token, "send", { to: grace.handle, text: "before removal" });
    await callTool(LOCAL, created.click_key, "remove_member", { handle: ada.handle });
    const epochs = await runInDurableObject(getHub(env, created.click_id), (hub) => sql<{ enc_epoch: number }>(hub, "SELECT enc_epoch FROM click_meta"));
    expect(epochs[0]?.enc_epoch).toBe(2);
    await callTool(LOCAL, created.click_key, "send", { to: grace.handle, text: "after removal" });
    const texts = (await history(grace.token)).map((message) => message.text);
    expect(texts).toContain("before removal");
    expect(texts).toContain("after removal");
    // The removed member's keys and slots are gone.
    const left = await runInDurableObject(getHub(env, created.click_id), (hub) => sql<{ n: number }>(hub, "SELECT COUNT(*) AS n FROM key_slots s JOIN member_keys k ON k.key_id = s.key_id JOIN principals p ON p.id = k.principal_id WHERE p.removed_at IS NOT NULL"));
    expect(left[0]?.n).toBe(0);
  });

  it("gives a rotated admin key its recovery copy at once, and admin-key sign-in unlocks", async () => {
    const { created, ada, grace, boss } = await privateClick();
    await callTool(LOCAL, ada.token, "send", { to: boss, text: "recover me" });
    const rotated = (await callTool(LOCAL, created.click_key, "rotate_key")) as { click_key: string };
    await initialize(LOCAL, rotated.click_key);
    expect((await history(rotated.click_key)).some((message) => message.text === "recover me")).toBe(true);
    // OAuth sign-in with the admin key: the new grant gets the key.
    const grant = await signIn(LOCAL, { key: rotated.click_key });
    await initialize(LOCAL, grant);
    expect((await history(grant)).some((message) => message.text === "recover me")).toBe(true);
    await callTool(LOCAL, grant, "send", { to: grace.handle, text: "from the new grant" });
    expect((await inbox(grace.token)).some((message) => message.text === "from the new grant")).toBe(true);
  });

  it("start_fresh deletes encrypted messages and installs a new key", async () => {
    const { created, ada, grace } = await privateClick();
    await callTool(LOCAL, ada.token, "send", { to: grace.handle, text: "lost forever" });
    const fresh = (await callTool(LOCAL, created.click_key, "start_fresh", { confirm: true })) as { deleted_messages: number; key_epoch: number };
    expect(fresh.deleted_messages).toBeGreaterThan(0);
    expect(fresh.key_epoch).toBe(2);
    expect((await history(grace.token)).some((message) => message.text === "lost forever")).toBe(false);
    await callTool(LOCAL, ada.token, "send", { to: grace.handle, text: "fresh start" });
    expect((await inbox(grace.token)).some((message) => message.text === "fresh start")).toBe(true);
  });

  it("can be chosen at create, and the first invite carries the key", async () => {
    const email = testEmail();
    const started = await startCreate(LOCAL, email);
    const response = await fetchVerify(started.body.pending_id as string, lastCode(email));
    expect(response.encryption).toBe("private");
    await initialize(LOCAL, response.click_key);
    const boss = handle("boss");
    await callTool(LOCAL, response.click_key, "register", { handle: boss });
    const who = (await callTool(LOCAL, response.click_key, "whoami")) as { encryption: string };
    expect(who.encryption).toBe("private");
    const invite = (await api(LOCAL, "", "/api/v1/clicks/join", { method: "POST", body: { invite: response.first_invite.invite } })).body as { token: string };
    await initialize(LOCAL, invite.token);
    const first = handle("first");
    await callTool(LOCAL, invite.token, "register", { handle: first });
    await callTool(LOCAL, response.click_key, "send", { to: first, text: "first invite keyed" });
    expect((await inbox(invite.token)).some((message) => message.text === "first invite keyed")).toBe(true);
    // The sign-in page checkbox: the creating grant holds the key.
    const grant = await signIn(LOCAL, { email: testEmail(), encryption: true });
    await initialize(LOCAL, grant);
    await callTool(LOCAL, grant, "register", { handle: handle("oauth") });
    expect(((await callTool(LOCAL, grant, "whoami")) as { encryption: string }).encryption).toBe("private");
    await callTool(LOCAL, grant, "send", { broadcast: true, text: "oauth private" });
    expect((await history(grant)).some((message) => message.text === "oauth private" && message.encrypted)).toBe(true);
    // Standard is still the default.
    const plain = await createClick();
    await initialize(LOCAL, plain.click_key);
    await callTool(LOCAL, plain.click_key, "register", { handle: handle("plain") });
    expect(((await callTool(LOCAL, plain.click_key, "whoami")) as { encryption: string }).encryption).toBe("standard");
  });

  it("leaves standard clicks unchanged", async () => {
    const created = await createClick();
    await initialize(LOCAL, created.click_key);
    const ada = await member(created.click_key, "ada");
    const grace = await member(created.click_key, "grace");
    await callTool(LOCAL, ada.token, "send", { to: grace.handle, text: "plain as before" });
    const rows = await stored(created.click_id);
    expect(rows.some((row) => row.body.includes("plain as before") && row.enc === 0)).toBe(true);
    const got = (await inbox(grace.token)).find((message) => message.text === "plain as before");
    expect(got?.encrypted).toBeUndefined();
    const slots = await runInDurableObject(getHub(env, created.click_id), (hub) => sql<{ n: number }>(hub, "SELECT COUNT(*) AS n FROM key_slots"));
    expect(slots[0]?.n).toBe(0);
  });
});

async function fetchVerify(pendingId: string, code: string): Promise<{ encryption: string; click_key: string; first_invite: { invite: string } }> {
  const { SELF } = await import("cloudflare:test");
  const response = await SELF.fetch(`${LOCAL}/api/v1/clicks/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", host: new URL(LOCAL).host },
    body: JSON.stringify({ pending_id: pendingId, code, encryption: "private" }),
  });
  return await response.json() as { encryption: string; click_key: string; first_invite: { invite: string } };
}
