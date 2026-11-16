import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProxy, type ProxyStore } from "../cli/proxy.mjs";
import { b64u, envelopeSizes, fromB64u, fromHex, hex, hpkeOpen, hpkeSeal, mailboxOf, sealEnvelope } from "../cli/sealed.mjs";
import { getHub, type ClickHub } from "../src/hub";
import { SEALED_SEND_ERROR } from "../src/types";
import { callTool, createClick, handle, initialize, LOCAL } from "./helpers";

function sql<T>(hub: ClickHub, query: string, ...args: unknown[]): T[] {
  return (hub as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(query, ...args).toArray() as T[];
}

function memory(): ProxyStore & { data: Map<string, any> } {
  const data = new Map<string, any>();
  return { data, load: (name) => (data.has(name) ? structuredClone(data.get(name)) : null), save: (name, value) => void data.set(name, structuredClone(value)) };
}

const workerFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("host", new URL(LOCAL).host);
  return SELF.fetch(String(input), { ...init, headers });
}) as typeof fetch;

type Result = { content: Array<{ text: string }>; isError?: boolean };

async function tool(proxy: ReturnType<typeof createProxy>, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = (await proxy.callTool(name, args)) as Result;
  const text = result.content[0]?.text ?? "";
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

async function deliver(clickId: string, mailbox: string, token: string, envelope: string) {
  return SELF.fetch(`${LOCAL}/api/v1/sealed/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-click-delivery": token, host: new URL(LOCAL).host },
    body: JSON.stringify({ click: clickId, mailbox, envelope }),
  });
}

/** A sealed click: the admin (boss) and two members who joined through sealed invites. */
async function sealedClick() {
  const created = await createClick();
  await initialize(LOCAL, created.click_key);
  const boss = handle("boss");
  await callTool(LOCAL, created.click_key, "register", { handle: boss });
  const on = (await callTool(LOCAL, created.click_key, "set_encryption", { encryption: "sealed" })) as { encryption: string };
  expect(on.encryption).toBe("sealed");
  const bossStore = memory();
  const bossProxy = createProxy({ fetch: workerFetch, base: LOCAL, token: created.click_key, store: bossStore });
  const join = async (prefix: string) => {
    const invite = await tool(bossProxy, "create_invite", { max_uses: 1 });
    expect(invite.invite).toContain("#sealed=");
    const store = memory();
    const proxy = createProxy({ fetch: workerFetch, base: LOCAL, store });
    const joined = await tool(proxy, "join_click", { invite: invite.invite });
    expect(joined.sealed).toBe(true);
    const name = handle(prefix);
    await tool(proxy, "register", { handle: name });
    await tool(proxy, "inbox"); // publishes the key and checks the inviter's fingerprint
    return { proxy, store, handle: name };
  };
  const ada = await join("ada");
  const grace = await join("grace");
  return { created, boss, bossProxy, bossStore, ada, grace };
}

describe("Sealed tier", () => {
  it("implements HPKE per the RFC 9180 test vectors (base and auth modes)", async () => {
    const info = fromHex("4f6465206f6e2061204772656369616e2055726e");
    const pt = fromHex("4265617574792069732074727574682c20747275746820626561757479");
    const aad = fromHex("436f756e742d30");
    const base = await hpkeSeal({ pkR: fromHex("3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d"), info, aad, pt, ephemeralSk: fromHex("52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736") });
    expect(hex(base.enc)).toBe("37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431");
    expect(hex(base.ct)).toBe("f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a");
    const auth = await hpkeSeal({
      pkR: fromHex("1632d5c2f71c2b38d0a8fcc359355200caa8b1ffdf28618080466c909cb69b2e"), info, aad, pt,
      ephemeralSk: fromHex("ff4442ef24fbc3c1ff86375b0be1e77e88a0de1e79b30896d73411c5ff4c3518"),
      senderSk: fromHex("dc4a146313cce60a278a5323d321f051c5707e9c45ba21a3479fecdf76fc69dd"),
    });
    expect(hex(auth.ct)).toBe("5fd92cc9d46dbf8943e72a07e42f363ed5f721212cd90bcfd072bfd9f44e06b80fd17824947496e21b680c141b");
    const opened = await hpkeOpen({ skR: fromHex("fdea67cf831f1ca98d8e27b1f6abeb5b7745e9d35348b80fa407ff6958f9137e"), enc: auth.enc, info, aad, ct: auth.ct, pkS: fromHex("8b0c70873dc5aecb7f9ee4e62406a397b350e57012be45cf53b7105ae731790b") });
    expect(hex(opened)).toBe(hex(pt));
  });

  it("delivers end to end through the proxy; Click stores only padded ciphertext with no names", async () => {
    const { created, ada, grace, bossProxy, boss } = await sealedClick();
    const secret = `sealed-secret-${crypto.randomUUID()}`;
    const sent = await tool(ada.proxy, "send", { to: grace.handle, text: secret });
    expect(sent.delivered_to).toEqual([grace.handle]);
    const rows = await runInDurableObject(getHub(env, created.click_id), (hub) => sql<{ mailbox: string; envelope: string }>(hub, "SELECT mailbox, envelope FROM sealed_mail"));
    expect(rows.length).toBe(1);
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(grace.handle);
    expect(raw).not.toContain(ada.handle);
    expect(envelopeSizes()).toContain(fromB64u(rows[0]!.envelope).length);
    const events = await runInDurableObject(getHub(env, created.click_id), (hub) => sql<{ n: number }>(hub, "SELECT COUNT(*) AS n FROM events"));
    expect(events[0]?.n).toBe(0);

    const inbox = await tool(grace.proxy, "inbox");
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({ from: ada.handle, to: grace.handle, text: secret, sealed: true });
    await tool(grace.proxy, "ack", { ids: [inbox.messages[0].id] });
    expect((await tool(grace.proxy, "inbox")).messages).toHaveLength(0);
    expect((await tool(grace.proxy, "history")).events.some((event: { text: string }) => event.text === secret)).toBe(true);

    // Broadcast and blinded topics.
    await tool(bossProxy, "send", { broadcast: true, text: "all hands" });
    expect((await tool(ada.proxy, "inbox")).messages.some((m: { text: string; from: string }) => m.text === "all hands" && m.from === boss)).toBe(true);
    await tool(grace.proxy, "subscribe", { topic: "news" });
    const subs = await runInDurableObject(getHub(env, created.click_id), (hub) => sql<{ topic: string }>(hub, "SELECT topic FROM sealed_subs"));
    expect(subs[0]?.topic).toMatch(/^[0-9a-f]{32}$/);
    expect(subs[0]?.topic).not.toContain("news");
    const posted = await tool(ada.proxy, "send", { topic: "news", text: "topic post" });
    expect(posted.delivered_to).toEqual([grace.handle]);
    expect((await tool(grace.proxy, "inbox")).messages.some((m: { text: string; topic: string }) => m.text === "topic post" && m.topic === "news")).toBe(true);
  });

  it("refuses hosted sends, bad delivery tokens, unpadded envelopes, and forged senders", async () => {
    const { created, ada, grace } = await sealedClick();
    await expect(callTool(LOCAL, created.click_key, "send", { to: grace.handle, text: "hosted" })).rejects.toThrow(SEALED_SEND_ERROR.slice(0, 40));
    const dir = await runInDurableObject(getHub(env, created.click_id), (hub) => sql<{ mailbox: string; public_key: string; delivery_token: string }>(hub, "SELECT mailbox, public_key, delivery_token FROM sealed_keys"));
    const adaState = [...ada.store.data.entries()].find(([name]) => name.startsWith("sealed-"))![1];
    const group = fromB64u(adaState.group);
    const graceBox = await mailboxOf(group, grace.handle);
    const graceEntry = dir.find((row) => row.mailbox === graceBox)!;
    const adaBox = await mailboxOf(group, ada.handle);
    const forged = await sealEnvelope({ clickId: created.click_id, recipient: graceEntry, sender: { sk: fromB64u(adaState.sk), mailbox: adaBox }, payload: { v: 1, id: crypto.randomUUID(), from: "someone-else", to: grace.handle, text: "forged", sent_at: Date.now() } });
    expect((await deliver(created.click_id, graceBox, b64u(new Uint8Array(32)), forged)).status).toBe(400);
    expect((await deliver(created.click_id, graceBox, graceEntry.delivery_token, "AAAA")).status).toBe(400);
    expect((await deliver(created.click_id, graceBox, graceEntry.delivery_token, forged)).status).toBe(201);
    const got = await tool(grace.proxy, "inbox");
    expect(got.messages[0]).toMatchObject({ decrypt_error: "cannot decrypt" });
  });

  it("detects a substituted key, and trust_key accepts it after checking", async () => {
    const { created, ada, grace } = await sealedClick();
    await tool(ada.proxy, "inbox"); // ada first sees (and pins) grace's real key
    const graceState = [...grace.store.data.entries()].find(([name]) => name.startsWith("sealed-"))![1];
    const box = await mailboxOf(fromB64u(graceState.group), grace.handle);
    const other = b64u(new Uint8Array(32).fill(9));
    await runInDurableObject(getHub(env, created.click_id), (hub) => sql(hub, "UPDATE sealed_keys SET public_key = ? WHERE mailbox = ?", other, box));
    await expect(tool(ada.proxy, "send", { to: grace.handle, text: "x" })).rejects.toThrow(/changed/);
    const status = await tool(ada.proxy, "sealed_status");
    expect(status.members.find((m: { handle: string }) => m.handle === grace.handle).key_changed).toBe(true);
    await tool(ada.proxy, "trust_key", { handle: grace.handle });
    expect(status.my_fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){7}$/);
  });

  it("rejects an invite line whose inviter fingerprint does not match", async () => {
    const { bossProxy } = await sealedClick();
    const invite = await tool(bossProxy, "create_invite", { max_uses: 1 });
    const tampered = invite.invite.replace(/\.[0-9a-f]{32}$/, `.${"0".repeat(32)}`);
    const proxy = createProxy({ fetch: workerFetch, base: LOCAL, store: memory() });
    await tool(proxy, "join_click", { invite: tampered });
    await tool(proxy, "register", { handle: handle("eve") });
    await expect(tool(proxy, "inbox")).rejects.toThrow(/fingerprint/);
  });

  it("removal drops the member's mailbox and voids delivery tokens until proxies republish", async () => {
    const { created, ada, grace, bossProxy } = await sealedClick();
    await callTool(LOCAL, created.click_key, "remove_member", { handle: ada.handle });
    const keys = await runInDurableObject(getHub(env, created.click_id), (hub) => sql<{ delivery_token: string | null }>(hub, "SELECT delivery_token FROM sealed_keys"));
    expect(keys).toHaveLength(2);
    expect(keys.every((row) => row.delivery_token === null)).toBe(true);
    await expect(tool(ada.proxy, "inbox")).rejects.toThrow();
    const first = await tool(bossProxy, "send", { to: grace.handle, text: "after removal" });
    expect(first.not_delivered).toEqual([grace.handle]);
    await tool(grace.proxy, "inbox"); // grace's proxy republishes a fresh token
    const second = await tool(bossProxy, "send", { to: grace.handle, text: "after removal" });
    expect(second.delivered_to).toEqual([grace.handle]);
    expect((await tool(grace.proxy, "inbox")).messages.some((m: { text: string }) => m.text === "after removal")).toBe(true);
  });

  it("a member without the group secret cannot set up, and standard clicks pass straight through", async () => {
    const { created } = await sealedClick();
    const minted = (await callTool(LOCAL, created.click_key, "mint_token", { handle: handle("plain") })) as { token: string };
    const proxy = createProxy({ fetch: workerFetch, base: LOCAL, token: minted.token, store: memory() });
    await expect(tool(proxy, "inbox")).rejects.toThrow(/group secret/);

    const standard = await createClick();
    await initialize(LOCAL, standard.click_key);
    await callTool(LOCAL, standard.click_key, "register", { handle: handle("std") });
    const ada = (await callTool(LOCAL, standard.click_key, "mint_token", { handle: handle("ada") })) as { token: string; handle: string };
    const through = createProxy({ fetch: workerFetch, base: LOCAL, token: standard.click_key, store: memory() });
    const listed = await through.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["send", "inbox", "sealed_status"]));
    const sent = await tool(through, "send", { to: ada.handle, text: "plain via proxy" });
    expect(sent.sealed).toBeUndefined();
    expect((await callTool(LOCAL, ada.token, "inbox") as { messages: Array<{ text: string }> }).messages.some((m) => m.text === "plain via proxy")).toBe(true);
  });
});
