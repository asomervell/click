import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, callTool, createClick, handle, initialize, lastCode, lastHandoffPage, LOCAL, OWNER_KEY, signIn, startCreate, testEmail, verifyCreate } from "./helpers";

const NOTICE = "Save this somewhere safe. If you lose it, you lose the Click.";

type Handoff = {
  click_id: string;
  click_key: string;
  admin_key: { click_key: string; notice: string; instruction: string };
  first_invite: { invite: string; id: string; expires_at: number; max_uses: number; paste_line: string };
  message_for_person: string;
  next_steps: string[];
};

async function joinWith(invite: string): Promise<Response> {
  return SELF.fetch(`${LOCAL}/api/v1/clicks/join`, {
    method: "POST",
    headers: { "content-type": "application/json", host: new URL(LOCAL).host },
    body: JSON.stringify({ invite }),
  });
}

function checkHandoff(body: Handoff, origin: string) {
  expect(body.admin_key.click_key).toBe(body.click_key);
  expect(body.admin_key.notice).toBe(NOTICE);
  expect(body.admin_key.instruction).toContain(NOTICE);
  expect(body.first_invite.invite.startsWith("clk_inv_")).toBe(true);
  expect(body.first_invite.max_uses).toBe(10);
  expect(body.first_invite.expires_at).toBeGreaterThan(Date.now() + 6.9 * 24 * 3_600_000);
  expect(body.first_invite.expires_at).toBeLessThan(Date.now() + 7.1 * 24 * 3_600_000);
  expect(body.first_invite.paste_line).toBe(`Connect to Click at ${origin}/mcp and join with invite ${body.first_invite.invite}`);
  expect(body.message_for_person).toContain(body.click_key);
  expect(body.message_for_person).toContain(NOTICE);
  expect(body.message_for_person).toContain(body.first_invite.paste_line);
  expect(body.next_steps.length).toBeGreaterThan(2);
  expect(body.next_steps.join(" ")).toMatch(/message_for_person/);
  expect(body.next_steps.join(" ")).toMatch(/register/);
  expect(JSON.stringify(body)).not.toMatch(/1password|password manager/i);
}

describe("create handoff", () => {
  it("returns the admin key, a working first invite, and next_steps from POST /api/v1/clicks/verify", async () => {
    const email = testEmail();
    const started = await startCreate(LOCAL, email, { name: "Handoff" });
    const verified = await verifyCreate(LOCAL, String(started.body.pending_id), lastCode(email));
    expect(verified.status).toBe(201);
    const body = verified.body as Handoff;
    checkHandoff(body, LOCAL);
    const joined = await joinWith(body.first_invite.invite);
    expect(joined.status).toBe(201);
    expect(((await joined.json()) as { click_id: string }).click_id).toBe(body.click_id);
    // The first invite is reusable: a second agent joins with the same line.
    expect((await joinWith(body.first_invite.invite)).status).toBe(201);
  });

  it("returns the same block from verify_click over MCP", async () => {
    const home = await createClick();
    await initialize(LOCAL, home.click_key);
    const email = testEmail();
    const started = await callTool(LOCAL, home.click_key, "create_click", { email }) as { pending_id: string };
    const body = await callTool(LOCAL, home.click_key, "verify_click", { pending_id: started.pending_id, code: lastCode(email) }) as Handoff;
    checkHandoff(body, "https://clickmcp.com");
    expect((await joinWith(body.first_invite.invite)).status).toBe(201);
  });

  it("shows the person the admin key and first invite on the sign-in page, then finishes the connection", async () => {
    const token = await signIn(LOCAL, { email: testEmail() });
    expect(lastHandoffPage).toContain(NOTICE);
    const invite = /join with invite (clk_inv_[A-Za-z0-9_-]+)/.exec(lastHandoffPage)?.[1];
    expect(invite).toBeTruthy();
    expect(lastHandoffPage).not.toMatch(/1password|password manager/i);
    await initialize(LOCAL, token);
    const clicks = await callTool(LOCAL, token, "list_clicks") as { clicks: Array<{ click_id: string; role: string }> };
    expect(clicks.clicks[0]?.role).toBe("admin");
    const joined = await joinWith(String(invite));
    expect(((await joined.json()) as { click_id: string }).click_id).toBe(clicks.clicks[0]?.click_id);
  });

  it("returns paste_line from create_invite", async () => {
    const created = await createClick();
    const made = (await api(LOCAL, created.click_key, "/api/v1/invites", { method: "POST", body: {} })).body as { invite: string; paste_line: string };
    expect(made.paste_line).toBe(`Connect to Click at https://clickmcp.com/mcp and join with invite ${made.invite}`);
  });
});

describe("doorbell link", () => {
  it("lets the person paste the webhook URL and key straight into Click, once", async () => {
    const created = await createClick();
    await initialize(LOCAL, created.click_key);
    await callTool(LOCAL, created.click_key, "register", { handle: handle("bell") });
    const link = await callTool(LOCAL, created.click_key, "doorbell_link") as { url: string; message_for_person: string };
    expect(link.message_for_person).toContain(link.url);
    const url = new URL(link.url);
    const local = `${LOCAL}${url.pathname}${url.search}`;
    const page = await SELF.fetch(local);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Webhook key");
    const form = new URLSearchParams({ c: url.searchParams.get("c") ?? "", t: url.searchParams.get("t") ?? "", url: "https://hooks.test/bell", key: "a-routine-webhook-key" });
    const saved = await SELF.fetch(`${LOCAL}/doorbell`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: LOCAL }, body: form });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain("Doorbell set");
    const who = await callTool(LOCAL, created.click_key, "whoami") as { agent: { webhook_configured: boolean; webhook_url: string } };
    expect(who.agent.webhook_configured).toBe(true);
    expect(who.agent.webhook_url).toBe("https://hooks.test/bell");
    const again = await SELF.fetch(`${LOCAL}/doorbell`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: LOCAL }, body: form });
    expect(again.status).toBe(400);
  });
});

describe("deleting a click", () => {
  it("erases the click, its invites, and the OAuth grant of a connection that lived only there", async () => {
    const token = await signIn(LOCAL, { email: testEmail() });
    await initialize(LOCAL, token);
    const clicks = await callTool(LOCAL, token, "list_clicks") as { clicks: Array<{ click_id: string }> };
    const clickId = String(clicks.clicks[0]?.click_id);
    const invite = /join with invite (clk_inv_[A-Za-z0-9_-]+)/.exec(lastHandoffPage)?.[1];
    expect(await callTool(LOCAL, token, "delete_click")).toEqual({ deleted: true, click_id: clickId });
    expect((await joinWith(String(invite))).status).toBe(400);
    const listed = await SELF.fetch(`${LOCAL}/api/v1/operator/clicks`, { headers: { authorization: `Bearer ${OWNER_KEY}` } });
    const all = (await listed.json()) as { clicks: Array<{ id: string }> };
    expect(all.clicks.map((row) => row.id)).not.toContain(clickId);
    const after = await SELF.fetch(`${LOCAL}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(after.status).toBe(401);
  });

  it("keeps operator routes closed without the owner key", async () => {
    const created = await createClick();
    expect((await SELF.fetch(`${LOCAL}/api/v1/operator/clicks`)).status).toBe(401);
    expect((await SELF.fetch(`${LOCAL}/api/v1/operator/clicks`, { headers: { authorization: `Bearer ${created.click_key}` } })).status).toBe(401);
  });
});
