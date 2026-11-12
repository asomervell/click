import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, callTool, createClick, handle, initialize, LOCAL, signIn } from "./helpers";

async function signup(base: string): Promise<{ token: string; handle: string; message_for_person: string }> {
  const response = await SELF.fetch(`${LOCAL}/api/v1/agents/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 250) + 1}` },
    body: JSON.stringify({ handle: base, name: base }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

describe("reusable invites", () => {
  it("lets several agents join with one invite, counts uses, and stops after revoke", async () => {
    const created = await createClick();
    const made = (await api(LOCAL, created.click_key, "/api/v1/invites", { method: "POST", body: { max_uses: 3 } })).body as { invite: string; id: string; max_uses: number; paste_line: string };
    expect(made.max_uses).toBe(3);
    expect(made.paste_line).toContain(made.invite);
    const join = (invite: string) => SELF.fetch(`${LOCAL}/api/v1/clicks/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite }) });
    expect((await join(made.invite)).status).toBe(201);
    expect((await join(made.invite)).status).toBe(201);
    let listed = (await api(LOCAL, created.click_key, "/api/v1/invites")).body as Array<{ id: string; uses: number; uses_left: number; status: string }>;
    expect(listed.find((row) => row.id === made.id)).toMatchObject({ uses: 2, uses_left: 1, status: "open" });
    await api(LOCAL, created.click_key, `/api/v1/invites/${made.id}`, { method: "DELETE" });
    const after = await join(made.invite);
    expect(after.status).toBe(400);
    listed = (await api(LOCAL, created.click_key, "/api/v1/invites?include_closed=true")).body as typeof listed;
    expect(listed.find((row) => row.id === made.id)).toMatchObject({ status: "revoked", uses: 2 });
  });

  it("makes the first invite reusable for 10 agents", async () => {
    const created = await createClick();
    const listed = (await api(LOCAL, created.click_key, "/api/v1/invites")).body as Array<{ id: string; max_uses: number; uses_left: number }>;
    expect(listed.find((row) => row.id === created.first_invite_id)).toMatchObject({ max_uses: 10, uses_left: 10 });
  });

  it("runs out after max_uses", async () => {
    const created = await createClick();
    const made = (await api(LOCAL, created.click_key, "/api/v1/invites", { method: "POST", body: { max_uses: 1 } })).body as { invite: string };
    const join = () => SELF.fetch(`${LOCAL}/api/v1/clicks/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite: made.invite }) });
    expect((await join()).status).toBe(201);
    const second = await join();
    expect(second.status).toBe(400);
    expect(((await second.json()) as { title?: string; detail?: string }).detail ?? "").toMatch(/no uses left/);
  });
});

describe("agents that sign up on their own", () => {
  it("signs up over HTTP with a suffixed handle, and an admin adds it by handle", async () => {
    const created = await createClick();
    const agent = await signup("research");
    expect(agent.handle).toMatch(/^research-[a-z0-9]{4}$/);
    expect(agent.message_for_person).toContain(`add @${agent.handle}`);
    const before = (await api(LOCAL, agent.token, "/api/v1/clicks")).body as { clicks: unknown[] };
    expect(before.clicks).toEqual([]);
    const added = (await api(LOCAL, created.click_key, "/api/v1/members", { method: "POST", body: { handle: `@${agent.handle}` } })).body as { status: string };
    expect(added.status).toBe("added");
    const clicks = (await api(LOCAL, agent.token, "/api/v1/clicks")).body as { clicks: Array<{ click_id: string; handle: string | null }> };
    expect(clicks.clicks).toEqual([expect.objectContaining({ click_id: created.click_id, handle: agent.handle })]);

    // Messages flow with no register step.
    await initialize(LOCAL, created.click_key);
    await callTool(LOCAL, created.click_key, "register", { handle: handle("admin") });
    await callTool(LOCAL, created.click_key, "send", { to: agent.handle, text: "welcome" });
    const inbox = (await api(LOCAL, agent.token, "/api/v1/inbox")).body as { messages: Array<{ text: string }> };
    expect(inbox.messages.map((m) => m.text)).toEqual(["welcome"]);
  });

  it("needs the agent's consent once it is no longer open to joining", async () => {
    const first = await createClick();
    const second = await createClick();
    const agent = await signup("helper");
    await api(LOCAL, first.click_key, "/api/v1/members", { method: "POST", body: { handle: agent.handle } });
    // The first add closed the open window: the next add waits.
    const pending = (await api(LOCAL, second.click_key, "/api/v1/members", { method: "POST", body: { handle: agent.handle } })).body as { status: string };
    expect(pending.status).toBe("pending");
    const waiting = (await api(LOCAL, agent.token, "/api/v1/join-requests")).body as { adds_for_you: Array<{ click: string }> };
    expect(waiting.adds_for_you.map((row) => row.click)).toEqual([second.click_id]);
    const accepted = (await api(LOCAL, agent.token, "/api/v1/join-requests/accept", { method: "POST", body: { click: second.click_id } })).body as { status: string };
    expect(accepted.status).toBe("added");
    const clicks = (await api(LOCAL, agent.token, "/api/v1/clicks")).body as { clicks: unknown[] };
    expect(clicks.clicks).toHaveLength(2);
  });

  it("lets an agent request to join and an admin approve with add_member", async () => {
    const first = await createClick();
    const second = await createClick();
    const agent = await signup("asker");
    await api(LOCAL, first.click_key, "/api/v1/members", { method: "POST", body: { handle: agent.handle } });
    const requested = (await api(LOCAL, agent.token, "/api/v1/join-requests", { method: "POST", body: { click: second.click_id } })).body as { status: string };
    expect(requested.status).toBe("requested");
    const seen = (await api(LOCAL, second.click_key, "/api/v1/join-requests")).body as { requests_to_your_clicks: Array<{ handle: string }> };
    expect(seen.requests_to_your_clicks.map((row) => row.handle)).toEqual([agent.handle]);
    const approved = (await api(LOCAL, second.click_key, "/api/v1/members", { method: "POST", body: { handle: agent.handle } })).body as { status: string };
    expect(approved.status).toBe("added");
  });

  it("rejects unknown handles and non-admin adds", async () => {
    const created = await createClick();
    const missing = await api(LOCAL, created.click_key, "/api/v1/members", { method: "POST", body: { handle: "nobody-zzzz" } });
    expect(missing.status).toBe(400);
    const agent = await signup("solo");
    const other = await signup("other");
    const notAdmin = await api(LOCAL, agent.token, "/api/v1/members", { method: "POST", body: { handle: other.handle } });
    expect(notAdmin.status).toBe(400);
  });

  it("connects over OAuth with no invite, claims a handle, and joins with an invite over MCP", async () => {
    const created = await createClick();
    const made = (await api(LOCAL, created.click_key, "/api/v1/invites", { method: "POST", body: {} })).body as { invite: string };
    const token = await signIn(LOCAL, {});
    await initialize(LOCAL, token);
    const empty = (await callTool(LOCAL, token, "list_clicks")) as { clicks: unknown[]; next: string };
    expect(empty.clicks).toEqual([]);
    expect(empty.next).toMatch(/register/);
    const claimed = (await callTool(LOCAL, token, "register", { handle: "codex" })) as { handle: string };
    expect(claimed.handle).toMatch(/^codex-/);
    const joined = (await callTool(LOCAL, token, "join_click", { invite: made.invite })) as { handle: string };
    expect(joined.handle).toBe(claimed.handle);
    const members = (await callTool(LOCAL, created.click_key, "list_members")) as unknown;
    expect(JSON.stringify(members)).toContain(claimed.handle);
  });
});
