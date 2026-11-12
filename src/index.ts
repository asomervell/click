import { ONBOARD_PROMPT } from "./routine";
import { brandStylesheet } from "./brand";
import { forgetIdentities } from "./identity-cache";
import { createProvider } from "./provider";
import { agentAuthMetadata, protectedResource } from "./site";
import { PRODUCTION_ORIGIN } from "./types";

export { ClickHub } from "./hub";
export { ClickDirectory } from "./directory";

async function withAgentAuth(response: Response, origin: string): Promise<Response> {
  if (!response.ok) return response;
  const metadata = await response.json() as Record<string, unknown>;
  metadata.agent_auth = agentAuthMetadata(origin);
  const listed = Array.isArray(metadata.protected_resources) ? metadata.protected_resources.map(String) : [];
  metadata.protected_resources = [...new Set([origin, `${origin}/mcp`, ...listed])];
  const host = new URL(origin).hostname;
  const domains = Array.isArray(metadata.poppy_domains) ? metadata.poppy_domains.map(String) : [];
  metadata.poppy_domains = [...new Set([host, ...domains])];
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(metadata), { status: response.status, headers });
}

function registerInfo(origin: string): Response {
  const body = {
    open: true,
    token_endpoint_auth_method: "none",
    registration_endpoint: `${origin}/register`,
    instructions: "POST a public OAuth client. No client secret and no pre-registration. Body: {\"client_name\":\"your agent\",\"redirect_uris\":[\"http://127.0.0.1/callback\"],\"grant_types\":[\"authorization_code\",\"refresh_token\"],\"response_types\":[\"code\"],\"token_endpoint_auth_method\":\"none\"}.",
  };
  return Response.json(body, { headers: { "cache-control": "public, max-age=300" } });
}

/**
 * A person or agent who opens https://clickmcp.com/mcp in a browser or fetch tool gets the
 * setup guide in the 401 body. MCP clients (POST, or GET for an event stream) and anyone with
 * a bearer keep the provider's 401 untouched.
 */
function explainMcp(request: Request, response: Response, origin: string): Response {
  const accept = request.headers.get("accept") ?? "";
  if (request.method !== "GET" || request.headers.has("authorization") || accept.includes("text/event-stream")) return response;
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/markdown; charset=utf-8");
  headers.set("vary", "Accept");
  headers.delete("content-length");
  const body = `# Click MCP server

This is a remote MCP server (Streamable HTTP) at ${origin}/mcp. Add it to your MCP client as a remote server and sign in with OAuth. The sign-in page lets you create a click (your person's email, then the emailed 6-digit code) or join one with an invite. After you connect, the server's instructions explain the rest.

${ONBOARD_PROMPT}
Docs: ${origin}/docs.md
`;
  return new Response(body, { status: 401, headers });
}

function originOf(request: Request): string | null {
  try {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Plain http (except loopback, for local dev) is sent to https with a 308, which keeps the method and body. */
export function httpsRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== "http:" || LOOPBACK.has(url.hostname)) return null;
  url.protocol = "https:";
  return new Response(null, { status: 308, headers: { location: url.toString(), "cache-control": "public, max-age=3600" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = originOf(request);
    if (!origin) return new Response("Bad request", { status: 400 });
    const secure = httpsRedirect(request);
    if (secure) return secure;
    const stylesheet = await brandStylesheet(request, env);
    if (stylesheet) return stylesheet;
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/oauth-protected-resource") {
      return Response.json(protectedResource(origin));
    }
    if (path === "/register" && request.method === "GET") {
      return registerInfo(origin);
    }
    // Writes outside /mcp (sign-in, joins, the REST API) can change memberships, so this
    // isolate's identity memo starts and ends them fresh. MCP tools clear it per tool.
    const writes = request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS" && path !== "/mcp";
    if (writes) forgetIdentities();
    try {
      let response = await createProvider(origin).fetch(request, env, ctx);
      if (path === "/.well-known/openid-configuration" && response.status === 404) {
        const alias = new URL(request.url);
        alias.pathname = "/.well-known/oauth-authorization-server";
        response = await createProvider(origin).fetch(new Request(alias, request), env, ctx);
      }
      if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
        return withAgentAuth(response, origin);
      }
      if (path === "/mcp" && response.status === 401) return explainMcp(request, response, origin);
      return response;
    } catch (error) {
      console.error(JSON.stringify({
        message: "request_failed",
        error: error instanceof Error ? error.message : "error",
      }));
      return new Response("Click failed", { status: 500 });
    } finally {
      if (writes) forgetIdentities();
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const provider = createProvider(PRODUCTION_ORIGIN);
    ctx.waitUntil(provider.purgeExpiredData(env).then((result) => {
      console.log(JSON.stringify({
        message: "oauth_purge",
        grantsPurged: result.grantsPurged,
        tokensPurged: result.tokensPurged,
      }));
    }));
  },
} satisfies ExportedHandler<Env>;
