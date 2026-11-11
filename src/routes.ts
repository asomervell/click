import { handleAuthorize } from "./authorize";
import { handleSite } from "./site";
import { handleHttpApi } from "./http-api";
import { handleKeys } from "./keys";
import { mcpResponse } from "./mcp";
import type { ClickProps, Role } from "./types";

export async function apiFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return mcpResponse(request, env, ctx, readProps(ctx));
}

export async function defaultFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/authorize") return handleAuthorize(request, env);
  if (url.pathname === "/keys") return handleKeys(request, env);
  if (url.pathname === "/health") return Response.json({ ok: true });
  const api = await handleHttpApi(request, env, ctx);
  if (api) return api;
  const site = await handleSite(request);
  if (site) return site;
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
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
