import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { getHub } from "../src/hub";
import { verifyStandardSignature } from "../src/webhook";
import { callTool, createClick, handle, initialize, LOCAL, mcpCall } from "./helpers";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;
type Hit = { url: string; headers: Headers; body: string };

/** A mock MCP Events receiver: echoes verification challenges, records events, replies with status(). */
function mockReceiver(status: (hit: Hit) => number = () => 200): Hit[] {
  const hits: Hit[] = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://events.test/")) return originalFetch(input, init);
    const hit = { url, headers: new Headers(init?.headers), body: String(init?.body ?? "") };
    hits.push(hit);
    const parsed = JSON.parse(hit.body) as { type?: string; challenge?: string };
    if (parsed.type === "verification") {
      if (url.endsWith("/wrong")) return Response.json({ challenge: "nope" });
      return Response.json({ challenge: parsed.challenge });
    }
    return new Response("ok", { status: status(hit) });
  };
  return hits;
}

async function pair() {
  const created = await createClick();
  await initialize(LOCAL, created.click_key);
  const adaHandle = handle("ada");
  const graceHandle = handle("grace");
  const ada = (await callTool(LOCAL, created.click_key, "mint_token", { handle: adaHandle })) as { token: string };
  const grace = (await callTool(LOCAL, created.click_key, "mint_token", { handle: graceHandle })) as { token: string };
  await initialize(LOCAL, ada.token);
  await initialize(LOCAL, grace.token);
  return { clickId: created.click_id, ada: ada.token, grace: grace.token, adaHandle, graceHandle };
}

function subscribeParams(url: string, extra: Record<string, unknown> = {}) {
  return { name: "message.received", arguments: {}, delivery: { mode: "webhook", url, secret: SECRET }, ...extra };
}

async function drain(clickId: string): Promise<void> {
  for (let i = 0; i < 3; i++) await runDurableObjectAlarm(getHub(env, clickId));
}

describe("MCP Events", () => {
  it("advertises events and lists message.received", async () => {
    const { grace } = await pair();
    const init = await mcpCall(LOCAL, grace, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect((init.result as { capabilities: Record<string, unknown> }).capabilities.events).toEqual({});
    const list = await mcpCall(LOCAL, grace, "events/list", {});
    const events = (list.result as { events: Array<{ name: string; delivery: string[] }> }).events;
    expect(events.map((event) => event.name)).toEqual(["message.received"]);
    expect(events[0]!.delivery).toEqual(["webhook"]);
  });

  it("verifies the callback, delivers signed events, and unsubscribes", async () => {
    const hits = mockReceiver();
    const { clickId, ada, grace, adaHandle, graceHandle } = await pair();
    const url = "https://events.test/cb";
    const sub = await mcpCall(LOCAL, grace, "events/subscribe", subscribeParams(url));
    const result = sub.result as { id: string; refreshBefore: string; cursor: null; truncated: boolean };
    expect(result.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(result.cursor).toBeNull();
    expect(result.truncated).toBe(false);
    expect(Date.parse(result.refreshBefore) - Date.now()).toBeGreaterThan(6 * 24 * 3600 * 1000);

    const verification = hits[0]!;
    expect(JSON.parse(verification.body).type).toBe("verification");
    expect(verification.headers.get("x-mcp-subscription-id")).toBe(result.id);
    expect(await verifyStandardSignature({
      secret: SECRET,
      id: verification.headers.get("webhook-id")!,
      timestamp: verification.headers.get("webhook-timestamp")!,
      body: verification.body,
      signature: verification.headers.get("webhook-signature")!,
    })).toBe(true);

    // Idempotent: same identity, same id, with key order not mattering.
    const again = await mcpCall(LOCAL, grace, "events/subscribe", { delivery: { secret: SECRET, url, mode: "webhook" }, arguments: {}, name: "message.received", ttlMs: 3_600_000 });
    expect((again.result as { id: string }).id).toBe(result.id);
    expect(Date.parse((again.result as { refreshBefore: string }).refreshBefore) - Date.now()).toBeLessThan(3_700_000);

    await callTool(LOCAL, ada, "send", { to: graceHandle, text: "hello events" });
    await drain(clickId);
    const events = hits.filter((hit) => !hit.body.includes('"verification"'));
    expect(events).toHaveLength(1);
    const event = JSON.parse(events[0]!.body) as { eventId: string; name: string; timestamp: string; data: Record<string, unknown>; cursor: null };
    expect(event.name).toBe("message.received");
    expect(events[0]!.headers.get("webhook-id")).toBe(event.eventId);
    expect(events[0]!.headers.get("x-mcp-subscription-id")).toBe(result.id);
    expect(event.data).toMatchObject({ click: clickId, from: adaHandle, to: graceHandle, kind: "dm", text: "hello events", truncated: false });
    expect(await verifyStandardSignature({
      secret: SECRET,
      id: event.eventId,
      timestamp: events[0]!.headers.get("webhook-timestamp")!,
      body: events[0]!.body,
      signature: events[0]!.headers.get("webhook-signature")!,
    })).toBe(true);

    // The message_id works with ack.
    await callTool(LOCAL, grace, "ack", { ids: [event.data.message_id] });

    const off = await mcpCall(LOCAL, grace, "events/unsubscribe", { name: "message.received", arguments: {}, delivery: { mode: "webhook", url } });
    expect(off.result).toEqual({});
    await callTool(LOCAL, ada, "send", { to: graceHandle, text: "after unsubscribe" });
    await drain(clickId);
    expect(hits.filter((hit) => hit.body.includes("after unsubscribe"))).toHaveLength(0);
  });

  it("rejects a callback that does not echo the challenge, and a bad secret", async () => {
    mockReceiver();
    const { grace } = await pair();
    const wrong = await mcpCall(LOCAL, grace, "events/subscribe", subscribeParams("https://events.test/wrong"));
    expect((wrong.error as { code: number; data: { reason: string } }).code).toBe(-32015);
    expect((wrong.error as { data: { reason: string } }).data.reason).toBe("challenge_failed");
    const bad = await mcpCall(LOCAL, grace, "events/subscribe", { ...subscribeParams("https://events.test/cb"), delivery: { mode: "webhook", url: "https://events.test/cb", secret: "whsec_c2hvcnQ=" } });
    expect((bad.error as { code: number }).code).toBe(-32602);
    const http = await mcpCall(LOCAL, grace, "events/subscribe", subscribeParams("http://events.test/cb"));
    expect((http.error as { code: number }).code).toBe(-32602);
  });

  it("retries with the same eventId, and stops on 410", async () => {
    let fail = 2;
    const hits = mockReceiver(() => (fail-- > 0 ? 503 : 200));
    const { clickId, ada, grace, graceHandle } = await pair();
    await mcpCall(LOCAL, grace, "events/subscribe", subscribeParams("https://events.test/retry"));
    await callTool(LOCAL, ada, "send", { to: graceHandle, text: "retry me" });
    const hub = getHub(env, clickId);
    await hub.processWakes(Date.now());
    await hub.processWakes(Date.now() + 10_000);
    await hub.processWakes(Date.now() + 60_000);
    const attempts = hits.filter((hit) => hit.body.includes("retry me"));
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((hit) => hit.headers.get("webhook-id"))).size).toBe(1);
    expect((await hub.eventDeliveryStates()).at(-1)).toMatchObject({ status: "delivered", attempts: 3 });

    const goneHits = mockReceiver(() => 410);
    await callTool(LOCAL, ada, "send", { to: graceHandle, text: "gone" });
    await hub.processWakes(Date.now());
    await callTool(LOCAL, ada, "send", { to: graceHandle, text: "after gone" });
    await hub.processWakes(Date.now() + 3_600_000);
    expect(goneHits.filter((hit) => hit.body.includes("after gone"))).toHaveLength(0);
    expect(goneHits.filter((hit) => hit.body.includes('"gone"'))).toHaveLength(1);
  });

  it("filters by click and only delivers to the subscriber", async () => {
    const hits = mockReceiver();
    const { clickId, ada, grace, adaHandle, graceHandle } = await pair();
    await mcpCall(LOCAL, grace, "events/subscribe", { ...subscribeParams("https://events.test/filter"), arguments: { click: clickId } });
    await callTool(LOCAL, grace, "send", { to: adaHandle, text: "to ada" });
    await callTool(LOCAL, ada, "send", { to: graceHandle, text: "to grace" });
    await drain(clickId);
    const bodies = hits.filter((hit) => !hit.body.includes('"verification"')).map((hit) => JSON.parse(hit.body).data.text);
    expect(bodies).toEqual(["to grace"]);
    const unknown = await mcpCall(LOCAL, grace, "events/subscribe", { ...subscribeParams("https://events.test/filter"), arguments: { project: "x" } });
    expect((unknown.error as { code: number }).code).toBe(-32602);
  });
});
