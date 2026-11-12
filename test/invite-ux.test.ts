import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, callTool, createClick, handle, initialize, lastConnectPage, lastConnectRefresh, LOCAL, signIn } from "./helpers";

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
  it("gets a plain handle, with a suffix only when it is taken", async () => {
    const base = handle("riff");
    const first = await signup(base);
    expect(first.handle).toBe(base);
    const second = await signup(base);
    expect(second.handle).toBe(`${base}-2`);
    expect(second.message_for_person).toContain("was taken");
  });

  it("asks to join a click by name and the admin approves it from the list", async () => {
    const name = `team-${handle("x")}`;
    const created = await createClick(LOCAL, { name });
    const agent = await signup(handle("chief"));
    const requested = (await api(LOCAL, agent.token, "/api/v1/join-requests", { method: "POST", body: { click: name } })).body as { status: string; click_id: string; message_for_person: string };
    expect(requested).toMatchObject({ status: "requested", click_id: created.click_id });
    expect(requested.message_for_person).toContain(`approve @${agent.handle}`);
    const seen = (await api(LOCAL, created.click_key, "/api/v1/join-requests")).body as { requests_to_your_clicks: Array<{ handle: string }> };
    expect(seen.requests_to_your_clicks.map((row) => row.handle)).toEqual([agent.handle]);
    const approved = (await api(LOCAL, created.click_key, "/api/v1/join-requests/approve", { method: "POST", body: { handle: agent.handle } })).body as { status: string };
    expect(approved.status).toBe("added");
    // Messages flow with no register step.
    await initialize(LOCAL, created.click_key);
    await callTool(LOCAL, created.click_key, "register", { handle: handle("admin") });
    await callTool(LOCAL, created.click_key, "send", { to: agent.handle, text: "welcome" });
    const inbox = (await api(LOCAL, agent.token, "/api/v1/inbox")).body as { messages: Array<{ text: string }> };
    expect(inbox.messages.map((m) => m.text)).toEqual(["welcome"]);
  });

  it("never pulls an agent in by a guessed handle: adds wait for accept unless it opted in", async () => {
    const created = await createClick();
    const agent = await signup(handle("helper"));
    const pending = (await api(LOCAL, created.click_key, "/api/v1/members", { method: "POST", body: { handle: agent.handle } })).body as { status: string };
    expect(pending.status).toBe("pending");
    expect(((await api(LOCAL, agent.token, "/api/v1/clicks")).body as { clicks: unknown[] }).clicks).toEqual([]);
    const waiting = (await api(LOCAL, agent.token, "/api/v1/join-requests")).body as { adds_for_you: Array<{ click: string }> };
    expect(waiting.adds_for_you.map((row) => row.click)).toEqual([created.click_id]);
    const accepted = (await api(LOCAL, agent.token, "/api/v1/join-requests/accept", { method: "POST", body: { click: created.click_id } })).body as { status: string };
    expect(accepted.status).toBe("added");

    const second = await createClick();
    await api(LOCAL, agent.token, "/api/v1/open-to-join", { method: "POST", body: { open: true } });
    const direct = (await api(LOCAL, second.click_key, "/api/v1/members", { method: "POST", body: { handle: agent.handle } })).body as { status: string };
    expect(direct.status).toBe("added");
  });

  it("approve_join only approves agents that asked", async () => {
    const created = await createClick();
    const agent = await signup(handle("quiet"));
    const tried = await api(LOCAL, created.click_key, "/api/v1/join-requests/approve", { method: "POST", body: { handle: agent.handle } });
    expect(tried.status).toBe(400);
  });

  it("renames: history stays, others get a note, the old handle is held, and renames are limited", async () => {
    const name = `crew-${handle("x")}`;
    const created = await createClick(LOCAL, { name });
    const agent = await signup(handle("old"));
    await api(LOCAL, agent.token, "/api/v1/join-requests", { method: "POST", body: { click: name } });
    await api(LOCAL, created.click_key, "/api/v1/join-requests/approve", { method: "POST", body: { handle: agent.handle } });
    await initialize(LOCAL, created.click_key);
    const adminHandle = handle("boss");
    await callTool(LOCAL, created.click_key, "register", { handle: adminHandle });
    await callTool(LOCAL, created.click_key, "send", { to: agent.handle, text: "before rename" });
    const oldHandle = agent.handle;
    const newHandle = handle("new");
    const renamed = (await api(LOCAL, agent.token, "/api/v1/me/handle", { method: "POST", body: { handle: newHandle } })).body as { old_handle: string; handle: string };
    expect(renamed).toMatchObject({ old_handle: oldHandle, handle: newHandle });
    const inbox = (await api(LOCAL, agent.token, "/api/v1/inbox")).body as { messages: Array<{ text: string }> };
    expect(inbox.messages.map((m) => m.text)).toContain("before rename");
    const adminInbox = (await callTool(LOCAL, created.click_key, "inbox")) as { messages: Array<{ text: string; from: string }> };
    expect(adminInbox.messages.some((m) => m.text.includes(`@${oldHandle} is now @${newHandle}`) && m.from === newHandle)).toBe(true);
    await callTool(LOCAL, created.click_key, "send", { to: newHandle, text: "after rename" });
    // The old handle is held: another agent cannot take it globally or in the click.
    const squatter = await signup(oldHandle);
    expect(squatter.handle).not.toBe(oldHandle);
    await expect(callTool(LOCAL, created.click_key, "mint_token", { handle: oldHandle })).rejects.toThrow(/taken/);
    // Three renames a day.
    await api(LOCAL, agent.token, "/api/v1/me/handle", { method: "POST", body: { handle: handle("r2") } });
    await api(LOCAL, agent.token, "/api/v1/me/handle", { method: "POST", body: { handle: handle("r3") } });
    const limited = await api(LOCAL, agent.token, "/api/v1/me/handle", { method: "POST", body: { handle: handle("r4") } });
    expect(limited.status).toBe(429);
  });

  it("rejects unknown handles and non-admin adds, and deletes an identity", async () => {
    const created = await createClick();
    const missing = await api(LOCAL, created.click_key, "/api/v1/members", { method: "POST", body: { handle: "nobody-zzzz" } });
    expect(missing.status).toBe(400);
    const agent = await signup(handle("solo"));
    const other = await signup(handle("other"));
    const notAdmin = await api(LOCAL, agent.token, "/api/v1/members", { method: "POST", body: { handle: other.handle } });
    expect(notAdmin.status).toBe(400);
    const gone = (await api(LOCAL, agent.token, "/api/v1/identity", { method: "DELETE" })).body as { deleted: boolean };
    expect(gone.deleted).toBe(true);
    expect((await api(LOCAL, agent.token, "/api/v1/clicks")).status).toBe(401);
  });

  it("connects over OAuth showing the handle, and joins with an invite over MCP", async () => {
    const created = await createClick();
    const made = (await api(LOCAL, created.click_key, "/api/v1/invites", { method: "POST", body: {} })).body as { invite: string };
    const wanted = handle("codex");
    const token = await signIn(LOCAL, { agentHandle: wanted });
    expect(lastConnectPage).toContain(`@${wanted}`);
    // Hands back to the loopback callback on its own: a native app's listener may not wait for a click.
    expect(lastConnectRefresh).toMatch(/^1;url=http:\/\/127\.0\.0\.1:8765\/callback\?code=.+&state=state-1&iss=/);
    expect(lastConnectPage).toContain('<meta http-equiv="refresh" content="1;url=http://127.0.0.1:8765/callback?');
    await initialize(LOCAL, token);
    const empty = (await callTool(LOCAL, token, "list_clicks")) as { clicks: unknown[]; you: { handle: string } };
    expect(empty.clicks).toEqual([]);
    expect(empty.you.handle).toBe(wanted);
    const joined = (await callTool(LOCAL, token, "join_click", { invite: made.invite })) as { handle: string };
    expect(joined.handle).toBe(wanted);
    const members = (await callTool(LOCAL, created.click_key, "list_members")) as unknown;
    expect(JSON.stringify(members)).toContain(wanted);
  });
});
