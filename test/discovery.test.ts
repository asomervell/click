import { SELF, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHub } from "../src/hub";
import { callTool, createClick, handle, initialize, LOCAL, parseMcp } from "./helpers";

/** ChatGPT-style MCP 2.0 (2026-07-28) requests: no initialize, version and identity in headers and _meta. */
const MODERN = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "openai-mcp", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function modern(token: string, method: string, params: Record<string, unknown> = {}, id = 1) {
  const response = await SELF.fetch(`${LOCAL}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      host: new URL(LOCAL).host,
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } }),
  });
  return parseMcp(response);
}

async function agent() {
  const created = await createClick();
  await initialize(LOCAL, created.click_key);
  const dotHandle = handle("dot");
  const minted = (await callTool(LOCAL, created.click_key, "mint_token", { handle: dotHandle })) as { token: string };
  const peer = (await callTool(LOCAL, created.click_key, "mint_token", { handle: handle("peer") })) as { token: string };
  return { clickId: created.click_id, peer: peer.token, token: minted.token, dotHandle };
}

describe("MCP 2.0 discovery (ChatGPT, dots)", () => {
  it("advertises events on server/discover", async () => {
    const { token } = await agent();
    const discover = await modern(token, "server/discover");
    expect(discover.status).toBe(200);
    const result = discover.body.result as { supportedVersions: string[]; capabilities: Record<string, unknown>; instructions?: string };
    expect(result.supportedVersions).toContain(MODERN);
    expect(result.capabilities.events).toEqual({});
    expect(result.capabilities.tools).toBeDefined();
    expect(result.instructions).toContain("Click");
  });

  it("serves tools/list and events/list under 2026-07-28", async () => {
    const { token } = await agent();
    const tools = await modern(token, "tools/list");
    expect(tools.status).toBe(200);
    expect((tools.body.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toContain("inbox");
    const list = await modern(token, "events/list");
    const result = list.body.result as { resultType: string; events: Array<{ name: string; delivery: string[]; inputSchema: unknown; payloadSchema: unknown }>; _meta: Record<string, { name: string }> };
    expect(result.resultType).toBe("complete");
    expect(result._meta["io.modelcontextprotocol/serverInfo"]!.name).toBe("click");
    expect(result.events.map((event) => event.name)).toEqual(["message.received"]);
    expect(result.events[0]!.delivery).toEqual(["webhook"]);
    expect(result.events[0]!.inputSchema).toBeTypeOf("object");
    expect(result.events[0]!.payloadSchema).toBeTypeOf("object");
  });

  it("subscribes, delivers, and unsubscribes under 2026-07-28, logging each step without secrets", async () => {
    const lines: string[] = [];
    for (const level of ["log", "warn", "error"] as const) {
      const original = console[level].bind(console);
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
        original(...args);
      });
    }
    const hits: Array<{ headers: Headers; body: string }> = [];
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://events.test/")) return originalFetch(input, init);
      const body = String(init?.body ?? "");
      hits.push({ headers: new Headers(init?.headers), body });
      const parsed = JSON.parse(body) as { type?: string; challenge?: string };
      return parsed.type === "verification" ? Response.json({ challenge: parsed.challenge }) : new Response("ok");
    };
    const { clickId, peer, token, dotHandle } = await agent();
    const delivery = { mode: "webhook", url: "https://events.test/cb/private-path", secret: SECRET };
    const sub = await modern(token, "events/subscribe", { name: "message.received", arguments: {}, delivery, cursor: null });
    const result = sub.body.result as { resultType: string; id: string; refreshBefore: string; cursor: null; truncated: boolean };
    expect(result.resultType).toBe("complete");
    expect(result.id).toMatch(/^sub_/);
    expect(result.cursor).toBeNull();
    expect(result.truncated).toBe(false);

    await callTool(LOCAL, peer, "send", { to: dotHandle, text: "hello dot" });
    for (let i = 0; i < 3; i++) await runDurableObjectAlarm(getHub(env, clickId));
    const event = hits.map((hit) => JSON.parse(hit.body) as { name?: string; data?: { text: string } }).find((body) => body.name === "message.received");
    expect(event?.data?.text).toBe("hello dot");

    const gone = await modern(token, "events/unsubscribe", { name: "message.received", arguments: {}, delivery: { mode: "webhook", url: delivery.url } });
    expect(gone.body.result).toMatchObject({ resultType: "complete" });

    const events = lines.filter((line) => line.includes('"mcp_event"')).map((line) => JSON.parse(line) as { stage: string; ok?: boolean });
    const stages = events.map((line) => line.stage);
    for (const stage of ["subscribe", "verify", "subscribed", "deliver", "unsubscribe"]) expect(stages).toContain(stage);
    expect(events.find((line) => line.stage === "deliver")?.ok).toBe(true);
    const joined = lines.join("\n");
    expect(joined).not.toContain(SECRET);
    expect(joined).not.toContain("private-path");
    expect(joined).not.toContain("hello dot");
  });

  it("logs a failed verification with its reason", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://events.test/")) return originalFetch(input, init);
      return Response.json({ challenge: "wrong" });
    };
    const { token } = await agent();
    const sub = await modern(token, "events/subscribe", { name: "message.received", arguments: {}, delivery: { mode: "webhook", url: "https://events.test/bad", secret: SECRET } });
    expect((sub.body.error as { code: number }).code).toBe(-32015);
    const verify = lines.map((line) => JSON.parse(line) as { stage: string; ok: boolean; reason?: string }).find((line) => line.stage === "verify");
    expect(verify).toMatchObject({ ok: false, reason: "challenge_failed" });
  });

  it("keeps 2025 clients unchanged", async () => {
    const { token } = await agent();
    const response = await SELF.fetch(`${LOCAL}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", host: new URL(LOCAL).host },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/list", params: {} }),
    });
    const parsed = await parseMcp(response);
    const result = parsed.body.result as Record<string, unknown>;
    expect(result.resultType).toBeUndefined();
    expect((result.events as Array<{ name: string }>)[0]!.name).toBe("message.received");
  });
});
