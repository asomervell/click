import {
  deleteClick,
  type Identity,
  joinWithInvite,
  joinWithInviteToken,
  listClicks,
  loadIdentity,
  renameClick,
  resolveBearer,
  rotateClickKey,
  selectClick,
  startCreateClick,
  verifyCreateClick,
} from "./clicks";
import { getHub } from "./hub";
import { ClickError } from "./types";
import { cleanLabel } from "./validate";

export async function handleHttpApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const path = versionedPath(url.pathname);
  if (!path) return null;
  try {
    const header = request.headers.get("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const home = token ? await resolveBearer(env, token, request) : null;
    if (request.method === "POST" && path === "/api/clicks") {
      const body = await readJson(request);
      // A signed-in agent that creates a click gets it added to its own memberships.
      const accountId = home && home.role !== "operator" ? home.principalId : null;
      const started = await startCreateClick(env, { email: String(body.email ?? ""), name: body.name, request, accountId });
      return json(started, started.status === "created" ? 201 : 202);
    }
    if (request.method === "POST" && path === "/api/clicks/verify") {
      const body = await readJson(request);
      return json(await verifyCreateClick(env, String(body.pending_id ?? ""), String(body.code ?? "")), 201);
    }
    if (request.method === "POST" && path === "/api/clicks/join") {
      const body = await readJson(request);
      if (body.click_key != null && body.invite == null) {
        throw new ClickError("Joining with the click key was removed: the key is the admin credential. Ask the click admin for an invite and send {\"invite\":\"clk_inv_...\"}.");
      }
      const label = cleanLabel(body.label);
      if (home && home.role !== "operator") {
        const identity = await loadIdentity(env, home);
        if (!identity) return problem(401, "Unauthorized", "unauthorized");
        const joined = await joinWithInvite(env, String(body.invite ?? ""), label, identity.accountId);
        return json({ click_id: joined.clickId, name: joined.clickName, principal_id: joined.principalId, role: joined.role, added_to_existing_identity: true }, 201);
      }
      const joined = await joinWithInviteToken(env, String(body.invite ?? ""), label);
      return json({ token: joined.token, click_id: joined.clickId, name: joined.clickName, principal_id: joined.principalId, role: joined.role }, 201);
    }
    if (!home) return problem(401, "Unauthorized", "unauthorized");
    const identity = await loadIdentity(env, home);
    if (!identity) return problem(401, "Unauthorized", "unauthorized");
    const body = request.method === "POST" || request.method === "PATCH" ? await readJson(request) : {};
    const result = await dispatch(request, env, ctx, identity, path, url, body);
    const created = request.method === "POST" && (path === "/api/tokens" || path === "/api/invites");
    return json(result, created ? 201 : 200);
  } catch (error) {
    const message = errorMessage(error);
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

// Durable Object RPC drops the ClickError class, so the message is the signal.
function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "JSON object required.";
  const message = error instanceof Error ? error.message : "";
  if (error instanceof ClickError) return message;
  if (!message || /sql|sqlite|durable object|internal error/i.test(message)) return "Click failed.";
  return message;
}

function statusFor(message: string): number {
  if (/too many|try again in a few|wait a minute|wait and try|try again in an hour|try again tomorrow|wait 15 minutes/i.test(message)) return 429;
  if (message === "Unknown API route.") return 404;
  if (message === "Click failed.") return 500;
  return 400;
}

function selector(request: Request, url: URL, body: Record<string, unknown>): string | null {
  const fromBody = typeof body.click === "string" ? body.click : null;
  return url.searchParams.get("click") ?? request.headers.get("x-click-id") ?? fromBody;
}

function optionalString(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

async function dispatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  identity: Identity,
  path: string,
  url: URL,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (request.method === "GET" && path === "/api/clicks") return listClicks(env, identity);
  const props = selectClick(identity, selector(request, url, body));
  const hub = getHub(env, props.clickId);
  if (request.method === "GET" && path === "/api/me") return hub.whoami(props);
  if (request.method === "PATCH" && path === "/api/me") {
    return hub.updateProfile(props, {
      name: optionalString(body.name),
      description: optionalString(body.description),
      webhook_url: optionalString(body.webhook_url),
      webhook_key: optionalString(body.webhook_key),
      clear_webhook: body.clear_webhook === true,
    });
  }
  if (request.method === "PATCH" && (path === "/api/click" || path === `/api/clicks/${props.clickId}`)) {
    return renameClick(env, props, body.name);
  }
  if (request.method === "GET" && path === "/api/agents") return hub.listAgents();
  if (request.method === "POST" && path === "/api/agents") {
    return hub.register(props, {
      handle: String(body.handle ?? ""),
      name: optionalString(body.name),
      description: optionalString(body.description),
      webhook_url: optionalString(body.webhook_url),
      webhook_key: optionalString(body.webhook_key),
    });
  }
  if (request.method === "DELETE" && path === "/api/agents/me") return hub.leave(props);
  if (request.method === "DELETE" && path.startsWith("/api/agents/")) {
    return hub.removeMember(props, decodeURIComponent(path.slice("/api/agents/".length)));
  }
  if (request.method === "POST" && path === "/api/messages") {
    const result = await hub.send(props, {
      text: String(body.text ?? ""),
      to: optionalString(body.to),
      topic: optionalString(body.topic),
      broadcast: body.broadcast === true,
    });
    ctx.waitUntil(hub.processWakes(Date.now(), props.clickId).catch(() => undefined));
    return { ...result, click: props.clickId };
  }
  if (request.method === "GET" && path === "/api/inbox") {
    const limit = url.searchParams.get("limit");
    return { click: props.clickId, click_name: props.clickName, ...(await hub.inbox(props, limit ? Number(limit) : undefined)) };
  }
  if (request.method === "POST" && path === "/api/ack") {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    return hub.ack(props, ids);
  }
  if (request.method === "GET" && path === "/api/key") return hub.showKey(props);
  if (request.method === "POST" && path === "/api/key/rotate") return rotateClickKey(env, props);
  if (request.method === "GET" && path === "/api/members") return hub.listMembers();
  if (request.method === "DELETE" && (path === "/api/clicks" || path === `/api/clicks/${props.clickId}`)) return deleteClick(env, props);
  if (request.method === "POST" && path === "/api/invites") {
    const hours = body.expires_in_hours == null ? undefined : Number(body.expires_in_hours);
    return hub.createInvite(props, cleanLabel(body.label), hours);
  }
  if (request.method === "GET" && path === "/api/invites") {
    return hub.listInvites(props, url.searchParams.get("include_closed") === "true");
  }
  if (request.method === "DELETE" && path.startsWith("/api/invites/")) {
    const inviteId = decodeURIComponent(path.slice("/api/invites/".length));
    if (!inviteId || inviteId.includes("/")) throw new ClickError("Unknown API route.");
    return hub.revokeInvite(props, inviteId);
  }
  if (request.method === "GET" && path === "/api/tokens") return hub.listTokens(props);
  if (request.method === "POST" && path === "/api/tokens") {
    return hub.mintToken(props, {
      handle: body.handle ? String(body.handle) : undefined,
      name: body.name ? String(body.name) : undefined,
      label: body.label ? String(body.label) : undefined,
    });
  }
  if (request.method === "DELETE" && path.startsWith("/api/tokens/")) {
    const tokenId = decodeURIComponent(path.slice("/api/tokens/".length));
    if (!tokenId || tokenId.includes("/")) throw new ClickError("Unknown API route.");
    return hub.revokeToken(props, tokenId);
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
