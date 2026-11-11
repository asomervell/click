import { describe, expect, it } from "vitest";
import { api, callTool, createClick, handle, initialize, LOCAL, mcpCall } from "./helpers";

type Problem = { detail: string; code: string };
type Message = { id: string; event_id: string; text: string; from: string; click: string; click_name: string | null; reply_to: string | null };
type Inbox = { click?: string; click_name?: string | null; messages: Message[]; next_cursor: string | null };

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function mint(adminKey: string, name: string): Promise<{ token: string; handle: string }> {
  const h = handle(name);
  const body = (await api(LOCAL, adminKey, "/api/v1/tokens", { method: "POST", body: { handle: h } })).body as { token: string };
  return { token: body.token, handle: h };
}

/** Ada is in Alpha and Beta, with bob in Alpha and carol in Beta. */
async function twoClicks() {
  const alpha = await createClick(LOCAL, { name: "Alpha" });
  const beta = await createClick(LOCAL, { name: "Beta" });
  const ada = await mint(alpha.click_key, "ada");
  const bob = await mint(alpha.click_key, "bob");
  const carol = await mint(beta.click_key, "carol");
  const issued = (await api(LOCAL, beta.click_key, "/api/v1/invites", { method: "POST", body: {} })).body as { invite: string };
  const joined = await api(LOCAL, ada.token, "/api/v1/clicks/join", { method: "POST", body: { invite: issued.invite } });
  expect(joined.status).toBe(201);
  const adaBeta = handle("adab");
  expect((await api(LOCAL, ada.token, `/api/v1/agents?click=${beta.click_id}`, { method: "POST", body: { handle: adaBeta } })).status).toBe(200);
  return { alpha, beta, ada, adaBeta, bob, carol };
}

async function send(token: string, body: Record<string, unknown>) {
  const result = await api(LOCAL, token, "/api/v1/messages", { method: "POST", body });
  await tick();
  return result;
}

describe("several clicks without tracking which one", () => {
  it("merges the inbox across clicks newest first, labels each message, pages, and acks anywhere", async () => {
    const { alpha, beta, ada, adaBeta, bob, carol } = await twoClicks();
    await send(bob.token, { to: ada.handle, text: "a1" });
    await send(carol.token, { to: adaBeta, text: "b1" });
    await send(bob.token, { to: ada.handle, text: "a2" });

    const merged = (await api(LOCAL, ada.token, "/api/v1/inbox")).body as Inbox;
    expect(merged.messages.map((m) => m.text)).toEqual(["a2", "b1", "a1"]);
    expect(merged.messages.map((m) => [m.click, m.click_name])).toEqual([[alpha.click_id, "Alpha"], [beta.click_id, "Beta"], [alpha.click_id, "Alpha"]]);
    expect(merged).not.toHaveProperty("click");

    const first = (await api(LOCAL, ada.token, "/api/v1/inbox?limit=2")).body as Inbox;
    expect(first.messages.map((m) => m.text)).toEqual(["a2", "b1"]);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = (await api(LOCAL, ada.token, `/api/v1/inbox?limit=2&cursor=${encodeURIComponent(first.next_cursor ?? "")}`)).body as Inbox;
    expect(second.messages.map((m) => m.text)).toEqual(["a1"]);
    expect(second.next_cursor).toBeNull();
    expect((await api(LOCAL, ada.token, "/api/v1/inbox?cursor=nonsense")).status).toBe(400);

    const onlyBeta = (await api(LOCAL, ada.token, "/api/v1/inbox?click=Beta")).body as Inbox;
    expect(onlyBeta.click).toBe(beta.click_id);
    expect(onlyBeta.messages.map((m) => [m.text, m.click])).toEqual([["b1", beta.click_id]]);

    await initialize(LOCAL, ada.token);
    const viaMcp = await callTool(LOCAL, ada.token, "inbox") as Inbox;
    expect(viaMcp.messages.map((m) => m.text)).toEqual(["a2", "b1", "a1"]);

    const acked = (await api(LOCAL, ada.token, "/api/v1/ack", { method: "POST", body: { ids: [...merged.messages.map((m) => m.id), "nope"] } })).body as { acked: string[]; missing: string[]; by_click: Record<string, string[]> };
    expect(acked.acked).toHaveLength(3);
    expect(acked.missing).toEqual(["nope"]);
    expect(acked.by_click[alpha.click_id]).toHaveLength(2);
    expect(acked.by_click[beta.click_id]).toHaveLength(1);
    expect(((await api(LOCAL, ada.token, "/api/v1/inbox")).body as Inbox).messages).toEqual([]);

    const history = (await api(LOCAL, ada.token, "/api/v1/history")).body as { events: Array<{ text: string; click: string }> };
    expect(history.events.map((e) => e.text)).toEqual(["a2", "b1", "a1"]);
  });

  it("routes a reply to the click and sender of the original, and refuses a conflicting click", async () => {
    const { alpha, beta, ada, adaBeta, bob, carol } = await twoClicks();
    await send(carol.token, { to: adaBeta, text: "question in beta" });
    await send(bob.token, { to: ada.handle, text: "question in alpha" });
    const inbox = (await api(LOCAL, ada.token, "/api/v1/inbox")).body as Inbox;
    const fromCarol = inbox.messages.find((m) => m.text === "question in beta");
    const fromBob = inbox.messages.find((m) => m.text === "question in alpha");
    if (!fromCarol || !fromBob) throw new Error("missing messages");

    const reply = await send(ada.token, { reply_to: fromCarol.id, text: "answer in beta" });
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ click: beta.click_id, click_name: "Beta", recipients: [carol.handle] });
    const carolInbox = (await api(LOCAL, carol.token, "/api/v1/inbox")).body as Inbox;
    expect(carolInbox.messages.map((m) => [m.text, m.from, m.reply_to])).toEqual([["answer in beta", adaBeta, fromCarol.event_id]]);
    expect(((await api(LOCAL, bob.token, "/api/v1/inbox")).body as Inbox).messages).toEqual([]);

    await initialize(LOCAL, ada.token);
    const mcpReply = await callTool(LOCAL, ada.token, "send", { reply_to: fromBob.event_id, text: "answer in alpha" }) as { click: string; recipients: string[] };
    expect(mcpReply).toMatchObject({ click: alpha.click_id, recipients: [bob.handle] });
    expect(((await api(LOCAL, bob.token, "/api/v1/inbox")).body as Inbox).messages.map((m) => m.text)).toEqual(["answer in alpha"]);

    const conflict = await send(ada.token, { reply_to: fromCarol.id, click: "Alpha", text: "wrong click" });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "conflict" });
    expect((conflict.body as Problem).detail).toMatch(new RegExp(`Click conflict.*${beta.click_id} \\(Beta\\)`));
    await expect(callTool(LOCAL, ada.token, "send", { reply_to: fromCarol.id, click: alpha.click_id, text: "x" })).rejects.toThrow(/Click conflict/);
    const sameClick = await send(ada.token, { reply_to: fromCarol.id, click: "Beta", text: "fine" });
    expect(sameClick.status).toBe(200);

    const unknown = await send(ada.token, { reply_to: "00000000-0000-4000-8000-000000000000", text: "?" });
    expect(unknown.status).toBe(400);
    // Carol cannot reply to a message she never saw.
    expect((await send(carol.token, { reply_to: fromBob.id, text: "peek" })).status).toBe(400);
  });

  it("routes a new send by recipient and errors with the candidates when it is ambiguous", async () => {
    const { alpha, beta, ada, bob } = await twoClicks();
    const routed = await send(ada.token, { to: bob.handle, text: "only alpha has bob" });
    expect(routed.body).toMatchObject({ click: alpha.click_id, recipients: [bob.handle] });

    const shared = handle("shared");
    await api(LOCAL, alpha.click_key, "/api/v1/tokens", { method: "POST", body: { handle: shared } });
    await api(LOCAL, beta.click_key, "/api/v1/tokens", { method: "POST", body: { handle: shared } });
    const ambiguous = await send(ada.token, { to: shared, text: "which one?" });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body).toMatchObject({ code: "ambiguous_click" });
    const detail = (ambiguous.body as Problem).detail;
    expect(detail).toContain(`${alpha.click_id} (Alpha)`);
    expect(detail).toContain(`${beta.click_id} (Beta)`);
    await initialize(LOCAL, ada.token);
    await expect(callTool(LOCAL, ada.token, "send", { to: shared, text: "which one?" })).rejects.toThrow(/Ambiguous.*Alpha.*Beta|Ambiguous.*Beta.*Alpha/);
    expect((await send(ada.token, { to: shared, click: "Beta", text: "this one" })).body).toMatchObject({ click: beta.click_id });

    const nobody = await send(ada.token, { to: handle("ghost"), text: "?" });
    expect(nobody.status).toBe(400);
    expect((nobody.body as Problem).detail).toMatch(/None of your clicks/);
    const broadcast = await send(ada.token, { broadcast: true, text: "all" });
    expect(broadcast.status).toBe(400);
    expect((broadcast.body as Problem).detail).toMatch(/needs click/);
  });

  it("keeps single-click agents and legacy click keys working as before", async () => {
    const click = await createClick(LOCAL, { name: "Solo" });
    const one = await mint(click.click_key, "one");
    const two = await mint(click.click_key, "two");
    await send(one.token, { to: two.handle, text: "first" });
    await send(one.token, { to: two.handle, text: "second" });
    const inbox = (await api(LOCAL, two.token, "/api/v1/inbox")).body as Inbox;
    expect(inbox.click).toBe(click.click_id);
    expect(inbox.click_name).toBe("Solo");
    expect(inbox.messages.map((m) => m.text)).toEqual(["first", "second"]);
    expect(inbox.messages[0]).toMatchObject({ click: click.click_id, click_name: "Solo" });
    expect((await api(LOCAL, two.token, "/api/v1/ack", { method: "POST", body: { ids: inbox.messages.map((m) => m.id) } })).body).toMatchObject({ missing: [] });
    const broadcast = await send(two.token, { broadcast: true, text: "everyone" });
    expect(broadcast.body).toMatchObject({ click: click.click_id });

    const adminHandle = handle("admin");
    expect((await api(LOCAL, click.click_key, "/api/v1/agents", { method: "POST", body: { handle: adminHandle } })).status).toBe(200);
    await send(one.token, { to: adminHandle, text: "to the key" });
    const legacy = (await api(LOCAL, click.click_key, "/api/v1/inbox")).body as Inbox;
    expect(legacy.click).toBe(click.click_id);
    expect(legacy.messages.map((m) => m.text)).toEqual(["to the key"]);
    const reply = await send(click.click_key, { reply_to: legacy.messages[0]?.id, text: "got it" });
    expect(reply.body).toMatchObject({ click: click.click_id, recipients: [one.handle] });

    await initialize(LOCAL, one.token);
    expect(await callTool(LOCAL, one.token, "whoami")).toMatchObject({ click_id: click.click_id });
    const mcpInbox = await callTool(LOCAL, one.token, "inbox") as Inbox;
    expect(mcpInbox.click).toBe(click.click_id);
    expect(mcpInbox.messages.map((m) => m.text)).toEqual(["everyone", "got it"]);
  });

  it("tells agents in the MCP instructions that routing is automatic", async () => {
    const click = await createClick();
    const init = await mcpCall(LOCAL, click.click_key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const instructions = (init.result as { instructions?: string }).instructions ?? "";
    expect(instructions).toMatch(/inbox/);
    expect(instructions).toMatch(/reply_to/);
    expect(instructions).toMatch(/Routing is automatic/);
  });
});
