import {
  deleteClick,
  purgeClick,
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
import { ownerKeyMatches } from "./crypto";
import { getDirectory } from "./directory";
import { doorbellLink } from "./doorbell";
import { getHub } from "./hub";
import { ackAcross, historyAcross, inboxAcross, routeSend } from "./routing";
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
      const started = await startCreateClick(env, { email: String(body.email ?? ""), name: body.name, request, accountId, origin: url.origin });
      return json(started, started.status === "created" ? 201 : 202);
    }
    if (request.method === "POST" && path === "/api/clicks/verify") {
      const body = await readJson(request);
      return json(await verifyCreateClick(env, String(body.pending_id ?? ""), String(body.code ?? ""), url.origin), 201);
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
    if (path.startsWith("/api/operator/")) {
      // Operator maintenance, only when the deployer set OWNER_KEY_HASH. No click id needed.
      if (!token || !(await ownerKeyMatches(token, env.OWNER_KEY_HASH))) return problem(401, "Unauthorized", "unauthorized");
      if (request.method === "GET" && path === "/api/operator/clicks") {
        const clicks = await getDirectory(env).allClicks();
        return json({ count: clicks.length, live: clicks.filter((c) => c.revoked_at == null).length, clicks }, 200);
      }
      if (request.method === "POST" && path === "/api/operator/purge") {
        const body = await readJson(request);
        const clickId = String(body.click_id ?? "");
        if (!clickId) throw new ClickError("Send click_id.");
        return json(await purgeClick(env, clickId), 200);
      }
      throw new ClickError("Unknown API route.");
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
    return problem(status, message, status === 429 ? "rate_limited" : status === 404 ? "not_found" : status === 500 ? "internal" : status === 409 ? "conflict" : /^Ambiguous:|needs click/.test(message) ? "ambiguous_click" : "invalid");
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
  if (message.startsWith("Click conflict:")) return 409;
  return 400;
}

function selector(request: Request, url: URL, body: Record<string, unknown>): string | null {
  const fromBody = typeof body.click === "string" ? body.click : null;
  return url.searchParams.get("click") ?? request.headers.get("x-click-id") ?? fromBody;
}

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  return raw == null || raw === "" ? undefined : Number(raw);
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
  const chosen = selector(request, url, body);
  if (request.method === "POST" && path === "/api/messages") {
    const routed = await routeSend(env, identity, {
      text: String(body.text ?? ""),
      to: optionalString(body.to),
      topic: optionalString(body.topic),
      broadcast: body.broadcast === true,
      reply_to: optionalString(body.reply_to),
      click: chosen,
    });
    const target = getHub(env, routed.props.clickId);
    const result = await target.send(routed.props, routed.send);
    ctx.waitUntil(target.processWakes(Date.now(), routed.props.clickId).catch(() => undefined));
    return { ...result, click: routed.props.clickId, click_name: routed.props.clickName };
  }
  if (request.method === "GET" && path === "/api/inbox") {
    return inboxAcross(env, identity, { click: chosen, limit: numberParam(url, "limit"), cursor: url.searchParams.get("cursor") });
  }
  if (request.method === "GET" && path === "/api/history") {
    return historyAcross(env, identity, {
      click: chosen,
      topic: url.searchParams.get("topic") ?? undefined,
      with: url.searchParams.get("with") ?? undefined,
      before: numberParam(url, "before"),
      limit: numberParam(url, "limit"),
      cursor: url.searchParams.get("cursor"),
    });
  }
  if (request.method === "POST" && path === "/api/ack") {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    return ackAcross(env, identity, { click: chosen, ids });
  }
  const props = selectClick(identity, chosen);
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
  if (request.method === "POST" && path === "/api/doorbell-link") return doorbellLink(env, props, url.origin);
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
