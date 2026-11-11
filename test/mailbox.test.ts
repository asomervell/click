import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { verifyDoorbell } from "../src/webhook";
import { getHub } from "../src/hub";
import { parseWebhookUrl } from "../src/validate";
import { callTool, createClick, handle, initialize, LOCAL } from "./helpers";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("mailbox", () => {
  it("rejects private webhook URLs and allows localhost", () => {
    expect(parseWebhookUrl("https://example.com/hook").href).toBe("https://example.com/hook");
    expect(parseWebhookUrl("http://127.0.0.1:9797/hook").hostname).toBe("127.0.0.1");
    expect(() => parseWebhookUrl("http://example.com/hook")).toThrow(/https/);
    expect(() => parseWebhookUrl("https://10.1.2.3/hook")).toThrow(/public/);
    expect(() => parseWebhookUrl("https://user:pass@example.com/hook")).toThrow(/credentials/);
  });

  it("sends, reads, and acks between two agents", async () => {
    const adaHandle = handle("ada");
    const graceHandle = handle("grace");
    const created = await createClick();
    await initialize(LOCAL, created.click_key);
    const ada = await callTool(LOCAL, created.click_key, "mint_token", { handle: adaHandle }) as { token: string };
    const grace = await callTool(LOCAL, created.click_key, "mint_token", { handle: graceHandle }) as { token: string };
    await initialize(LOCAL, ada.token);
    await initialize(LOCAL, grace.token);
    const sent = await callTool(LOCAL, ada.token, "send", { to: graceHandle, text: "hello grace" }) as {
      event_id: string;
      recipients: string[];
    };
    expect(sent.recipients).toEqual([graceHandle]);
    const inbox = await callTool(LOCAL, grace.token, "inbox") as {
      messages: Array<{ id: string; from: string; text: string }>;
    };
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]?.from).toBe(adaHandle);
    expect(inbox.messages[0]?.text).toBe("hello grace");
    const acked = await callTool(LOCAL, grace.token, "ack", { ids: [inbox.messages[0]!.id] }) as {
      acked: string[];
    };
    expect(acked.acked).toEqual([inbox.messages[0]?.id]);
    const empty = await callTool(LOCAL, grace.token, "inbox") as { messages: unknown[] };
    expect(empty.messages).toEqual([]);
    const history = await callTool(LOCAL, ada.token, "history", { with: graceHandle }) as {
      events: Array<{ text: string }>;
    };
    expect(history.events[0]?.text).toBe("hello grace");
    expect(sent.event_id).toBeTruthy();
  });

  it("fans out topics and broadcasts", async () => {
    const adaHandle = handle("ada");
    const graceHandle = handle("grace");
    const topic = handle("ops");
    const created = await createClick();
    await initialize(LOCAL, created.click_key);
    const ada = await callTool(LOCAL, created.click_key, "mint_token", { handle: adaHandle }) as { token: string };
    const grace = await callTool(LOCAL, created.click_key, "mint_token", { handle: graceHandle }) as { token: string };
    await initialize(LOCAL, ada.token);
    await initialize(LOCAL, grace.token);
    await callTool(LOCAL, grace.token, "subscribe", { topic });
    const posted = await callTool(LOCAL, ada.token, "send", { topic, text: "deployed" }) as {
      recipients: string[];
    };
    expect(posted.recipients).toEqual([graceHandle]);
    await callTool(LOCAL, ada.token, "send", { broadcast: true, text: "everyone" });
    const inbox = await callTool(LOCAL, grace.token, "inbox") as { messages: Array<{ text: string }> };
    expect(inbox.messages.map((message) => message.text)).toEqual(["deployed", "everyone"]);
  });

  it("signs the doorbell and retries until it fails", async () => {
    const captured: Array<{ body: string; signature: string; timestamp: string; authorization: string }> = [];
    let status = 500;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://hooks.test/")) {
        const headers = new Headers(init?.headers);
        captured.push({
          body: String(init?.body ?? ""),
          signature: headers.get("x-click-signature") ?? "",
          timestamp: headers.get("x-click-timestamp") ?? "",
          authorization: headers.get("authorization") ?? "",
        });
        return new Response("nope", { status });
      }
      return originalFetch(input, init);
    };

    const adaHandle = handle("ada");
    const graceHandle = handle("grace");
    const created = await createClick();
    await initialize(LOCAL, created.click_key);
    const ada = await callTool(LOCAL, created.click_key, "mint_token", { handle: adaHandle }) as { token: string };
    const grace = await callTool(LOCAL, created.click_key, "mint_token", { handle: graceHandle }) as { token: string };
    await initialize(LOCAL, ada.token);
    await initialize(LOCAL, grace.token);
    await callTool(LOCAL, grace.token, "update_profile", {
      webhook_url: "https://hooks.test/ring",
      webhook_key: "super-secret-key",
    });
    await callTool(LOCAL, ada.token, "send", { to: graceHandle, text: "wake up" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captured.length).toBeGreaterThan(0);
    const first = captured[0]!;
    expect(first.authorization).toBe("Bearer super-secret-key");
    expect(JSON.parse(first.body)).toMatchObject({ type: "click.doorbell", agent: graceHandle, pending: 1 });
    expect(await verifyDoorbell({
      key: "super-secret-key",
      timestamp: first.timestamp,
      body: first.body,
      signature: first.signature,
    })).toBe(true);

    const hub = getHub(env, created.click_id);
    for (let attempt = 0; attempt < 6; attempt++) {
      await hub.processWakes(Date.now() + 86_400_000);
    }
    const statusReport = await callTool(LOCAL, ada.token, "delivery_status") as {
      deliveries: Array<{ status: string; attempts: number }>;
    };
    expect(statusReport.deliveries[0]?.status).toBe("failed");
    expect(statusReport.deliveries[0]?.attempts).toBe(5);

    status = 200;
    captured.length = 0;
    await callTool(LOCAL, ada.token, "send", { to: graceHandle, text: "again" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captured.length).toBeGreaterThan(0);
    const ok = await callTool(LOCAL, ada.token, "delivery_status") as {
      deliveries: Array<{ status: string; last_error: string | null }>;
    };
    expect(ok.deliveries.some((row) => row.status === "delivered")).toBe(true);
  });

  it("keeps registrations after the Durable Object is evicted", async () => {
    const created = await createClick();
    const hub = getHub(env, created.click_id);
    const name = handle("kept");
    await hub.register(
      { principalId: created.principal_id, clickId: created.click_id, role: "admin" },
      { handle: name, description: "still here" },
    );
    await evictDurableObject(hub);
    const agents = await hub.listAgents();
    expect(agents.map((agent) => agent.handle)).toContain(name);
    const alarmRan = await runDurableObjectAlarm(hub);
    expect(typeof alarmRan).toBe("boolean");
  });

  it("isolates clicks and lets an agent leave", async () => {
    const first = await createClick();
    const second = await createClick();
    const ada = handle("ada");
    const bob = handle("bob");
    await initialize(LOCAL, first.click_key);
    await initialize(LOCAL, second.click_key);
    await callTool(LOCAL, first.click_key, "register", { handle: ada });
    await callTool(LOCAL, first.click_key, "mint_token", { handle: bob });
    await callTool(LOCAL, first.click_key, "send", { to: bob, text: "secret" });
    await callTool(LOCAL, second.click_key, "register", { handle: ada });
    const otherAgents = await callTool(LOCAL, second.click_key, "list_agents") as Array<{ handle: string }>;
    expect(otherAgents.map((agent) => agent.handle)).toEqual([ada]);
    const left = await callTool(LOCAL, first.click_key, "leave") as { handle: string };
    expect(left.handle).toBe(ada);
    const remaining = await callTool(LOCAL, first.click_key, "list_agents") as Array<{ handle: string }>;
    expect(remaining.map((agent) => agent.handle)).not.toContain(ada);
    expect(remaining.map((agent) => agent.handle)).toContain(bob);
  });
});
