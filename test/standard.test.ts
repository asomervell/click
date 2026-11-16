import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { EVENT_NOTICE, redactEventBody } from "../src/events";
import { getHub, type ClickHub } from "../src/hub";
import { api, callTool, createClick, handle, initialize, LOCAL, mcpCall } from "./helpers";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;

/** Echo verification challenges, record every POST, and fail real events so their rows stay queued. */
function failingReceiver(): string[] {
  const bodies: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://std.test/")) return originalFetch(input, init);
    const body = String(init?.body ?? "");
    bodies.push(body);
    const parsed = JSON.parse(body) as { type?: string; challenge?: string };
    if (parsed.type === "verification") return Response.json({ challenge: parsed.challenge });
    return new Response("nope", { status: 500 });
  };
  return bodies;
}

function sql<T>(hub: ClickHub, query: string): T[] {
  return (hub as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(query).toArray() as T[];
}

describe("Standard tier", () => {
  it("never puts message text in MCP Events, stored event rows, or doorbells", async () => {
    const posts = failingReceiver();
    const created = await createClick();
    await initialize(LOCAL, created.click_key);
    const adaHandle = handle("ada");
    const graceHandle = handle("grace");
    const ada = (await callTool(LOCAL, created.click_key, "mint_token", { handle: adaHandle })) as { token: string };
    const grace = (await callTool(LOCAL, created.click_key, "mint_token", { handle: graceHandle })) as { token: string };
    await initialize(LOCAL, ada.token);
    await initialize(LOCAL, grace.token);
    await callTool(LOCAL, grace.token, "update_profile", { webhook_url: "https://std.test/doorbell", webhook_key: "k".repeat(32) });
    const sub = await mcpCall(LOCAL, grace.token, "events/subscribe", { name: "message.received", arguments: {}, delivery: { mode: "webhook", url: "https://std.test/events", secret: SECRET } });
    expect(sub.error).toBeUndefined();

    const secretText = `standard-tier-secret-${crypto.randomUUID()}`;
    await callTool(LOCAL, ada.token, "send", { to: graceHandle, text: secretText });
    const hub = getHub(env, created.click_id);
    const stored = await runInDurableObject(hub, (instance) => sql<{ body: string }>(instance, "SELECT body FROM event_deliveries"));
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored) {
      expect(row.body).not.toContain(secretText);
      expect(JSON.parse(row.body).data.text).toBe(EVENT_NOTICE);
    }
    await runDurableObjectAlarm(hub);
    const delivered = posts.filter((body) => !body.includes('"verification"'));
    expect(delivered.length).toBeGreaterThanOrEqual(2);
    for (const body of delivered) expect(body).not.toContain(secretText);

    // The message itself is still in the inbox.
    const inbox = (await callTool(LOCAL, grace.token, "inbox")) as { messages: Array<{ text: string }> };
    expect(inbox.messages.some((message) => message.text === secretText)).toBe(true);
  });

  it("keeps only the admin key hash: no show_key, no GET /api/v1/key, rotate shows the new key once", async () => {
    const created = await createClick();
    await initialize(LOCAL, created.click_key);
    const tools = await mcpCall(LOCAL, created.click_key, "tools/list", {});
    const names = ((tools.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names).not.toContain("show_key");
    expect(names).toContain("rotate_key");

    const read = await api(LOCAL, created.click_key, "/api/v1/key");
    expect(read.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(read.body)).not.toContain(created.click_key);

    const hub = getHub(env, created.click_id);
    const meta = await runInDurableObject(hub, (instance) => sql<{ click_key: string }>(instance, "SELECT click_key FROM click_meta"));
    expect(meta[0]?.click_key).toBe("");

    const rotated = (await callTool(LOCAL, created.click_key, "rotate_key")) as { click_key: string; notice: string };
    expect(rotated.click_key.startsWith("clk_")).toBe(true);
    expect(rotated.notice).toContain("If you lose it, you lose the Click.");
    expect(rotated.notice).not.toMatch(/1password|password manager/i);
    const old = await api(LOCAL, created.click_key, "/api/v1/me");
    expect(old.status).toBe(401);
    const fresh = await api(LOCAL, rotated.click_key, "/api/v1/me");
    expect(fresh.status).toBe(200);
    const after = await runInDurableObject(hub, (instance) => sql<{ click_key: string }>(instance, "SELECT click_key FROM click_meta"));
    expect(after[0]?.click_key).toBe("");
  });

  it("wipes plaintext admin keys and queued event text left by older versions", async () => {
    const created = await createClick();
    const hub = getHub(env, created.click_id);
    await runInDurableObject(hub, (instance) => {
      const storage = (instance as unknown as { ctx: DurableObjectState }).ctx.storage;
      storage.sql.exec(`UPDATE click_meta SET click_key = 'clk_legacy_plaintext'`);
      storage.sql.exec(
        `INSERT INTO event_deliveries (id, sub_id, agent_id, body, status, attempts, next_at, created_at) VALUES ('evt_legacy', 'sub', 'agent', ?, 'queued', 0, 0, 0)`,
        JSON.stringify({ eventId: "evt_legacy", name: "message.received", data: { text: "legacy secret", truncated: false, from: "ada" } }),
      );
      (instance as unknown as { migrate(): void }).migrate();
      const meta = storage.sql.exec<{ click_key: string }>(`SELECT click_key FROM click_meta`).one();
      expect(meta.click_key).toBe("");
      const row = storage.sql.exec<{ body: string }>(`SELECT body FROM event_deliveries WHERE id = 'evt_legacy'`).one();
      expect(row.body).not.toContain("legacy secret");
      const data = JSON.parse(row.body).data;
      expect(data).toEqual({ text: EVENT_NOTICE, from: "ada" });
    });
  });

  it("redacts stored bodies and leaves unparseable ones alone", () => {
    expect(redactEventBody("not json")).toBe("not json");
    const clean = JSON.stringify({ data: { text: EVENT_NOTICE } });
    expect(redactEventBody(clean)).toBe(clean);
  });
});
