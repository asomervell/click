import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHATGPT_RULE } from "../src/routine";
import { createClick, LOCAL, mcpCall } from "./helpers";

/** Every agent-facing surface tells each client where to add Click, and tells ChatGPT agents to use the plugin. */
describe("where to add Click", () => {
  const clients = ["Codex", "codex mcp login click", "claude.ai/customize/connectors", "Claude Duet", "claude mcp add --transport http click https://clickmcp.com/mcp", "Grok Bot"];

  for (const path of ["/docs.md", "/llms-full.txt", "/skills/click/SKILL.md", "/mcp"]) {
    it(`is in ${path}`, async () => {
      const response = await SELF.fetch(`${LOCAL}${path}`, { headers: { accept: "text/markdown" } });
      const text = await response.text();
      expect(text).toContain("## Where to add Click");
      expect(text).toContain(CHATGPT_RULE);
      for (const c of clients) expect(text).toContain(c);
    });
  }

  it("points llms.txt at it", async () => {
    const text = await (await SELF.fetch(`${LOCAL}/llms.txt`)).text();
    expect(text).toContain("where-to-add-click");
    expect(text).toContain("ChatGPT plugin");
  });

  it("is in the MCP server instructions", async () => {
    const click = await createClick();
    const init = await mcpCall(LOCAL, click.click_key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const instructions = (init.result as { instructions?: string }).instructions ?? "";
    expect(instructions).toContain(CHATGPT_RULE);
    expect(instructions).toContain("codex mcp login click");
    expect(instructions).toContain("claude mcp add --transport http click");
  });

  it("warns ChatGPT agents in the HTTP signup response", async () => {
    const response = await SELF.fetch(`${LOCAL}/api/v1/agents/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "setup-probe" }) });
    const body = await response.json() as { instruction?: string };
    expect(body.instruction).toContain("ChatGPT plugin");
  });
});
