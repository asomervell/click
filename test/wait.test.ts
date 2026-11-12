import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { api, createClick, handle, LOCAL } from "./helpers";
import { nappingCount, nudgeWaiters, pollUntil } from "../src/wait";

describe("worker-side wait", () => {
  it("polls with backoff and gives up at the deadline", async () => {
    let calls = 0;
    const started = Date.now();
    const got = await pollUntil(async () => { calls += 1; return false; }, 300, ["c"], { first: 40, max: 80 });
    expect(got).toBe(false);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(1_000);
    // 0, 40, 100, 180, 260, 300: a handful of checks, not a busy loop.
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(calls).toBeLessThanOrEqual(8);
    expect(nappingCount()).toBe(0);
  });

  it("returns at once when mail is already there, and with zero wait checks once", async () => {
    let calls = 0;
    expect(await pollUntil(async () => { calls += 1; return true; }, 50_000, ["c"])).toBe(true);
    expect(calls).toBe(1);
    expect(await pollUntil(async () => false, 0, ["c"])).toBe(false);
  });

  it("wakes early when a send on the same click nudges it", async () => {
    let ready = false;
    const started = Date.now();
    const waiting = pollUntil(async () => ready, 20_000, ["one"], { first: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    ready = true;
    nudgeWaiters("other");
    expect(nappingCount()).toBe(1);
    nudgeWaiters("one");
    expect(await waiting).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(nappingCount()).toBe(0);
  });

  it("still finds mail delivered without a nudge (another isolate) at the next poll", async () => {
    const created = await createClick();
    const adaHandle = handle("ada");
    const graceHandle = handle("grace");
    const ada = (await api(LOCAL, created.click_key, "/api/v1/tokens", { method: "POST", body: { handle: adaHandle } })).body as { token: string; principal_id: string };
    const grace = (await api(LOCAL, created.click_key, "/api/v1/tokens", { method: "POST", body: { handle: graceHandle } })).body as { token: string };
    const started = Date.now();
    const waiting = SELF.fetch(`${LOCAL}/api/v1/inbox?wait=20`, { headers: { authorization: `Bearer ${grace.token}` } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Straight to the hub, as a send handled by another isolate would land.
    await env.CLICK.getByName(created.click_id).send({ principalId: ada.principal_id, clickId: created.click_id, role: "member" }, { to: graceHandle, text: "direct" });
    const body = await (await waiting).json() as { messages: Array<{ text: string }>; timed_out: boolean; waited_ms: number };
    expect(body.messages.map((message) => message.text)).toEqual(["direct"]);
    expect(body.timed_out).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("times out with the same shape as before", async () => {
    const created = await createClick();
    const grace = (await api(LOCAL, created.click_key, "/api/v1/tokens", { method: "POST", body: { handle: handle("quiet") } })).body as { token: string };
    const response = await SELF.fetch(`${LOCAL}/api/v1/inbox?wait=1`, { headers: { authorization: `Bearer ${grace.token}` } });
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ messages: [], next_cursor: null, timed_out: true });
    expect(body.waited_ms as number).toBeGreaterThanOrEqual(950);
    expect(body.waited_ms as number).toBeLessThan(2_500);
  });
});
