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
    expect(bareBody.resource).toBe("https://clickmcp.com");

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
    expect(html).toContain("<h1");
    expect(html).toContain('property="og:image"');
    expect(html).toContain("Organization");
    expect(html).toContain('href="/docs"');
  });

  it("serves auth.md, catalog, poppy, pages, and a markdown 404", async () => {
    const auth = await (await SELF.fetch(`${LOCAL}/auth.md`)).text();
    expect(auth.startsWith("# auth.md")).toBe(true);
    const catalog = await SELF.fetch(`${LOCAL}/.well-known/ai-catalog.json`);
    expect(catalog.headers.get("content-type")).toBe("application/json");
    const catalogBody = await catalog.json() as { host: { identifier: string }; entries: Array<{ identifier: string }> };
    expect(catalogBody.host.identifier).toContain("did:web:");
    expect(catalogBody.entries[0]?.identifier.startsWith("urn:air:")).toBe(true);
    const poppy = await (await SELF.fetch("https://clickmcp.com/.well-known/poppy.json")).json() as {
      protocol_version: string;
      organization: { name: string };
      auth: { issuer: string };
      agent: { protocols: Array<{ type: string; endpoint: string; access: string }> };
    };
    expect(poppy.protocol_version).toBe("0.3");
    expect(poppy.organization.name).toBe("Click");
    expect(poppy.auth.issuer).toBe("https://clickmcp.com");
    expect(poppy.agent.protocols.length).toBeGreaterThan(0);
    expect(poppy.agent.protocols[0]?.endpoint).toBe("https://clickmcp.com/poppy/conversations");
    expect(poppy.agent.protocols[0]?.access).toBe("session");
    const server = await (await SELF.fetch("https://clickmcp.com/.well-known/oauth-authorization-server")).json() as { agent_auth?: { skill?: string } };
    expect(server.agent_auth?.skill).toBe("https://clickmcp.com/auth.md");
    const docs = await (await SELF.fetch("https://clickmcp.com/docs")).text();
    expect(docs).toContain("<h2 id=\"quickstart\">");
    expect(docs).toContain("<h2 id=\"mcp-tools\">");
    expect(docs).toContain("<h2 id=\"http-api\">");
    expect(docs).toContain("<h2 id=\"webhooks\">");
    expect(docs).toContain("<h2 id=\"cli\">");
    expect(docs).toContain("<h2 id=\"auth\">");
    expect(docs.includes("<pre>${")).toBe(false);
    const docsMd = await SELF.fetch("https://clickmcp.com/docs", { headers: { accept: "text/markdown" } });
    expect(docsMd.headers.get("content-type")).toContain("text/markdown");
    expect(await docsMd.text()).toContain("## Quickstart");
    for (const path of ["/about", "/contact", "/privacy"]) {
      const text = await (await SELF.fetch(`${LOCAL}${path}`)).text();
      expect(text.length).toBeGreaterThan(500);
    }
    expect(await (await SELF.fetch(`${LOCAL}/contact`)).text()).toContain("https://github.com/asomervell/click/issues");
    const missing = await SELF.fetch(`${LOCAL}/missing-page`, { headers: { accept: "text/markdown" } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("text/markdown");
    const openapi = await (await SELF.fetch(`${LOCAL}/openapi.json`)).json() as { paths: Record<string, { get?: { responses: Record<string, unknown> } }> };
    expect(openapi.paths["/api/v1/inbox"]?.get?.responses["200"]).toBeTruthy();
    expect(openapi.paths["/api/v1/inbox"]?.get?.responses["429"]).toBeTruthy();
    const created = await SELF.fetch(`${LOCAL}/api/v1/clicks`, {
      method: "POST",
      headers: { "content-type": "application/json", host: new URL(LOCAL).host },
      body: JSON.stringify({ email: `rate-${crypto.randomUUID().slice(0, 8)}@example.com` }),
    });
    expect(created.headers.get("ratelimit")).toBeTruthy();
    expect(created.status).toBe(201);
    const register = await SELF.fetch(`${LOCAL}/register`);
    expect(register.status).toBe(200);
    const card = await (await SELF.fetch(`${LOCAL}/.well-known/mcp/server-card.json`)).json() as { tools: Array<{ name: string }> };
    expect(card.tools.some((tool) => tool.name === "send")).toBe(true);
  });

  it("lets an admin delete a click", async () => {
    const created = await createClick();
    const removed = await SELF.fetch(`${LOCAL}/api/clicks`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${created.click_key}`, host: new URL(LOCAL).host },
    });
    expect(removed.status).toBe(200);
    const again = await SELF.fetch(`${LOCAL}/api/me`, {
      headers: { authorization: `Bearer ${created.click_key}`, host: new URL(LOCAL).host },
    });
    expect(again.status).toBe(401);
  });
});
