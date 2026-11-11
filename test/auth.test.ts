import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { callTool, createClick, handle, initialize, LOCAL, OWNER_KEY, signIn } from "./helpers";

describe("auth", () => {
  it("advertises OAuth metadata for the request origin, including the bare path", async () => {
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

    const bare = await SELF.fetch("https://clickmcp.com/.well-known/oauth-protected-resource");
    const bareBody = await bare.json() as { resource?: string };
    expect(bare.status).toBe(200);
    expect(bareBody.resource).toBe("https://clickmcp.com/mcp");

    const local = await SELF.fetch(`${LOCAL}/.well-known/oauth-protected-resource/mcp`);
    const localBody = await local.json() as { resource?: string; authorization_servers?: string[] };
    expect(localBody.resource).toBe(`${LOCAL}/mcp`);
    expect(localBody.authorization_servers).toContain(LOCAL);
  });

  it("signs in by creating a click and registers an agent", async () => {
    const token = await signIn(LOCAL, { email: `ada-${crypto.randomUUID().slice(0, 8)}@example.com` });
    await initialize(LOCAL, token);
    const name = handle("ada");
    const profile = await callTool(LOCAL, token, "register", {
      handle: name,
      name: "Ada",
      description: "first agent",
    }) as { agent: { handle: string }; role: string; click_id: string };
    expect(profile.role).toBe("admin");
    expect(profile.agent.handle).toBe(name);
    expect(profile.click_id).toBeTruthy();
    const key = await callTool(LOCAL, token, "show_key") as { click_key: string };
    expect(key.click_key.startsWith("clk_")).toBe(true);
  });

  it("joins with an invite once", async () => {
    const created = await createClick();
    await initialize(LOCAL, created.click_key);
    const invite = await callTool(LOCAL, created.click_key, "create_invite", { label: "guest" }) as { invite: string };
    const guest = await signIn(LOCAL, { key: invite.invite });
    await initialize(LOCAL, guest);
    const who = await callTool(LOCAL, guest, "whoami") as { role: string; agent: null };
    expect(who.role).toBe("member");
    expect(who.agent).toBeNull();
    await expect(signIn(LOCAL, { key: invite.invite })).rejects.toThrow(/not recognized/i);
  });

  it("mints a bearer for a member and lets the optional owner key administer a click", async () => {
    const created = await createClick();
    await initialize(LOCAL, created.click_key);
    const name = handle("claude");
    const minted = await callTool(LOCAL, created.click_key, "mint_token", { label: "claude", handle: name }) as {
      token: string;
      handle: string;
    };
    expect(minted.handle).toBe(name);
    await initialize(LOCAL, minted.token);
    await expect(callTool(LOCAL, minted.token, "mint_token", {})).rejects.toThrow(/admin/i);

    await initialize("https://clickmcp.com", OWNER_KEY, created.click_id);
    const who = await callTool("https://clickmcp.com", OWNER_KEY, "whoami", {}, created.click_id) as { role: string };
    expect(who.role).toBe("operator");
  });

  it("serves the onboarding page and markdown", async () => {
    const page = await SELF.fetch(`${LOCAL}/`, { headers: { host: "127.0.0.1:8787" } });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("Onboard your agent");
    expect(page.headers.get("link") ?? "").toContain("api-catalog");
    const markdown = await SELF.fetch(`${LOCAL}/`, { headers: { accept: "text/markdown", host: "127.0.0.1:8787" } });
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(await markdown.text()).toContain("click key");
    const robots = await SELF.fetch(`${LOCAL}/robots.txt`);
    expect(await robots.text()).toContain("Content-Signal:");
  });
});
