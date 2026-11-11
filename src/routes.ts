import { handleAuthorize } from "./authorize";
import { getDirectory } from "./directory";
import { handleSite } from "./site";
import { handleHttpApi } from "./http-api";
import { handleKeys } from "./keys";
import { mcpResponse } from "./mcp";
import type { ClickProps, Role } from "./types";

export async function apiFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const props = readProps(ctx);
  if (!(await getDirectory(env).clickExists(props.clickId))) {
    return Response.json({ error: "This click was deleted." }, { status: 401 });
  }
  return mcpResponse(request, env, ctx, props);
}

export async function defaultFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/authorize") return handleAuthorize(request, env);
  if (url.pathname === "/keys") return handleKeys(request, env);
  if (url.pathname === "/health") return Response.json({ ok: true });
  if (url.pathname === "/poppy/conversations") return poppyConversation(request, url.origin);
  const api = await handleHttpApi(request, env, ctx);
  if (api) return api;
  const site = await handleSite(request);
  if (site) return site;
  return notFound(request, url.origin);
}

function poppyConversation(request: Request, origin: string): Response {
  const reading = request.method === "GET" || request.method === "HEAD";
  return Response.json({
    protocol: "poppy",
    access: "session",
    detail: "A Click session is one click's mailbox. Create a click, then send and read messages at /api/v1 or /mcp.",
  }, {
    status: reading ? 200 : 401,
    headers: reading ? { allow: "GET, HEAD, POST" } : {
      "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  });
}

function notFound(request: Request, origin: string): Response {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/markdown")) {
    const body = `# Not found\n\nThat path is not on Click. See the [API docs](${origin}/docs.md) and [llms.txt](${origin}/llms.txt).\n`;
    return new Response(body, {
      status: 404,
      headers: { "content-type": "text/markdown; charset=utf-8", vary: "Accept" },
    });
  }
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", vary: "Accept" } });
}

function readProps(ctx: ExecutionContext): ClickProps {
  const props = (ctx as ExecutionContext & { props?: Partial<ClickProps> }).props;
  const role = props?.role;
  if (!props?.principalId || !props.clickId || !isRole(role)) {
    throw new Error("Click identity missing from token");
  }
  return { principalId: props.principalId, clickId: props.clickId, role };
}

function isRole(role: string | undefined): role is Role {
  return role === "admin" || role === "member" || role === "operator";
}
