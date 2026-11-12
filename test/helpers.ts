import { SELF } from "cloudflare:test";
import { base64url } from "../src/crypto";
import { testOutbox } from "../src/email";

export const OWNER_KEY = "click-test-owner-key";
export const LOCAL = "http://127.0.0.1:8787";

/** The last "your click is ready" page the OAuth helper saw. */
export let lastHandoffPage = "";

export function handle(prefix: string): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  const suffix = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${suffix}`;
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = base64url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function cookies(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0] ?? "").filter(Boolean).join("; ");
}

export async function parseMcp(response: Response): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const text = await response.text();
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const raw = data.at(-1) ?? text;
  return { status: response.status, text, body: JSON.parse(raw) as Record<string, unknown> };
}

function mcpHeaders(origin: string, token: string, clickId?: string): Headers {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    host: new URL(origin).host,
  });
  if (clickId) headers.set("x-click-id", clickId);
  return headers;
}

export async function mcpCall(origin: string, token: string, method: string, params?: unknown, id = 1, clickId?: string): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(`${origin}/mcp`, {
    method: "POST",
    headers: mcpHeaders(origin, token, clickId),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const parsed = await parseMcp(response);
  if (parsed.status !== 200) throw new Error(`MCP ${method} HTTP ${parsed.status}: ${parsed.text}`);
  return parsed.body;
}

export async function initialize(origin: string, token: string, clickId?: string): Promise<void> {
  const init = await mcpCall(origin, token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "click-test", version: "0" },
  }, 1, clickId);
  const result = init.result as { protocolVersion?: string } | undefined;
  if (!result?.protocolVersion) throw new Error(`initialize failed: ${JSON.stringify(init)}`);
  await SELF.fetch(`${origin}/mcp`, {
    method: "POST",
    headers: mcpHeaders(origin, token, clickId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
}

export async function callTool(origin: string, token: string, name: string, args: Record<string, unknown> = {}, clickId?: string): Promise<unknown> {
  const body = await mcpCall(origin, token, "tools/call", { name, arguments: args }, 2, clickId);
  const result = body.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(text);
  return JSON.parse(text) as unknown;
}

export function lastCode(email: string): string {
  const mail = [...testOutbox].reverse().find((item) => item.to === email.toLowerCase());
  if (!mail) throw new Error(`no verification mail for ${email}`);
  return mail.code;
}

export function testEmail(): string {
  return `person-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

export async function startCreate(origin: string, email: string, extra: Record<string, unknown> = {}, bearer?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: new URL(origin).host,
    "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await SELF.fetch(`${origin}/api/v1/clicks`, { method: "POST", headers, body: JSON.stringify({ email, ...extra }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

export async function verifyCreate(origin: string, pendingId: string, code: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await SELF.fetch(`${origin}/api/v1/clicks/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", host: new URL(origin).host },
    body: JSON.stringify({ pending_id: pendingId, code }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Create a click through the two-step email verification flow. */
export async function createClick(origin = LOCAL, extra: Record<string, unknown> = {}): Promise<{ click_id: string; click_key: string; principal_id: string; first_invite_id: string }> {
  const email = testEmail();
  const started = await startCreate(origin, email, extra);
  if (started.status !== 202 || typeof started.body.pending_id !== "string") {
    throw new Error(`create click ${started.status}: ${JSON.stringify(started.body)}`);
  }
  const verified = await verifyCreate(origin, started.body.pending_id, lastCode(email));
  const body = verified.body as { click_id?: string; click_key?: string; principal_id?: string; first_invite?: { id: string } };
  if (verified.status !== 201 || !body.click_key || !body.click_id || !body.principal_id) {
    throw new Error(`verify click ${verified.status}: ${JSON.stringify(body)}`);
  }
  return { click_id: body.click_id, click_key: body.click_key, principal_id: body.principal_id, first_invite_id: String(body.first_invite?.id) };
}

export async function signIn(origin: string, input: { email?: string; key?: string; originHeader?: string | null }): Promise<string> {
  const registered = await SELF.fetch(new Request(`${origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "click-test",
      redirect_uris: ["http://127.0.0.1:8765/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  }));
  const registration = await registered.json() as { client_id?: string };
  if (!registered.ok || !registration.client_id) {
    throw new Error(`register ${registered.status}: ${JSON.stringify(registration)}`);
  }
  const { verifier, challenge } = await pkce();
  const authorize = new URL(`${origin}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", registration.client_id);
  authorize.searchParams.set("redirect_uri", "http://127.0.0.1:8765/callback");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", "state-1");
  authorize.searchParams.set("scope", "click offline_access");
  authorize.searchParams.set("resource", `${origin}/mcp`);
  const page = await SELF.fetch(new Request(authorize, { redirect: "manual" }));
  const html = await page.text();
  if (page.status !== 200) {
    throw new Error(`authorize ${page.status} ${page.headers.get("location") ?? ""}: ${html}`);
  }
  const rawHandle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  const handle = rawHandle?.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!handle || !csrf) throw new Error(`consent handle missing: ${html}`);
  const form = new URLSearchParams();
  form.set("handle", handle);
  form.set("csrf", csrf);
  form.set("mode", input.email ? "create" : "join");
  if (input.email) form.set("email", input.email);
  if (input.key) form.set("key", input.key);
  form.set("decision", "approve");
  form.set("label", "test-bot");
  form.append("scope", "click");
  form.append("scope", "offline_access");
  const post = (body: URLSearchParams) => SELF.fetch(new Request(`${origin}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookies(page),
      ...(input.originHeader === null ? {} : { origin: input.originHeader ?? origin }),
    },
    body,
  }));
  let posted = await post(form);
  if (input.email && posted.status === 200) {
    const codePage = await posted.text();
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(codePage)?.[1];
    if (!pendingId) throw new Error(`no code form: ${codePage}`);
    const verify = new URLSearchParams();
    verify.set("handle", handle);
    verify.set("csrf", csrf);
    verify.set("mode", "verify");
    verify.set("pending_id", pendingId);
    verify.set("email", input.email);
    verify.set("code", lastCode(input.email));
    verify.set("decision", "approve");
    verify.append("scope", "click");
    verify.append("scope", "offline_access");
    posted = await post(verify);
  }
  let location = posted.headers.get("location");
  if (input.email && posted.status === 200) {
    // A new click: the person sees its admin key and first invite, then continues.
    const ready = await posted.text();
    if (!ready.includes('id="admin-key"') || !ready.includes('id="invite-line"')) throw new Error(`no handoff page: ${ready}`);
    if (!ready.includes("Save this somewhere safe. If you lose it, you lose the Click.")) throw new Error("handoff page is missing the key notice");
    lastHandoffPage = ready;
    location = /data-href="([^"]+)"/.exec(ready)?.[1]?.replaceAll("&amp;", "&") ?? null;
    if (!location) throw new Error(`no continue link: ${ready}`);
  } else if (posted.status !== 302 || !location) {
    throw new Error(`consent ${posted.status}: ${await posted.text()}`);
  }
  const redirected = new URL(location);
  if (redirected.searchParams.get("error")) {
    throw new Error(`oauth error ${redirected.searchParams.get("error")}: ${redirected.searchParams.get("error_description")}`);
  }
  const code = redirected.searchParams.get("code");
  if (!code) throw new Error(`missing code: ${location}`);
  const token = await SELF.fetch(new Request(`${origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:8765/callback",
      client_id: registration.client_id,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  }));
  const issued = await token.json() as { access_token?: string; error?: string };
  if (!token.ok || !issued.access_token) throw new Error(`token ${token.status}: ${JSON.stringify(issued)}`);
  return issued.access_token;
}

export async function api(
  origin: string,
  token: string,
  path: string,
  init: { method?: string; body?: unknown; clickId?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${token}`,
    host: new URL(origin).host,
  });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.clickId) headers.set("x-click-id", init.clickId);
  const response = await SELF.fetch(`${origin}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await response.json() as unknown;
  return { status: response.status, body };
}
