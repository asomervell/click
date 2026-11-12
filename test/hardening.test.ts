import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { api, createClick, handle } from "./helpers";

const ORIGIN = "https://clickmcp.com";

describe("edge hardening", () => {
  it("redirects plain http to https with 308, keeping path and query", async () => {
    const response = await SELF.fetch("http://clickmcp.com/docs?x=1", { redirect: "manual" });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://clickmcp.com/docs?x=1");
    const post = await SELF.fetch("http://clickmcp.com/api/v1/clicks/join", { method: "POST", body: "{}", redirect: "manual" });
    expect(post.status).toBe(308);
  });

  it("leaves loopback http alone for local dev", async () => {
    const response = await SELF.fetch("http://127.0.0.1/health", { redirect: "manual" });
    expect(response.status).not.toBe(308);
  });

  it("refuses a non-form POST to /authorize with 415, not 500", async () => {
    for (const headers of [{ "content-type": "application/json" }, {}] as Array<Record<string, string>>) {
      const response = await SELF.fetch(`${ORIGIN}/authorize`, { method: "POST", headers: { ...headers, origin: ORIGIN }, body: "{}" });
      expect(response.status).toBe(415);
    }
  });

  it("answers GET and DELETE /mcp with 405 without building the server", async () => {
    const click = await createClick();
    for (const method of ["GET", "DELETE"]) {
      const response = await SELF.fetch(`${ORIGIN}/mcp`, { method, headers: { host: "clickmcp.com", authorization: `Bearer ${click.click_key}`, accept: "text/event-stream" } });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST, OPTIONS");
      expect(await response.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
    }
    const tokenless = await SELF.fetch(`${ORIGIN}/mcp`);
    expect(tokenless.status).toBe(401);
  });

  it("maps a second register with another handle to 409", async () => {
    const click = await createClick();
    const first = handle("a");
    expect((await api(ORIGIN, click.click_key, "/api/v1/agents", { method: "POST", body: { handle: first } })).status).toBe(200);
    const again = await api(ORIGIN, click.click_key, "/api/v1/agents", { method: "POST", body: { handle: `${first}x` } });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain("already registered");
  });

  it("serves an API index and the common agent guesses", async () => {
    for (const path of ["/api", "/api/v1"]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`);
      expect([path, response.status]).toEqual([path, 200]);
      expect(await response.json()).toMatchObject({ openapi: `${ORIGIN}/openapi.json`, docs: `${ORIGIN}/docs.md` });
    }
    for (const path of ["/.well-known/mcp.json", "/mcp.json"]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`);
      expect([path, response.status]).toEqual([path, 200]);
      expect(await response.json()).toHaveProperty("serverInfo");
    }
    for (const path of ["/index.md", "/.well-known/llms.txt"]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`);
      expect([path, response.status]).toEqual([path, 200]);
      expect(response.headers.get("content-type")).toContain("text/markdown");
    }
  });
});

describe("per-isolate caches", () => {
  it("serves tools/list from the cache with the caller's id and the SDK's framing", async () => {
    const { mcpCall } = await import("./helpers");
    const click = await createClick();
    const first = await mcpCall(ORIGIN, click.click_key, "tools/list", {}, 7);
    const second = await mcpCall(ORIGIN, click.click_key, "tools/list", {}, "abc" as unknown as number);
    expect(first.id).toBe(7);
    expect(second.id).toBe("abc");
    expect(second.result).toEqual(first.result);
    const names = ((second.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names).toContain("wait_for_message");
    expect(names).toContain("send");
  });

  it("builds the home page once and serves it the same way again", async () => {
    const a = await (await SELF.fetch(`${ORIGIN}/`)).text();
    const b = await (await SELF.fetch(`${ORIGIN}/`)).text();
    expect(b).toBe(a);
    const md = await SELF.fetch(`${ORIGIN}/`, { headers: { accept: "text/markdown" } });
    expect(md.headers.get("content-type")).toContain("text/markdown");
  });
});
