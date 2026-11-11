import { createClick, joinWithKey, resolveBearer, rotateClickKey } from "./clicks";
import { getHub } from "./hub";
import { ClickError, type ClickProps } from "./types";

export async function handleHttpApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;
  try {
    if (request.method === "POST" && url.pathname === "/api/clicks") {
      const body = await readJson(request);
      const created = await createClick(env, String(body.email ?? ""));
      return json(created, 201);
    }
    if (request.method === "POST" && url.pathname === "/api/clicks/join") {
      const body = await readJson(request);
      const joined = await joinWithKey(env, String(body.click_key ?? ""), body.label ? String(body.label) : null);
      return json({ token: joined.token, click_id: joined.clickId, principal_id: joined.principalId, role: joined.role }, 201);
    }
    const header = request.headers.get("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const props = token ? await resolveBearer(env, token, request) : null;
    if (!props) return json({ error: "Unauthorized" }, 401);
    return json(await dispatch(request, env, ctx, props, url.pathname));
  } catch (error) {
    const message = error instanceof ClickError ? error.message : "Click failed.";
    const status = message === "Click failed." ? 500 : 400;
    if (status === 500) {
      console.error(JSON.stringify({ message: "api_failed", error: error instanceof Error ? error.message : "error" }));
    }
    return json({ error: message }, status);
  }
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
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
