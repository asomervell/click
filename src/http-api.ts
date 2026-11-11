import { createClick, deleteClick, joinWithKey, resolveBearer, rotateClickKey } from "./clicks";
import { getHub } from "./hub";
import { ClickError, type ClickProps } from "./types";

export async function handleHttpApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const path = versionedPath(url.pathname);
  if (!path) return null;
  try {
    if (request.method === "POST" && path === "/api/clicks") {
      const body = await readJson(request);
      const created = await createClick(env, String(body.email ?? ""));
      return json(created, 201);
    }
    if (request.method === "POST" && path === "/api/clicks/join") {
      const body = await readJson(request);
      const joined = await joinWithKey(env, String(body.click_key ?? ""), body.label ? String(body.label) : null);
      return json({ token: joined.token, click_id: joined.clickId, principal_id: joined.principalId, role: joined.role }, 201);
    }
    const header = request.headers.get("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const props = token ? await resolveBearer(env, token, request) : null;
    if (!props) return problem(401, "Unauthorized", "unauthorized");
    return json(await dispatch(request, env, ctx, props, path));
  } catch (error) {
    const message = error instanceof ClickError ? error.message : error instanceof SyntaxError ? "JSON object required." : "Click failed.";
    const status = statusFor(message);
    if (status === 500) {
      console.error(JSON.stringify({ message: "api_failed", error: error instanceof Error ? error.message : "error" }));
    }
    return problem(status, message, status === 429 ? "rate_limited" : status === 404 ? "not_found" : status === 500 ? "internal" : "invalid");
  }
}

function versionedPath(pathname: string): string | null {
  if (pathname === "/api/v1") return "/api";
  if (pathname.startsWith("/api/v1/")) return `/api/${pathname.slice("/api/v1/".length)}`;
  if (pathname.startsWith("/api/")) return pathname;
  return null;
}

function statusFor(message: string): number {
  if (/too many|try again in a few|wait a minute|wait and try/i.test(message)) return 429;
  if (message === "Unknown API route.") return 404;
  if (message === "Click failed.") return 500;
  return 400;
}

async function dispatch(request: Request, env: Env, ctx: ExecutionContext, props: ClickProps, path: string): Promise<unknown> {
  const hub = getHub(env, props.clickId);
  if (request.method === "GET" && path === "/api/me") return hub.whoami(props);
  if (request.method === "GET" && path === "/api/agents") return hub.listAgents();
  if (request.method === "POST" && path === "/api/agents") return hub.register(props, await readJson(request) as { handle: string });
  if (request.method === "DELETE" && path === "/api/agents/me") return hub.leave(props);
  if (request.method === "DELETE" && path.startsWith("/api/agents/")) {
    return hub.removeMember(props, decodeURIComponent(path.slice("/api/agents/".length)));
  }
  if (request.method === "POST" && path === "/api/messages") {
    const result = await hub.send(props, await readJson(request) as { text: string });
    ctx.waitUntil(hub.processWakes(Date.now()).catch(() => undefined));
    return result;
  }
  if (request.method === "GET" && path === "/api/inbox") return hub.inbox(props, undefined);
  if (request.method === "POST" && path === "/api/ack") {
    const body = await readJson(request);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    return hub.ack(props, ids);
  }
  if (request.method === "GET" && path === "/api/key") return hub.showKey(props);
  if (request.method === "POST" && path === "/api/key/rotate") return rotateClickKey(env, props);
  if (request.method === "GET" && path === "/api/members") return hub.listMembers();
  if (request.method === "DELETE" && path === "/api/clicks") return deleteClick(env, props);
  if (request.method === "POST" && path === "/api/invites") {
    const body = await readJson(request);
    return hub.createInvite(props, body.label ? String(body.label) : null);
  }
  throw new ClickError("Unknown API route.");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 32_768) throw new ClickError("Payload too large.");
  const text = await request.text();
  if (!text) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClickError("JSON object required.");
  return value as Record<string, unknown>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: apiHeaders(status) });
}

function problem(status: number, detail: string, code: string): Response {
  const title = status === 429 ? "Too Many Requests" : status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : status >= 500 ? "Internal Server Error" : "Bad Request";
  const headers = new Headers(apiHeaders(status));
  headers.set("content-type", "application/problem+json");
  return Response.json({ type: "about:blank", title, status, detail, code }, { status, headers });
}

function apiHeaders(status: number): HeadersInit {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "click-version": "1",
    "ratelimit-policy": '"api";q=60;w=60',
    "ratelimit": '"api";r=59;t=60',
  };
  if (status === 429) headers["retry-after"] = "60";
  return headers;
}
