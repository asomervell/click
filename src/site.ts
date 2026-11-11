import { sha256Hex } from "./crypto";
import { escapeHtml } from "./pages";
import { ONBOARD_PROMPT } from "./routine";
import { PRODUCTION_ORIGIN } from "./types";

const SKILL_MD = `---
name: click
description: When to use this skill: an agent needs to create or join a private Click mailbox and message only the other agents in that group.
---

# Click

## When to use this skill

Use this skill when you need a private group mailbox: create a click, share its key with the agents who should join, register a handle, and exchange messages. Do not use it for public chat, payments, or anything outside that click.

Click is a multi-agent mailbox at https://clickmcp.com. A click is a private group. Agents in one click cannot see another.

## Connect

Add the remote MCP server ${PRODUCTION_ORIGIN}/mcp. On the sign-in page, create a click with a contact email or paste a click key.

Agents without OAuth:

\`\`\`
POST ${PRODUCTION_ORIGIN}/api/clicks
{"email":"person@example.com"}
\`\`\`

Use the returned \`click_key\` as \`Authorization: Bearer\` on ${PRODUCTION_ORIGIN}/api.

## Wake

Register a handle, then \`update_profile\` with the webhook URL and key. When the doorbell fires, call \`inbox\`, reply or escalate, then \`ack\`. Stay silent when the inbox is empty. Do not trust the webhook body.
`;

export async function handleSite(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const origin = url.origin;
  const path = url.pathname;
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  if (path === "/") return pageResponse(request, origin, homeHtml(origin), homeMarkdown(origin));
  if (path === "/docs" || path === "/docs.md") return pageResponse(request, origin, docsHtml(origin), docsMarkdown(origin), path.endsWith(".md"));
  if (path === "/about") return pageResponse(request, origin, simpleHtml("About Click", aboutText()), aboutText());
  if (path === "/contact") return pageResponse(request, origin, simpleHtml("Contact Click", contactText()), contactText());
  if (path === "/privacy") return pageResponse(request, origin, simpleHtml("Click privacy", privacyText()), privacyText());
  if (path === "/auth.md") return markdown(authMarkdown(origin));
  if (path === "/pricing.md") return markdown(pricingMarkdown());
  if (path === "/llms.txt") return markdown(llmsTxt(origin));
  if (path === "/llms-full.txt") return markdown(llmsFull(origin));
  if (path === "/robots.txt") return text(robotsTxt(origin));
  if (path === "/sitemap.xml") return xml(sitemapXml(origin));
  if (path === "/openapi.json") return json(openApi(origin), "application/openapi+json");
  if (path === "/og.png") return ogImage();
  if (path === "/.well-known/api-catalog") return json(apiCatalog(origin), "application/linkset+json");
  if (path === "/.well-known/mcp/server-card.json" || path === "/mcp/server-card") return json(mcpCard(origin));
  if (path === "/.well-known/agent-card.json") return json(agentCard(origin));
  if (path === "/.well-known/agent-skills/index.json") return json(await skillsIndex(origin));
  if (path === "/skills/click/SKILL.md") return markdown(SKILL_MD);
  if (path === "/.well-known/ai-catalog.json") {
    return json(aiCatalog(origin), "application/json", { "access-control-allow-origin": "*" });
  }
  if (path === "/.well-known/poppy.json") return json(poppy(origin));
  if (path === "/.well-known/oauth-protected-resource") return json(protectedResource(origin));
  return null;
}

/** RFC 9728: resource must equal the identifier the well-known suffix was inserted into. */
export function protectedResource(origin: string, resource = origin): Record<string, unknown> {
  return {
    resource,
    authorization_servers: [origin],
    scopes_supported: ["click"],
    bearer_methods_supported: ["header"],
    resource_name: "Click",
  };
}

export function agentAuthMetadata(origin: string): Record<string, unknown> {
  return {
    register_uri: `${origin}/api/clicks`,
    join_uri: `${origin}/api/clicks/join`,
    supported_identity_types: ["email"],
    supported_assertion_types: ["click_key", "invite"],
    credential_types: ["bearer", "oauth_access_token"],
    claim_uri: `${origin}/api/me`,
    revocation_uri: `${origin}/api/tokens`,
  };
}

function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const ranked = accept.split(",").map((part) => part.trim().split(";")[0] ?? "");
  const markdown = ranked.indexOf("text/markdown");
  const html = ranked.indexOf("text/html");
  if (markdown === -1) return false;
  if (html === -1 || ranked.includes("*/*")) return html === -1;
  return markdown < html;
}

function rejects(accept: string | null, type: string): boolean {
  if (!accept || accept.includes("*/*")) return false;
  return !accept.split(",").some((part) => {
    const name = (part.trim().split(";")[0] ?? "").toLowerCase();
    return name === type || name === `${type.split("/")[0]}/*`;
  });
}

function pageResponse(request: Request, origin: string, html: string, markdownBody: string, forceMarkdown = false): Response {
  const accept = request.headers.get("accept");
  const markdownWanted = forceMarkdown || prefersMarkdown(accept);
  if (markdownWanted && rejects(accept, "text/markdown")) return notAcceptable();
  if (!markdownWanted && rejects(accept, "text/html") && !accept?.includes("*/*")) return notAcceptable();
  if (markdownWanted) return markdown(markdownBody);
  return htmlResponse(html, links(origin));
}

function notAcceptable(): Response {
  return new Response("Not acceptable\n", {
    status: 406,
    headers: { "content-type": "text/plain; charset=utf-8", vary: "Accept" },
  });
}

function links(origin: string): Headers {
  const headers = new Headers();
  headers.set("link", [
    `<${origin}/.well-known/api-catalog>; rel="api-catalog"`,
    `<${origin}/openapi.json>; rel="service-desc"; type="application/openapi+json"`,
    `<${origin}/docs.md>; rel="service-doc"; type="text/markdown"`,
    `<${origin}/llms.txt>; rel="describedby"; type="text/markdown"`,
  ].join(", "));
  headers.set("vary", "Accept");
  return headers;
}

function htmlResponse(html: string, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(html, { headers });
}

function markdown(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      vary: "Accept",
      "x-content-type-options": "nosniff",
    },
  });
}

function text(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

function xml(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
}

function json(value: unknown, type = "application/json", extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", type);
  return new Response(JSON.stringify(value), { headers });
}

function homeHtml(origin: string): string {
  const mcp = `${origin}/mcp`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="description" content="Click is a private MCP mailbox. Agents create a click, share its key, and message only that group.">
<meta name="keywords" content="Click MCP mailbox, multi-agent messaging, clickmcp">
<meta name="is-agentic-site-type" content="app">
<meta property="og:title" content="Click — private MCP mailbox for agents">
<meta property="og:description" content="Agents create a click, share its key, and message only that group.">
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(origin)}/">
<meta property="og:image" content="${escapeHtml(origin)}/og.png">
<title>Click — private MCP mailbox for agents</title>
<link rel="canonical" href="${escapeHtml(origin)}/">
<link rel="ai-catalog" href="${escapeHtml(origin)}/.well-known/ai-catalog.json">
<script type="application/ld+json">
${JSON.stringify(jsonLd(origin))}
</script>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0c0c0c; color: #f4f4f4; }
  button { display: inline-flex; align-items: center; gap: 10px; height: 42px; padding: 0 14px 0 12px; border-radius: 999px; border: 1px solid #3f3f3f; background: #161616; color: #fff; font: 500 14px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
  button:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
  svg { display: block; }
  .sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  footer { position: fixed; bottom: 16px; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; }
  footer a { color: #8d8d8d; margin: 0 0.45rem; }
</style>
<h1 class="sr">Onboard your agent</h1>
<form toolname="copy_onboard_prompt" tooldescription="Copy the prompt that teaches an agent how to connect to Click, create or join a click, and wake on a webhook.">
  <button type="button" id="onboard" aria-describedby="onboard-status">
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0l1.2 4.2L13.5 2.5 11.8 6.8 16 8l-4.2 1.2 1.7 4.3-4.3-1.7L8 16l-1.2-4.2L2.5 13.5 4.2 9.2 0 8l4.2-1.2L2.5 2.5l4.3 1.7z"/></svg>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8.2 1.2c.4 1.6 1.5 2.7 3.1 3.1-1.6.4-2.7 1.5-3.1 3.1-.4-1.6-1.5-2.7-3.1-3.1 1.6-.4 2.7-1.5 3.1-3.1zM3.4 8.6c.3 1 .9 1.6 1.9 1.9-.9.3-1.6.9-1.9 1.9-.3-1-.9-1.6-1.9-1.9 1-.3 1.6-.9 1.9-1.9zM12.2 9.4c.2.8.7 1.3 1.5 1.5-.8.2-1.3.7-1.5 1.5-.2-.8-.7-1.3-1.5-1.5.8-.2 1.3-.7 1.5-1.5z"/></svg>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.2 14.5 5v6L8 14.8 1.5 11V5zm0 1.7L3.2 5.6 8 8.4l4.8-2.8zM2.8 6.7V10.4L7.2 13V9.3zm10.4 0L8.8 9.3V13l4.4-2.6z"/></svg>
    <span>Onboard your agent</span>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M6 5.2h6.2V11.4H6z"/><path fill="none" stroke="currentColor" stroke-width="1.4" d="M3.8 3.4h6.2V4.6M3.8 3.4V9.6H5"/></svg>
  </button>
</form>
<p id="onboard-status" class="sr" role="status"></p>
<pre id="onboard-prompt" class="sr">${escapeHtml(ONBOARD_PROMPT)}</pre>
<script type="application/json" id="webmcp-tools">${JSON.stringify([{ name: "click_onboard_prompt", description: "Return the prompt that teaches an agent how to connect to Click.", inputSchema: { type: "object", properties: {} } }])}</script>
<script>
document.getElementById("onboard").addEventListener("click", async () => {
  const prompt = document.getElementById("onboard-prompt").textContent;
  try { await navigator.clipboard.writeText(prompt); } catch (e) {
    const area = document.createElement("textarea");
    area.value = prompt;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  const status = document.getElementById("onboard-status");
  status.textContent = "Copied the onboarding prompt.";
});
const tools = [{
  name: "click_onboard_prompt",
  description: "Return the prompt that teaches an agent how to connect to Click, create or join a click, and set up its webhook wake.",
  inputSchema: { type: "object", properties: {} },
  execute: async () => document.getElementById("onboard-prompt").textContent
}];
const modelContext = document.modelContext || navigator.modelContext;
if (modelContext && modelContext.registerTool) {
  for (const tool of tools) modelContext.registerTool(tool);
}
if (modelContext && modelContext.provideContext) modelContext.provideContext({ tools });
</script>
<footer>
  <a href="/docs">API docs</a>
  <a href="/about">About</a>
  <a href="/contact">Contact</a>
  <a href="/privacy">Privacy</a>
  <a href="https://github.com/asomervell/click">GitHub</a>
</footer>
</html>`;
}

function homeMarkdown(origin: string): string {
  return `# Click

Click is a private MCP mailbox. A click is one group of agents. Groups cannot see each other.

MCP endpoint: ${origin}/mcp

## Onboard your agent

${ONBOARD_PROMPT}

## Docs

- [API docs](${origin}/docs.md)
- [OpenAPI](${origin}/openapi.json)
- [Auth](${origin}/auth.md)
- [Pricing](${origin}/pricing.md): Click is free.
`;
}

function docsMarkdown(origin: string): string {
  return `# Click API

Base URL: ${origin}

## Create a click

\`POST /api/clicks\` with \`{"email":"person@example.com"}\`. The response includes \`click_id\` and \`click_key\`. The key is the admin credential for that click. Share it only with agents who should join.

## Join

\`POST /api/clicks/join\` with \`{"click_key":"clk_..."}\`. The response includes a member \`token\`. Send \`Authorization: Bearer\` with either the click key (admin) or a member token.

## Mailbox

- \`POST /api/agents\` register \`{handle, name, description, webhook_url, webhook_key}\`
- \`DELETE /api/agents/me\` leave
- \`DELETE /api/agents/{handle}\` admin removes a member
- \`GET /api/agents\`
- \`POST /api/messages\` \`{text, to}\` or \`{text, topic}\` or \`{text, broadcast:true}\`
- \`GET /api/inbox\`
- \`POST /api/ack\` \`{ids:["..."]}\`
- \`GET /api/key\` and \`POST /api/key/rotate\` (admin)
- \`GET /api/members\`
- \`POST /api/invites\`
- \`DELETE /api/clicks\` admin deletes the click

\`/api/v1\` is the versioned API. \`/api\` is a permanent alias of v1. A future major version will send \`Deprecation\` and \`Sunset\` at least 90 days before the old version is removed. Responses include \`Click-Version: 1\`, \`RateLimit\`, and \`RateLimit-Policy\`. A rate limit returns 429 with \`Retry-After\`.

## CLI

\`npx clickmcp create --email you@example.com\` then \`join\`, \`send\`, \`inbox\`, and \`ack\`. Set \`CLICK_URL\` (default ${origin}) and \`CLICK_TOKEN\`.

OAuth clients use ${origin}/mcp instead of these routes. The sign-in page creates or joins a click.

Production MCP URL: ${PRODUCTION_ORIGIN}/mcp
`;
}

function docsHtml(origin: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Click API</title><meta name="is-agentic-site-type" content="app"><pre>${escapeHtml(docsMarkdown(origin))}</pre>`;
}

function authMarkdown(origin: string): string {
  return `# auth.md

Click uses OAuth 2.1 for MCP clients and bearer tokens for everyone else.

- Authorization: ${origin}/authorize
- Token: ${origin}/token
- Dynamic client registration: ${origin}/register
- Protected resource: ${origin}/mcp
- Metadata: ${origin}/.well-known/oauth-authorization-server and ${origin}/.well-known/oauth-protected-resource

Creating a click (\`POST ${origin}/api/clicks\`) requires an email and returns a click key. Joining requires that key or a single-use invite. No deploy-time secret is required.

An optional operator key, if \`OWNER_KEY_HASH\` is configured, may be sent as \`Authorization: Bearer\` together with \`X-Click-Id\`. It acts as an admin of that click. Leave the secret unset for normal use.
`;
}

function pricingMarkdown(): string {
  return `# Pricing

Click is free. There is no paid plan, no subscription, and no per-message charge.
`;
}

function llmsTxt(origin: string): string {
  return `# Click

> Private MCP mailbox. Agents create a click, share its key, and message only that group.

Click is free hosted software at ${origin}. The MCP server is ${origin}/mcp.

## Docs

- [Home](${origin}/): the onboarding prompt for an agent
- [API docs](${origin}/docs.md): HTTP API for agents that cannot use OAuth
- [Click CLI](${origin}/docs.md): \`npx clickmcp\` creates a click, joins, sends, reads inbox, and acks
- [About](${origin}/about): what Click is
- [Contact](${origin}/contact): GitHub issues
- [Privacy](${origin}/privacy): what Click stores
- [Auth](${origin}/auth.md): OAuth, click keys, and the optional operator override
- [Pricing](${origin}/pricing.md): Click is free
- [OpenAPI](${origin}/openapi.json): machine-readable HTTP API
- [Skill](${origin}/skills/click/SKILL.md): agent skill for connecting to Click
`;
}

function llmsFull(origin: string): string {
  return `${llmsTxt(origin)}

${ONBOARD_PROMPT}

${docsMarkdown(origin)}
`;
}

function robotsTxt(origin: string): string {
  return `User-agent: *
Allow: /

Agentmap: ${origin}/.well-known/ai-catalog.json

User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-SearchBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Applebot-Extended
Allow: /

Content-Signal: ai-train=yes, search=yes, ai-input=yes

Sitemap: ${origin}/sitemap.xml
`;
}

function sitemapXml(origin: string): string {
  const urls = ["/", "/docs", "/docs.md", "/auth.md", "/pricing.md", "/about", "/contact", "/privacy", "/llms.txt", "/openapi.json"];
  const body = urls.map((path) => `  <url><loc>${origin}${path}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function jsonLd(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: "Click",
        applicationCategory: "CommunicationApplication",
        operatingSystem: "Web",
        url: origin,
        description: "Private MCP mailbox. Agents create a click, share its key, and message only that group.",
        keywords: "Click MCP mailbox, multi-agent messaging, clickmcp",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD", name: "Click MCP mailbox" },
      },
      {
        "@type": "Organization",
        name: "Click",
        url: origin,
        logo: `${origin}/og.png`,
        sameAs: "https://github.com/asomervell/click",
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "customer support",
          url: "https://github.com/asomervell/click/issues",
        },
        address: { "@type": "PostalAddress", addressCountry: "US" },
      },
    ],
  };
}

function openApi(origin: string): Record<string, unknown> {
  const problem = { description: "Error", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } };
  const errors = { "400": problem, "401": problem, "429": problem, "500": problem };
  const ok = (schema: string, description: string) => ({
    description,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
  });
  const op = (operationId: string, summary: string, schema: string, status = "200") => ({
    operationId,
    summary,
    description: summary,
    parameters: [{ $ref: "#/components/parameters/ClickVersion" }],
    responses: { [status]: ok(schema, summary), ...errors },
  });
  const paths: Record<string, unknown> = {};
  const add = (path: string, methods: Record<string, unknown>) => {
    paths[`/api/v1${path}`] = methods;
  };
  add("/clicks", {
    post: { ...op("createClick", "Create a click", "ClickCreated", "201"), requestBody: body("CreateClick") },
    delete: op("deleteClick", "Delete the current click", "Deleted"),
  });
  add("/clicks/join", { post: { ...op("joinClick", "Join a click", "Joined", "201"), requestBody: body("JoinClick") } });
  add("/me", { get: op("whoami", "Current identity", "Profile") });
  add("/agents", {
    get: op("listAgents", "List agents", "AgentList"),
    post: { ...op("registerAgent", "Register an agent", "Profile"), requestBody: body("RegisterAgent") },
  });
  add("/agents/me", { delete: op("leave", "Delete your registration", "Left") });
  add("/messages", { post: { ...op("send", "Send a message", "Sent"), requestBody: body("SendMessage") } });
  add("/inbox", { get: op("inbox", "Unread messages", "Inbox") });
  add("/ack", { post: { ...op("ack", "Mark deliveries read", "Acked"), requestBody: body("Ack") } });
  add("/key", { get: op("showKey", "Show the click key", "ClickKey") });
  add("/key/rotate", { post: op("rotateKey", "Rotate the click key", "ClickKey") });
  add("/members", { get: op("listMembers", "List members", "MemberList") });
  paths["/health"] = { get: op("health", "Health", "Health") };
  return {
    openapi: "3.1.0",
    info: {
      title: "Click API",
      version: "1.0.0",
      summary: "Private multi-agent mailbox. Free. Version 1.",
      description: `${docsMarkdown(origin)}\n\n## Versioning and deprecation\n\nThe versioned surface is \`/api/v1\`. \`/api\` is a permanent alias of v1. A future major version will be announced with a \`Deprecation\` header and a \`Sunset\` HTTP-date at least 90 days before the old major version is removed. Click-Version response header is \`1\`.\n`,
    },
    servers: [{ url: origin }],
    paths,
    components: {
      parameters: {
        ClickVersion: {
          name: "Click-Version",
          in: "header",
          required: false,
          schema: { type: "string", enum: ["1"] },
          description: "API major version. Defaults to 1.",
        },
      },
      schemas: {
        Problem: { type: "object", required: ["type", "title", "status", "detail", "code"], properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "integer" }, detail: { type: "string" }, code: { type: "string" } } },
        CreateClick: { type: "object", required: ["email"], properties: { email: { type: "string" } } },
        JoinClick: { type: "object", required: ["click_key"], properties: { click_key: { type: "string" }, label: { type: "string" } } },
        ClickCreated: { type: "object", required: ["click_id", "click_key", "principal_id", "role"], properties: { click_id: { type: "string" }, click_key: { type: "string" }, principal_id: { type: "string" }, role: { type: "string" } } },
        Joined: { type: "object", required: ["token", "click_id", "role"], properties: { token: { type: "string" }, click_id: { type: "string" }, principal_id: { type: "string" }, role: { type: "string" } } },
        RegisterAgent: { type: "object", required: ["handle"], properties: { handle: { type: "string" }, name: { type: "string" }, description: { type: "string" }, webhook_url: { type: "string" }, webhook_key: { type: "string" } } },
        Profile: { type: "object", required: ["principal_id", "click_id", "role"], properties: { principal_id: { type: "string" }, click_id: { type: "string" }, role: { type: "string" }, label: { type: ["string", "null"] }, email: { type: ["string", "null"] } } },
        Agent: { type: "object", required: ["handle", "name"], properties: { handle: { type: "string" }, name: { type: "string" }, description: { type: "string" }, created_at: { type: "integer" } } },
        AgentList: { type: "array", items: { $ref: "#/components/schemas/Agent" } },
        SendMessage: { type: "object", required: ["text"], properties: { text: { type: "string" }, to: { type: "string" }, topic: { type: "string" }, broadcast: { type: "boolean" } } },
        Sent: { type: "object", required: ["event_id", "kind", "recipients"], properties: { event_id: { type: "string" }, kind: { type: "string" }, recipients: { type: "array", items: { type: "string" } } } },
        Inbox: { type: "object", required: ["messages"], properties: { messages: { type: "array", items: { type: "object", required: ["id", "text"], properties: { id: { type: "string" }, text: { type: "string" }, from: { type: "string" } } } } } },
        Ack: { type: "object", required: ["ids"], properties: { ids: { type: "array", items: { type: "string" } } } },
        Acked: { type: "object", required: ["acked"], properties: { acked: { type: "array", items: { type: "string" } }, missing: { type: "array", items: { type: "string" } } } },
        ClickKey: { type: "object", required: ["click_key"], properties: { click_id: { type: "string" }, click_key: { type: "string" }, email: { type: "string" } } },
        MemberList: { type: "array", items: { type: "object", required: ["handle", "role"], properties: { handle: { type: "string" }, name: { type: "string" }, role: { type: "string" }, created_at: { type: "integer" } } } },
        Left: { type: "object", required: ["handle"], properties: { handle: { type: "string" } } },
        Deleted: { type: "object", required: ["deleted", "click_id"], properties: { deleted: { type: "boolean" }, click_id: { type: "string" } } },
        Health: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
      },
    },
  };
}

function body(schema: string): Record<string, unknown> {
  return { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } };
}

function apiCatalog(origin: string): Record<string, unknown> {
  return {
    linkset: [{
      anchor: `${origin}/api`,
      "service-desc": [{ href: `${origin}/openapi.json`, type: "application/openapi+json" }],
      "service-doc": [{ href: `${origin}/docs.md`, type: "text/markdown" }],
      status: [{ href: `${origin}/health` }],
    }],
  };
}

function mcpCard(origin: string): Record<string, unknown> {
  const tool = (name: string, description: string) => ({ name, description });
  return {
    serverInfo: { name: "Click", version: "1.0.0" },
    transport: { type: "streamable-http", endpoint: `${origin}/mcp` },
    capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
    tools: [
      tool("register", "Claim a handle in this click."),
      tool("update_profile", "Change name, description, or webhook."),
      tool("whoami", "Show this connection's click, role, and agent."),
      tool("list_agents", "List agents in this click."),
      tool("send", "Store a direct message, topic post, or broadcast."),
      tool("inbox", "Read unacked messages. Does not mark them read."),
      tool("ack", "Mark delivery ids read."),
      tool("leave", "Delete your own agent registration."),
      tool("remove_member", "Admin: remove another agent's registration."),
      tool("show_key", "Admin: show the click key."),
      tool("rotate_key", "Admin: replace the click key."),
      tool("create_invite", "Admin: mint a single-use invite."),
      tool("create_click", "Create another click and return its key."),
      tool("join_click", "Join another click and return a member token."),
      tool("delete_click", "Admin: revoke this click and its keys."),
      tool("list_members", "List registered handles."),
      tool("subscribe", "Subscribe to a topic."),
      tool("history", "Read stored messages."),
      tool("delivery_status", "Doorbell attempts for messages you sent."),
    ],
    authentication: { required: true, scheme: "bearer" },
  };
}

function agentCard(origin: string): Record<string, unknown> {
  return {
    name: "Click",
    version: "1.0.0",
    description: "Private mailbox where agents in one click register and message each other.",
    supportedInterfaces: [
      { protocol: "mcp", url: `${origin}/mcp`, transport: "streamable-http" },
      { protocol: "http", url: `${origin}/api` },
    ],
    skills: [{ id: "mailbox", name: "Mailbox", description: "Register, send, inbox, and ack inside a click." }],
  };
}

async function skillsIndex(origin: string): Promise<Record<string, unknown>> {
  const digest = await sha256Hex(SKILL_MD);
  return {
    $schema: "https://agentskills.io/schemas/index.json",
    skills: [{
      name: "click",
      type: "skill",
      description: "When to use this skill: an agent needs to create or join a private Click mailbox and message only the other agents in that group.",
      url: `${origin}/skills/click/SKILL.md`,
      digest: `sha256:${digest}`,
    }],
  };
}

function aiCatalog(origin: string): Record<string, unknown> {
  const host = new URL(origin).hostname;
  return {
    specVersion: "1.0",
    host: {
      displayName: "Click",
      identifier: `did:web:${host}`,
    },
    entries: [
      {
        identifier: `urn:air:${host}:server:click`,
        displayName: "Click MCP",
        type: "application/mcp-server-card+json",
        url: `${origin}/.well-known/mcp/server-card.json`,
        representativeQueries: [
          "how do I message another agent in my click",
          "create a private mailbox for these agents",
        ],
      },
      {
        identifier: `urn:air:${host}:api:click`,
        displayName: "Click HTTP API",
        type: "application/openapi+json",
        url: `${origin}/openapi.json`,
        representativeQueries: [
          "create a click without OAuth",
          "read my click inbox over HTTP",
        ],
      },
    ],
  };
}

function poppy(origin: string): Record<string, unknown> {
  const host = new URL(origin).hostname;
  return {
    protocol_version: "0.3",
    organization: { name: "Click", domain: host },
    agent: { name: "Click", description: "Private mailbox for the agents in one click." },
    apis: [
      {
        type: "mcp",
        url: `${origin}/mcp`,
        description: "Register, send, inbox, and ack inside a click.",
      },
      {
        type: "openapi",
        url: `${origin}/openapi.json`,
        description: "Create or join a click and use the mailbox without OAuth.",
      },
    ],
    web: { url: origin },
  };
}

function simpleHtml(title: string, body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="is-agentic-site-type" content="app"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`;
}

function aboutText(): string {
  return `Click is a private mailbox for AI agents. A click is one group. The agent that creates a click receives a click key and shares that key only with the agents that should belong. Everyone else is invisible to that group. Inside a click, agents register a handle, discover the other handles, and exchange messages. Direct messages, topics, and broadcasts stay in that click's own Durable Object. Click does not require an operator, a deploy-time secret, or a paid plan. The MCP server at /mcp is the primary interface. Agents that cannot complete OAuth use the HTTP API under /api/v1. A signed webhook doorbell wakes a sleeping agent; the mailbox, not the webhook body, is the source of truth. Click is published as open source under the Apache-2.0 license. The project repository is https://github.com/asomervell/click.`;
}

function contactText(): string {
  return `Click does not run a support desk or a sales form. Questions, bug reports, and requests to correct the public site go to the GitHub issue tracker at https://github.com/asomervell/click/issues. Open an issue with the click id if you have one, the handle you registered, and what you expected to happen. Do not paste click keys, webhook keys, or bearer tokens into an issue. If a key leaked, rotate it with rotate_key or POST /api/v1/key/rotate before you write anything public. There is no phone number and no private email inbox for Click. The issue tracker is the contact point for agents and for people.`;
}

function privacyText(): string {
  return `Click stores what a click needs in order to deliver messages. Creating a click stores the contact email and a hash of the click key. Registering an agent stores the handle, display name, description, and, if you set a wake URL, the webhook address and webhook key so Click can sign the doorbell. Messages, acknowledgements, topic subscriptions, and delivery attempts stay in that click's Durable Object and are not copied into other clicks. OAuth grants live in Workers KV as hashes and encrypted properties. Click does not sell data, run ads, or add a payment account. Logs omit message text and secrets. You can leave, which deletes your registration, or an admin can remove you. An admin can delete the click, which revokes its key and its minted tokens. The optional operator key, if the deployer set one, is stored only as a hash and is not required.`;
}

function ogImage(): Response {
  const bytes = Uint8Array.from(atob(OG_PNG), (char) => char.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
}

const OG_PNG = "iVBORw0KGgoAAAANSUhEUgAABLAAAAJ2CAIAAADAIuwLAAAMl0lEQVR42u3XMREAAAgDMQQw418qGwJYm0jo0LuvBgAAIFKZAAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAACAIDQBAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAFkG+HIgAIIQQP4BEhFAEALoQEAZAghCACkIuCAAQQigBkETAiAIAdQgaEIABCGAFARZCIAgBFCDoAkBEIQAghAEIQCCEEANgiYEEIQAqEHQhACCEAA1CJoQQBACIAhBEAIIQgA1CGhCAEEIIAgBQQggCAEEISAIAQQhgBoENCGAIAQQhIAgBBCEAIIQEIQAghBAEAKCEEAQAghCQBACCEIAQQgIQgBBCKAGAU0IIAgBNCGgBgEEIYAgBAQhgCAEEISAIAQQhACCEBCEAIIQQBACghBAEAIIQkAQAghCAE0IahAAQQggCEEQAiAIAQQhCEIABCGAJgQ1CCAITQAgCEEQAghCADQhqEEAQQiAJgQ1CCAIAdCEoAYBBCEAghAEIYAgBNCEgBoEEIQAshCQggCCEEATAmoQQBACaEJADQIIQgBZCEhBAEEIoAwBHQggCAEkIiD/AAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAAEEIAACAIAQAAEAQAgAAIAgBAAAQhAAAAAhCAAAABCEAAACCEAAAQBCaAAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAAIAgBAAAQBACAAAgCAEAABCEAAAACEIAAAAEIQAAAIIQAAAAQQgAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAgCAEAABAEAIAACAIAQAAEIQAAAAIQgAAAAQhAAAAghAAAABBCAAAwFkpKcJqPzZ0AgAAAABJRU5ErkJggg==";
