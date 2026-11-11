import {
  AuthorizationError,
  CimdFetchError,
  getOAuthApi,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { base64url, sha256Hex } from "./crypto";
import { joinWithInvite, signInWithKey, startCreateClick, verifyCreateClick } from "./clicks";
import { ClickError, type ClickProps } from "./types";
import { cleanLabel } from "./validate";
import { escapeHtml, htmlResponse, page } from "./pages";
import { providerOptions } from "./provider";

function oauth(request: Request, env: Env): OAuthHelpers {
  return getOAuthApi(providerOptions(new URL(request.url).origin), env);
}

const CSRF_TTL_SECONDS = 600;

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Safari sends the literal "null" after a cross-site redirect into a page
  // with Referrer-Policy: no-referrer. A missing Origin is the same case.
  return !origin || origin === "null" || origin === new URL(request.url).origin;
}

async function csrfCookieName(handle: string): Promise<string> {
  const hash = await sha256Hex(handle);
  return `__Host-click-${hash.slice(0, 32)}`;
}

function csrfCookie(name: string, token: string): string {
  return `${name}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${CSRF_TTL_SECONDS}`;
}

function clearCsrfCookie(name: string): string {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function tokensMatch(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.byteLength === 0 || a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const api = oauth(request, env);
  try {
    if (request.method === "GET") return await showConsent(request, api);
    if (request.method === "POST") return await submitConsent(request, env, api);
    return signInProblem("Use the sign-in form.", 405, { allow: "GET, POST" });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
      return htmlResponse(page("Click", `<h1>Sign-in stopped</h1><p class="error">${escapeHtml(message)}</p><p><button type="button" onclick="history.back()">Go back</button></p><p class="muted"><a href="/">Click home</a></p>`), 400);
    }
    throw error;
  }
}

async function showConsent(request: Request, api: OAuthHelpers): Promise<Response> {
  const authRequest = await api.parseAuthRequest(request);
  const details = await api.describeConsent(authRequest);
  const consent = await api.beginConsent(authRequest);
  const csrf = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const csrfName = await csrfCookieName(consent.handle);
  const scopes = details.scope.length > 0 ? details.scope : ["click"];
  const domain = details.clientDomain
    ? `<p>Published by <strong>${escapeHtml(details.clientDomain)}</strong>.</p>`
    : `<p class="muted">This app registered itself. Its name is not verified.</p>`;
  const loopback = details.redirectIsLoopback
    ? `<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>`
    : "";
  const scopeFields = scopes
    .map((scope) => `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`)
    .join("");
  const body = `<h1>Join Click</h1>
    <p>Allow <strong>${escapeHtml(details.clientName)}</strong> to use one click as its own agent.</p>
    ${domain}
    <p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
    ${loopback}
    <form method="post">
      <input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      ${scopeFields}
      <label><input type="radio" name="mode" value="create" checked> Create a click</label>
      <label><input type="radio" name="mode" value="join"> Join a click with an invite</label>
      <label for="email">Your email, if you are creating a click. We email you a 6-digit code.</label>
      <input id="email" name="email" type="email" autocomplete="email">
      <label for="click_name">Click name (optional)</label>
      <input id="click_name" name="click_name" maxlength="60" autocomplete="off">
      <label for="key">Invite, if you are joining. Ask the click's admin for one.</label>
      <input id="key" name="key" type="password" autocomplete="off">
      <label for="label">Label for this connection (optional)</label>
      <input id="label" name="label" maxlength="80" autocomplete="off">
      <p>
        <button name="decision" value="approve">Allow</button>
        <button class="secondary" name="decision" value="deny">Deny</button>
      </p>
    </form>
    <p class="muted">To join a click, ask its admin for an invite. Admins can also paste their click key here to sign in as the admin. Agents without OAuth can POST /api/v1/clicks.</p>`;
  const headers = new Headers(consent.headers);
  headers.append("Set-Cookie", csrfCookie(csrfName, csrf));
  return htmlResponse(page("Join Click", body), 200, headers);
}

async function submitConsent(request: Request, env: Env, api: OAuthHelpers): Promise<Response> {
  if (!sameOrigin(request)) return signInProblem("This sign-in was submitted from another site. Go back and use the Click form.");
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 32_768) return signInProblem("That form was too large.", 413);
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  const csrfName = await csrfCookieName(handle);
  const presented = String(form.get("csrf") ?? "");
  const stored = readCookie(request, csrfName) ?? "";
  if (!tokensMatch(presented, stored)) {
    return signInProblem("This sign-in page expired. Go back and submit the form again.");
  }
  if (form.get("decision") !== "approve") {
    const denied = await api.denyConsent(request, handle);
    denied.headers.append("Set-Cookie", clearCsrfCookie(csrfName));
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const mode = String(form.get("mode") ?? "create");
  const email = String(form.get("email") ?? "").trim();
  const key = String(form.get("key") ?? "").trim();
  const label = cleanLabelSafe(String(form.get("label") ?? ""));
  const scopes = form.getAll("scope").map(String).filter((item) => item === "click" || item === "offline_access");
  let principal: ClickProps;
  try {
    if (mode === "verify") {
      const created = await verifyCreateClick(env, String(form.get("pending_id") ?? ""), String(form.get("code") ?? ""));
      principal = { principalId: created.principal_id, clickId: created.click_id, role: "admin" };
    } else if (mode === "create") {
      const started = await startCreateClick(env, { email, name: form.get("click_name"), request, accountId: null });
      if (started.status === "verification_sent") {
        return codeForm({ handle, csrf: presented, pendingId: started.pending_id, email: started.email, scopes, label, message: null });
      }
      principal = { principalId: started.principal_id, clickId: started.click_id, role: "admin" };
    } else if (key.startsWith("clk_inv_")) {
      const joined = await joinWithInvite(env, key, label);
      principal = { principalId: joined.principalId, clickId: joined.clickId, role: joined.role };
    } else if (key) {
      principal = await signInWithKey(env, key);
    } else {
      throw new ClickError("Paste the invite you got from the click admin.");
    }
  } catch (error) {
    const message = error instanceof ClickError || (error instanceof Error && !/sql|durable object|internal/i.test(error.message))
      ? (error as Error).message
      : "Could not open that click.";
    if (mode === "verify") {
      return codeForm({
        handle,
        csrf: presented,
        pendingId: String(form.get("pending_id") ?? ""),
        email: String(form.get("email") ?? ""),
        scopes,
        label,
        message,
      });
    }
    return retry(handle, presented, message);
  }
  const scope = scopes;
  if (!scope.includes("click")) return retry(handle, presented, "Click access has to stay selected.");
  const approved = await api.approveConsent(request, handle, { scope });
  const { redirectTo } = await api.completeAuthorization({
    request: approved.request,
    userId: principal.principalId,
    metadata: { clickId: principal.clickId },
    scope: approved.request.scope,
    props: { principalId: principal.principalId, clickId: principal.clickId, role: principal.role },
  });
  approved.headers.append("Set-Cookie", clearCsrfCookie(csrfName));
  approved.headers.set("location", redirectTo);
  approved.headers.set("cache-control", "no-store");
  approved.headers.set("referrer-policy", "no-referrer");
  return new Response(null, { status: 302, headers: approved.headers });
}

function retry(handle: string, csrf: string, message: string): Response {
  const body = `<h1>Join Click</h1>
    <p class="error">${escapeHtml(message)}</p>
    <form method="post">
      <input type="hidden" name="handle" value="${escapeHtml(handle)}">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="scope" value="click">
      <label><input type="radio" name="mode" value="create" checked> Create a click</label>
      <label><input type="radio" name="mode" value="join"> Join a click with an invite</label>
      <label for="email">Your email. We email you a 6-digit code.</label>
      <input id="email" name="email" type="email">
      <label for="click_name">Click name (optional)</label>
      <input id="click_name" name="click_name" maxlength="60">
      <label for="key">Invite from the click's admin</label>
      <input id="key" name="key" type="password">
      <p><button name="decision" value="approve">Allow</button></p>
    </form>
    <p class="muted"><button type="button" onclick="history.back()">Go back</button> <a href="/">Click home</a></p>`;
  return htmlResponse(page("Join Click", body), 400);
}

function codeForm(input: {
  handle: string;
  csrf: string;
  pendingId: string;
  email: string;
  scopes: string[];
  label: string | null;
  message: string | null;
}): Response {
  const scopeFields = (input.scopes.length > 0 ? input.scopes : ["click"])
    .map((scope) => `<input type="hidden" name="scope" value="${escapeHtml(scope)}">`)
    .join("");
  const body = `<h1>Check your email</h1>
    ${input.message ? `<p class="error">${escapeHtml(input.message)}</p>` : ""}
    <p>We sent a 6-digit code to <strong>${escapeHtml(input.email)}</strong>. It expires in 15 minutes. The click is created only after you enter it.</p>
    <form method="post">
      <input type="hidden" name="handle" value="${escapeHtml(input.handle)}">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
      <input type="hidden" name="mode" value="verify">
      <input type="hidden" name="pending_id" value="${escapeHtml(input.pendingId)}">
      <input type="hidden" name="email" value="${escapeHtml(input.email)}">
      <input type="hidden" name="label" value="${escapeHtml(input.label ?? "")}">
      ${scopeFields}
      <label for="code">Code</label>
      <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>
      <p><button name="decision" value="approve">Verify and allow</button></p>
    </form>
    <p class="muted">No email? Check spam, or go back and start again.</p>`;
  return htmlResponse(page("Check your email", body), input.message ? 400 : 200);
}

function cleanLabelSafe(raw: string): string | null {
  try {
    return cleanLabel(raw);
  } catch {
    return null;
  }
}

function signInProblem(message: string, status = 403, extra?: HeadersInit): Response {
  const body = `<h1>Sign-in stopped</h1>
    <p class="error">${escapeHtml(message)}</p>
    <p><button type="button" onclick="history.back()">Go back</button></p>
    <p class="muted"><a href="/">Click home</a>. Start the connection again from your agent if the form is gone.</p>`;
  return htmlResponse(page("Sign-in stopped", body), status, extra ? new Headers(extra) : undefined);
}
