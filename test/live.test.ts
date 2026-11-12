import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { doorbellBody, postDoorbell, standardSignature, verifyStandardSignature } from "../src/webhook";
import { callTool, createClick, handle, initialize, lastCode, LOCAL, startCreate, testEmail, verifyCreate } from "./helpers";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("credential wording", () => {
  it("says which credential is for what, and never names a password manager", async () => {
    const email = testEmail();
    const started = await startCreate(LOCAL, email);
    const verified = (await verifyCreate(LOCAL, String(started.body.pending_id), lastCode(email))).body as { message_for_person: string; admin_key: { instruction: string }; first_invite: { instruction: string } };
    expect(verified.message_for_person).toContain("Three things, three jobs");
    expect(verified.message_for_person).toContain("works for up to 10 agents");
    expect(verified.message_for_person).toContain("no agent joins with it");
    expect(verified.admin_key.instruction).toContain("already in the click as its admin");
    expect(verified.first_invite.instruction).toContain("each new agent");
    expect(JSON.stringify(verified)).not.toMatch(/only this once|shown once|1password|password manager/i);
  });

  it("keeps admin-key sign-in behind Recover a click", async () => {
    const page = await SELF.fetch(`${LOCAL}/`);
    const html = await page.text();
    expect(html).toContain("Create a Click, invite your agents, and they talk directly.");
    expect(html).not.toMatch(/share a key|Hand the key|One tool call makes/);
  });
});

describe("doorbell headers", () => {
  it("adds Standard Webhooks headers and a text field next to the Bearer header and HMAC", async () => {
    let headers = new Headers();
    let body = "";
    const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      body = String(init?.body ?? "");
      return new Response("ok");
    }) as typeof fetch;
    const outcome = await postDoorbell({ handle: "ada", pending: 2, url: "https://hooks.test/ring", key: "plain-key", deliveryId: "d1", clickName: "Team" }, fake);
    expect(outcome).toEqual({ ok: true });
    expect(headers.get("authorization")).toBe("Bearer plain-key");
    expect(headers.get("x-click-signature")).toMatch(/^v1=/);
    expect(headers.get("webhook-id")).toBe("msg_d1");
    expect(headers.get("webhook-signature")).toMatch(/^v1,/);
    expect(headers.get("anthropic-version")).toBeNull();
    expect(await verifyStandardSignature({ secret: "plain-key", id: "msg_d1", timestamp: headers.get("webhook-timestamp") ?? "", body, signature: headers.get("webhook-signature") ?? "" })).toBe(true);
    expect(JSON.parse(body).text).toMatch(/ada has 2 unread messages in Team/);
  });

  it("sends anthropic-version to Claude Code's routine fire endpoint", async () => {
    let headers = new Headers();
    const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response("ok");
    }) as typeof fetch;
    await postDoorbell({ handle: "ada", pending: 1, url: "https://api.anthropic.com/v1/claude_code/routines/trig_1/fire", key: "k" }, fake);
    expect(headers.get("anthropic-version")).toBeTruthy();
  });

  it("decodes whsec_ secrets", async () => {
    const secret = `whsec_${btoa("0123456789abcdef01234567")}`;
    const signature = await standardSignature(secret, "msg_1", "1700000000", "{}");
    expect(await verifyStandardSignature({ secret, id: "msg_1", timestamp: "1700000000", body: "{}", signature, now: 1_700_000_000_000 })).toBe(true);
    expect(doorbellBody({ handle: "a", pending: 1 })).toContain("1 unread message");
  });
});

describe("wait_for_message", () => {
  it("returns as soon as a message is sent, across clicks, over MCP and HTTP", async () => {
    const created = await createClick();
    await initialize(LOCAL, created.click_key);
    const ada = await callTool(LOCAL, created.click_key, "mint_token", { handle: handle("ada") }) as { token: string; handle?: string };
    const graceHandle = handle("grace");
    const grace = await callTool(LOCAL, created.click_key, "mint_token", { handle: graceHandle }) as { token: string };
    await initialize(LOCAL, ada.token);
    await initialize(LOCAL, grace.token);

    const empty = await callTool(LOCAL, grace.token, "wait_for_message", { seconds: 0 }) as { messages: unknown[]; timed_out: boolean };
    expect(empty).toMatchObject({ messages: [], timed_out: true });

    const started = Date.now();
    const waiting = callTool(LOCAL, grace.token, "wait_for_message", { seconds: 20 }) as Promise<{ messages: Array<{ text: string }>; timed_out: boolean }>;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await callTool(LOCAL, ada.token, "send", { to: graceHandle, text: "ping" });
    const got = await waiting;
    expect(got.messages.map((message) => message.text)).toEqual(["ping"]);
    expect(got.timed_out).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);

    const http = await SELF.fetch(`${LOCAL}/api/v1/inbox?wait=5`, { headers: { authorization: `Bearer ${grace.token}` } });
    const body = await http.json() as { messages: Array<{ text: string }>; waited_ms: number };
    expect(body.messages.map((message) => message.text)).toEqual(["ping"]);
    expect(body.waited_ms).toBeLessThan(1_000);
  });
});
