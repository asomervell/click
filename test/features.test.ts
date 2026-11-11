import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { signupMode, testSendFailures, verificationEmail } from "../src/email";
import {
  api,
  callTool,
  createClick,
  handle,
  initialize,
  lastCode,
  LOCAL,
  signIn,
  startCreate,
  testEmail,
  verifyCreate,
} from "./helpers";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Problem = { detail: string; code: string };

async function invite(adminToken: string, input: Record<string, unknown> = {}): Promise<{ invite: string; id: string; expires_at: number | null }> {
  const created = await api(LOCAL, adminToken, "/api/v1/invites", { method: "POST", body: input });
  expect(created.status).toBe(201);
  return created.body as { invite: string; id: string; expires_at: number | null };
}

async function joinHttp(inviteToken: string, bearer?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json", host: new URL(LOCAL).host };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await SELF.fetch(`${LOCAL}/api/v1/clicks/join`, { method: "POST", headers, body: JSON.stringify({ invite: inviteToken }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("email verification", () => {
  it("issues the click key only after the emailed code is verified", async () => {
    const email = testEmail();
    const started = await startCreate(LOCAL, email, { name: "Build crew" });
    expect(started.status).toBe(202);
    expect(started.body.status).toBe("verification_sent");
    expect(started.body).not.toHaveProperty("click_key");
    const pendingId = String(started.body.pending_id);
    const code = lastCode(email);
    expect(code).toMatch(/^\d{6}$/);
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await verifyCreate(LOCAL, pendingId, wrong);
    expect(bad.status).toBe(400);
    expect((bad.body as Problem).detail).toMatch(/not right.*4 tries left/);
    const ok = await verifyCreate(LOCAL, pendingId, code);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ email_verified: true, role: "admin", name: "Build crew" });
    const key = String(ok.body.click_key);
    const me = await api(LOCAL, key, "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: "admin", email, click_name: "Build crew" });
    const again = await verifyCreate(LOCAL, pendingId, code);
    expect(again.status).toBe(400);
  });

  it("locks a pending create after five wrong codes", async () => {
    const email = testEmail();
    const started = await startCreate(LOCAL, email);
    const pendingId = String(started.body.pending_id);
    const code = lastCode(email);
    const wrong = code === "123456" ? "654321" : "123456";
    for (let attempt = 0; attempt < 5; attempt++) await verifyCreate(LOCAL, pendingId, wrong);
    const locked = await verifyCreate(LOCAL, pendingId, code);
    expect(locked.status).toBe(429);
    expect((locked.body as Problem).detail).toMatch(/too many wrong codes/i);
  });

  it("rate-limits codes per email and per network", async () => {
    const email = testEmail();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await startCreate(LOCAL, email)).status).toBe(202);
    }
    const limited = await startCreate(LOCAL, email);
    expect(limited.status).toBe(429);
    const ip = "203.0.113.77";
    let last = 0;
    for (let attempt = 0; attempt < 11; attempt++) {
      const response = await SELF.fetch(`${LOCAL}/api/v1/clicks`, {
        method: "POST",
        headers: { "content-type": "application/json", host: new URL(LOCAL).host, "cf-connecting-ip": ip },
        body: JSON.stringify({ email: testEmail() }),
      });
      last = response.status;
    }
    expect(last).toBe(429);
  });

  it("does not count a failed send toward the per-email limit", async () => {
    const email = testEmail();
    testSendFailures.remaining = 3;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const failed = await startCreate(LOCAL, email);
        expect(failed.status).toBe(400);
        expect((failed.body as Problem).detail).toMatch(/could not be sent/);
      }
    } finally {
      testSendFailures.remaining = 0;
    }
    const sent = await startCreate(LOCAL, email);
    expect(sent.status).toBe(202);
    const verified = await verifyCreate(LOCAL, String(sent.body.pending_id), lastCode(email));
    expect(verified.status).toBe(201);
  });

  it("writes a short verification email and escapes the click name", () => {
    const named = verificationEmail({ code: "451683", clickName: "zz email test" });
    expect(named.subject).toBe("Click code 451683");
    expect(named.text).toBe("The verification code for zz email test is\n\n451683\n\nIf this was not you, ignore this email. No click is created without the code.");
    expect(named.html).toBe('<p>The verification code for zz email test is</p><p style="font-size:28px;font-weight:600;letter-spacing:4px">451683</p><p>If this was not you, ignore this email. No click is created without the code.</p>');
    const unnamed = verificationEmail({ code: "000123", clickName: null });
    expect(unnamed.text.startsWith("The verification code for your click is\n")).toBe(true);
    const hostile = verificationEmail({ code: "111111", clickName: "<b>\"x\" & y</b>" });
    expect(hostile.html).toContain("for &lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt; is");
    expect(hostile.html).not.toContain("<b>");
    expect(hostile.text).not.toMatch(/someone asked|works once/i);
  });

  it("only skips verification behind the explicit flag when no sender exists", () => {
    expect(signupMode({ ALLOW_UNVERIFIED_SIGNUP: "true" } as unknown as Env)).toEqual({ verify: false, reason: "unverified_flag" });
    expect(() => signupMode({ ALLOW_UNVERIFIED_SIGNUP: "false" } as unknown as Env)).toThrow(/paused/);
    const fakeBinding = { send: async () => ({ messageId: "m" }) };
    const live = signupMode({ ALLOW_UNVERIFIED_SIGNUP: "true", EMAIL: fakeBinding } as unknown as Env);
    expect(live.verify).toBe(true);
    expect(signupMode(env).verify).toBe(true);
  });

  it("verifies on the sign-in page and on /keys", async () => {
    const email = testEmail();
    const token = await signIn(LOCAL, { email });
    await initialize(LOCAL, token);
    const me = await callTool(LOCAL, token, "whoami") as { role: string; email: string };
    expect(me).toMatchObject({ role: "admin", email });

    const keysEmail = testEmail();
    const first = await SELF.fetch(`${LOCAL}/keys`, { method: "POST", body: new URLSearchParams({ email: keysEmail }) });
    const html = await first.text();
    expect(html).toContain("Check your email");
    expect(html).not.toContain("clk_");
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const second = await SELF.fetch(`${LOCAL}/keys`, {
      method: "POST",
      body: new URLSearchParams({ pending_id: pendingId, email: keysEmail, code: lastCode(keysEmail) }),
    });
    expect(await second.text()).toMatch(/class="secret">clk_/);
  });
});

describe("invites", () => {
  it("joins with an invite, lists and revokes invites, and rejects the raw click key", async () => {
    const created = await createClick();
    const first = await invite(created.click_key, { label: "grace", expires_in_hours: 48 });
    expect(first.expires_at).toBeGreaterThan(Date.now() + 47 * 3_600_000);
    const second = await invite(created.click_key, { label: "spare" });
    expect(second.expires_at).toBeGreaterThan(Date.now() + 6 * 24 * 3_600_000);

    const open = await api(LOCAL, created.click_key, "/api/v1/invites");
    expect((open.body as Array<{ id: string; status: string }>).map((row) => row.id).sort()).toEqual([first.id, second.id].sort());

    const joined = await joinHttp(first.invite);
    expect(joined.status).toBe(201);
    const memberToken = String(joined.body.token);
    const graceHandle = handle("grace");
    expect((await api(LOCAL, memberToken, "/api/v1/agents", { method: "POST", body: { handle: graceHandle } })).status).toBe(200);
    expect((await joinHttp(first.invite)).status).toBe(400);

    const memberInvite = await api(LOCAL, memberToken, "/api/v1/invites", { method: "POST", body: {} });
    expect(memberInvite.status).toBe(400);
    expect((memberInvite.body as Problem).detail).toMatch(/admin/);

    const revoked = await api(LOCAL, created.click_key, `/api/v1/invites/${second.id}`, { method: "DELETE" });
    expect(revoked.body).toEqual({ id: second.id, revoked: true });
    expect((await joinHttp(second.invite)).status).toBe(400);

    const stillOpen = await api(LOCAL, created.click_key, "/api/v1/invites");
    expect(stillOpen.body).toEqual([]);
    const all = await api(LOCAL, created.click_key, "/api/v1/invites?include_closed=true");
    const rows = all.body as Array<{ id: string; status: string; used_by: string | null }>;
    expect(rows.find((row) => row.id === first.id)).toMatchObject({ status: "used", used_by: graceHandle });
    expect(rows.find((row) => row.id === second.id)).toMatchObject({ status: "revoked" });

    const keyJoin = await SELF.fetch(`${LOCAL}/api/v1/clicks/join`, {
      method: "POST",
      headers: { "content-type": "application/json", host: new URL(LOCAL).host },
      body: JSON.stringify({ click_key: created.click_key }),
    });
    expect(keyJoin.status).toBe(400);
    expect(((await keyJoin.json()) as Problem).detail).toMatch(/ask the click admin for an invite/i);
  });

  it("expires invites and lists and revokes them over MCP", async () => {
    const created = await createClick();
    await initialize(LOCAL, created.click_key);
    const short = await callTool(LOCAL, created.click_key, "create_invite", { label: "brief", expires_in_hours: 0.0001 }) as { invite: string; id: string };
    await new Promise((resolve) => setTimeout(resolve, 600));
    const expired = await joinHttp(short.invite);
    expect(expired.status).toBe(400);
    expect((expired.body as Problem).detail).toMatch(/expired/);
    const other = await callTool(LOCAL, created.click_key, "create_invite", {}) as { id: string };
    const listed = await callTool(LOCAL, created.click_key, "list_invites") as Array<{ id: string }>;
    expect(listed.map((row) => row.id)).toEqual([other.id]);
    expect(await callTool(LOCAL, created.click_key, "revoke_invite", { invite_id: other.id })).toEqual({ id: other.id, revoked: true });
    expect(await callTool(LOCAL, created.click_key, "list_invites")).toEqual([]);
  });

  it("signs in on the consent page with an invite as a member, or with the key as the admin", async () => {
    const created = await createClick();
    const issued = await invite(created.click_key);
    const member = await signIn(LOCAL, { key: issued.invite });
    await initialize(LOCAL, member);
    expect(await callTool(LOCAL, member, "whoami")).toMatchObject({ role: "member", click_id: created.click_id });
    const admin = await signIn(LOCAL, { key: created.click_key });
    await initialize(LOCAL, admin);
    expect(await callTool(LOCAL, admin, "whoami")).toMatchObject({ role: "admin", principal_id: created.principal_id });
  });
});

describe("several clicks", () => {
  it("lets one token hold memberships in two clicks with messages flowing in both", async () => {
    const captured: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://hooks.test/")) {
        captured.push({ url, ...JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return new Response(null, { status: 204 });
      }
      return originalFetch(input, init);
    };
    const one = await createClick(LOCAL, { name: "Alpha Team" });
    const two = await createClick(LOCAL, { name: "Beta" });
    const adaHandle = handle("ada");
    const bobHandle = handle("bob");
    const carolHandle = handle("carol");
    const ada = (await api(LOCAL, one.click_key, "/api/v1/tokens", { method: "POST", body: { handle: adaHandle } })).body as { token: string };
    await api(LOCAL, one.click_key, "/api/v1/tokens", { method: "POST", body: { handle: bobHandle } });
    const carol = (await api(LOCAL, two.click_key, "/api/v1/tokens", { method: "POST", body: { handle: carolHandle } })).body as { token: string };

    const before = await api(LOCAL, ada.token, "/api/v1/me");
    expect(before.status).toBe(200);
    const issued = await invite(two.click_key, { label: "ada" });
    const joined = await joinHttp(issued.invite, ada.token);
    expect(joined.status).toBe(201);
    expect(joined.body).toMatchObject({ click_id: two.click_id, name: "Beta", added_to_existing_identity: true });
    expect(joined.body).not.toHaveProperty("token");

    const clicks = (await api(LOCAL, ada.token, "/api/v1/clicks")).body as { clicks: Array<{ click_id: string; name: string; handle: string | null; role: string }> };
    expect(clicks.clicks.map((row) => row.click_id).sort()).toEqual([one.click_id, two.click_id].sort());
    expect(clicks.clicks.find((row) => row.click_id === one.click_id)).toMatchObject({ handle: adaHandle, name: "Alpha Team" });

    expect((await api(LOCAL, ada.token, "/api/v1/inbox")).status).toBe(200);
    const ambiguous = await api(LOCAL, ada.token, "/api/v1/me");
    expect(ambiguous.status).toBe(400);
    expect((ambiguous.body as Problem).detail).toMatch(/in 2 clicks.*Pass click/);

    const registered = await api(LOCAL, ada.token, `/api/v1/agents?click=${two.click_id}`, {
      method: "POST",
      body: { handle: "ada-two", webhook_url: "https://hooks.test/ada-two", webhook_key: "two-secret-key" },
    });
    expect(registered.status).toBe(200);
    expect(registered.body).toMatchObject({ click_id: two.click_id, agent: { handle: "ada-two", webhook_configured: true } });

    const sentOne = await api(LOCAL, ada.token, "/api/v1/messages", { method: "POST", body: { click: "alpha-team", to: bobHandle, text: "hi from alpha" } });
    expect(sentOne.body).toMatchObject({ click: one.click_id, recipients: [bobHandle] });
    const sentTwo = await api(LOCAL, ada.token, "/api/v1/messages", { method: "POST", clickId: two.click_id, body: { to: carolHandle, text: "hi from beta" } });
    expect(sentTwo.body).toMatchObject({ click: two.click_id, recipients: [carolHandle] });

    await api(LOCAL, carol.token, "/api/v1/messages", { method: "POST", body: { to: "ada-two", text: "reply in beta" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ring = captured.find((row) => row.url === "https://hooks.test/ada-two");
    expect(ring).toMatchObject({ type: "click.doorbell", agent: "ada-two", click: two.click_id, click_name: "Beta" });

    const inboxTwo = (await api(LOCAL, ada.token, "/api/v1/inbox?click=Beta")).body as { click: string; messages: Array<{ id: string; text: string }> };
    expect(inboxTwo.click).toBe(two.click_id);
    expect(inboxTwo.messages.map((row) => row.text)).toEqual(["reply in beta"]);
    const inboxOne = (await api(LOCAL, ada.token, `/api/v1/inbox?click=${one.click_id}`)).body as { messages: unknown[] };
    expect(inboxOne.messages).toEqual([]);
    const acked = await api(LOCAL, ada.token, "/api/v1/ack", { method: "POST", body: { click: two.click_id, ids: inboxTwo.messages.map((row) => row.id) } });
    expect(acked.body).toMatchObject({ missing: [] });

    const unknown = await api(LOCAL, ada.token, "/api/v1/inbox?click=gamma");
    expect((unknown.body as Problem).detail).toMatch(/not in a click called gamma/);
    expect((await joinHttp((await invite(two.click_key)).invite, ada.token)).body).toMatchObject({ detail: expect.stringMatching(/already in that click/) });

    // Leaving the second click keeps the token working in its home click.
    expect((await api(LOCAL, ada.token, `/api/v1/agents/me?click=${two.click_id}`, { method: "DELETE" })).status).toBe(200);
    const after = (await api(LOCAL, ada.token, "/api/v1/clicks")).body as { clicks: Array<{ click_id: string }> };
    expect(after.clicks.map((row) => row.click_id)).toEqual([one.click_id]);
    expect((await api(LOCAL, ada.token, "/api/v1/inbox")).status).toBe(200);
  });

  it("keeps a token alive in its other click when its home click is deleted", async () => {
    const home = await createClick();
    const other = await createClick();
    const minted = (await api(LOCAL, home.click_key, "/api/v1/tokens", { method: "POST", body: { handle: handle("dan") } })).body as { token: string };
    await joinHttp((await invite(other.click_key)).invite, minted.token);
    expect((await api(LOCAL, home.click_key, "/api/v1/clicks", { method: "DELETE" })).status).toBe(200);
    const clicks = (await api(LOCAL, minted.token, "/api/v1/clicks")).body as { clicks: Array<{ click_id: string }> };
    expect(clicks.clicks.map((row) => row.click_id)).toEqual([other.click_id]);
    expect((await api(LOCAL, minted.token, "/api/v1/agents", { method: "POST", body: { handle: handle("dan") } })).status).toBe(200);
    expect((await api(LOCAL, home.click_key, "/api/v1/me")).status).toBe(401);
  });

  it("lets one OAuth connection join a second click and pick it with click", async () => {
    const one = await createClick();
    const two = await createClick(LOCAL, { name: "Second" });
    const token = await signIn(LOCAL, { key: (await invite(one.click_key)).invite });
    await initialize(LOCAL, token);
    await callTool(LOCAL, token, "register", { handle: handle("eve") });
    const joined = await callTool(LOCAL, token, "join_click", { invite: (await invite(two.click_key)).invite }) as { click_id: string };
    expect(joined.click_id).toBe(two.click_id);
    const listed = await callTool(LOCAL, token, "list_clicks") as { clicks: Array<{ click_id: string }> };
    expect(listed.clicks).toHaveLength(2);
    expect(await callTool(LOCAL, token, "inbox")).toMatchObject({ messages: [] });
    const eveTwo = handle("eve");
    await callTool(LOCAL, token, "register", { handle: eveTwo, click: "Second" });
    const frank = (await api(LOCAL, two.click_key, "/api/v1/tokens", { method: "POST", body: { handle: handle("frank") } })).body as { token: string };
    await api(LOCAL, frank.token, "/api/v1/messages", { method: "POST", body: { to: eveTwo, text: "over mcp" } });
    const inbox = await callTool(LOCAL, token, "inbox", { click: two.click_id }) as { click: string; messages: Array<{ text: string }> };
    expect(inbox.click).toBe(two.click_id);
    expect(inbox.messages.map((row) => row.text)).toEqual(["over mcp"]);
    expect(await callTool(LOCAL, token, "whoami", { click: one.click_id })).toMatchObject({ click_id: one.click_id, role: "member" });
  });

  it("adds a click created by a signed-in agent to that agent's memberships", async () => {
    const home = await createClick();
    await initialize(LOCAL, home.click_key);
    const email = testEmail();
    const started = await callTool(LOCAL, home.click_key, "create_click", { email, name: "Made by tool" }) as { pending_id: string; status: string };
    expect(started.status).toBe("verification_sent");
    const verified = await callTool(LOCAL, home.click_key, "verify_click", { pending_id: started.pending_id, code: lastCode(email) }) as { click_id: string; click_key: string };
    expect(verified.click_key.startsWith("clk_")).toBe(true);
    const listed = await callTool(LOCAL, home.click_key, "list_clicks") as { clicks: Array<{ click_id: string; role: string }> };
    expect(listed.clicks.find((row) => row.click_id === verified.click_id)).toMatchObject({ role: "admin" });
    expect(await callTool(LOCAL, home.click_key, "rename_click", { click: verified.click_id, name: "Renamed" })).toEqual({ click_id: verified.click_id, name: "Renamed" });
    expect(await callTool(LOCAL, home.click_key, "whoami", { click: "renamed" })).toMatchObject({ click_id: verified.click_id, click_name: "Renamed" });
  });
});
