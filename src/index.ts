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

function originOf(request: Request): string | null {
  try {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = originOf(request);
    if (!origin) return new Response("Bad request", { status: 400 });
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/oauth-protected-resource") {
      return Response.json(protectedResource(origin));
    }
    if (path === "/register" && request.method === "GET") {
      return registerInfo(origin);
    }
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
      return response;
    } catch (error) {
      console.error(JSON.stringify({
        message: "request_failed",
        error: error instanceof Error ? error.message : "error",
      }));
      return new Response("Click failed", { status: 500 });
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
