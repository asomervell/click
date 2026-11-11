import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { callTool, handle, initialize, LOCAL, OWNER_KEY, signIn } from "./helpers";

describe("auth", () => {
  it("advertises OAuth metadata for the request origin", async () => {
    const denied = await SELF.fetch("https://clickmcp.com/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(401);
    const challenge = denied.headers.get("www-authenticate") ?? "";
    const metadata = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(metadata).toBe("https://clickmcp.com/.well-known/oauth-protected-resource/mcp");
    const document = await SELF.fetch(metadata ?? "");
    const body = await document.json() as { resource?: string; authorization_servers?: string[] };
    expect(body.resource).toBe("https://clickmcp.com/mcp");
    expect(body.authorization_servers).toContain("https://clickmcp.com");

    const local = await SELF.fetch(`${LOCAL}/.well-known/oauth-protected-resource/mcp`);
    const localBody = await local.json() as { resource?: string; authorization_servers?: string[] };
    expect(localBody.resource).toBe(`${LOCAL}/mcp`);
    expect(localBody.authorization_servers).toContain(LOCAL);
  });

  it("accepts the owner key on the production host", async () => {
    await initialize("https://clickmcp.com", OWNER_KEY);
    const who = await callTool("https://clickmcp.com", OWNER_KEY, "whoami") as { role: string };
    expect(who.role).toBe("owner");
  });

  it("signs in with the owner key and registers an agent", async () => {
    const token = await signIn(LOCAL, OWNER_KEY);
    await initialize(LOCAL, token);
    const name = handle("ada");
    const profile = await callTool(LOCAL, token, "register", {
      handle: name,
      name: "Ada",
      description: "first agent",
    }) as { agent: { handle: string }; role: string };
    expect(profile.role).toBe("member");
    expect(profile.agent.handle).toBe(name);
  });

  it("rejects a bad key and accepts an invite once", async () => {
    const page = await SELF.fetch(`${LOCAL}/authorize?response_type=code&client_id=missing`, { redirect: "manual" });
    expect(page.status).toBeGreaterThanOrEqual(400);

    const owner = OWNER_KEY;
    await initialize(LOCAL, owner);
    const invite = await callTool(LOCAL, owner, "create_invite", { label: "guest" }) as { invite: string };
    const guest = await signIn(LOCAL, invite.invite);
    await initialize(LOCAL, guest);
    const who = await callTool(LOCAL, guest, "whoami") as { role: string; agent: null };
    expect(who.role).toBe("member");
    expect(who.agent).toBeNull();
    await expect(signIn(LOCAL, invite.invite)).rejects.toThrow(/not recognized|invite/i);
  });

  it("lets the owner key mint a bearer and keeps members from minting", async () => {
    await initialize(LOCAL, OWNER_KEY);
    const name = handle("claude");
    const minted = await callTool(LOCAL, OWNER_KEY, "mint_token", { label: "claude", handle: name }) as {
      token: string;
      handle: string;
    };
    expect(minted.handle).toBe(name);
    await initialize(LOCAL, minted.token);
    const who = await callTool(LOCAL, minted.token, "whoami") as { role: string; agent: { handle: string } };
    expect(who.role).toBe("member");
    expect(who.agent.handle).toBe(name);
    await expect(callTool(LOCAL, minted.token, "mint_token", {})).rejects.toThrow(/owner key/i);
    const denied = await SELF.fetch(`${LOCAL}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer not-a-real-token",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(denied.status).toBe(401);
  });

  it("mints a bearer token from the keys page", async () => {
    const name = handle("page");
    const form = new URLSearchParams();
    form.set("key", OWNER_KEY);
    form.set("action", "mint");
    form.set("handle", name);
    const response = await SELF.fetch(`${LOCAL}/keys`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: LOCAL,
        host: "127.0.0.1:8787",
      },
      body: form,
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("clk_");
    expect(html).not.toContain(OWNER_KEY);
  });
});
