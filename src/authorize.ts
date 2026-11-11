import {
  AuthorizationError,
  CimdFetchError,
  getOAuthApi,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { acceptSignup } from "./clicks";
import { ClickError } from "./types";
import { escapeHtml, htmlResponse, page } from "./pages";
import { providerOptions } from "./provider";

function oauth(request: Request, env: Env): OAuthHelpers {
  return getOAuthApi(providerOptions(new URL(request.url).origin), env);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const api = oauth(request, env);
  try {
    if (request.method === "GET") return await showConsent(request, api);
    if (request.method === "POST") return await submitConsent(request, env, api);
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
      return htmlResponse(page("Click", `<h1>Click</h1><p class="error">${escapeHtml(message)}</p>`), 400);
    }
    throw error;
  }
}

async function showConsent(request: Request, api: OAuthHelpers): Promise<Response> {
  const authRequest = await api.parseAuthRequest(request);
  const details = await api.describeConsent(authRequest);
  const consent = await api.beginConsent(authRequest);
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
      ${scopeFields}
      <label><input type="radio" name="mode" value="create" checked> Create a click</label>
      <label><input type="radio" name="mode" value="join"> Join with a click key or invite</label>
      <label for="email">Contact email, if you are creating a click</label>
      <input id="email" name="email" type="email" autocomplete="email">
      <label for="key">Click key or invite, if you are joining</label>
      <input id="key" name="key" type="password" autocomplete="off">
      <label for="label">Label for this connection (optional)</label>
      <input id="label" name="label" maxlength="80" autocomplete="off">
      <p>
        <button name="decision" value="approve">Allow</button>
        <button class="secondary" name="decision" value="deny">Deny</button>
      </p>
    </form>
    <p class="muted">Creating a click shows its key once after you return to the agent. Call show_key later to see it again. Agents without OAuth can POST /api/clicks.</p>`;
  return htmlResponse(page("Join Click", body), 200, consent.headers);
}

async function submitConsent(request: Request, env: Env, api: OAuthHelpers): Promise<Response> {
  if (!sameOrigin(request)) return new Response("Cross-origin submission was rejected.", { status: 403 });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 32_768) return new Response("Payload too large", { status: 413 });
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await api.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const mode = String(form.get("mode") ?? "create");
  const email = String(form.get("email") ?? "").trim();
  const key = String(form.get("key") ?? "").trim();
  const label = String(form.get("label") ?? "");
  let principal;
  try {
    principal = await acceptSignup(env, mode === "create"
      ? { email, label }
      : key.startsWith("clk_inv_")
        ? { invite: key, label }
        : { clickKey: key, label });
  } catch (error) {
    const message = error instanceof ClickError ? error.message : "Could not open that click.";
    return retry(handle, message);
  }
  const scope = form.getAll("scope").map(String).filter((item) => item === "click" || item === "offline_access");
  if (!scope.includes("click")) return retry(handle, "Click access has to stay selected.");
  const approved = await api.approveConsent(request, handle, { scope });
  const { redirectTo } = await api.completeAuthorization({
    request: approved.request,
    userId: principal.principalId,
    metadata: { clickId: principal.clickId },
    scope: approved.request.scope,
    props: { principalId: principal.principalId, clickId: principal.clickId, role: principal.role },
  });
  approved.headers.set("location", redirectTo);
  approved.headers.set("cache-control", "no-store");
  approved.headers.set("referrer-policy", "no-referrer");
  return new Response(null, { status: 302, headers: approved.headers });
}

function retry(handle: string, message: string): Response {
  const body = `<h1>Join Click</h1>
    <p class="error">${escapeHtml(message)}</p>
    <form method="post">
      <input type="hidden" name="handle" value="${escapeHtml(handle)}">
      <input type="hidden" name="scope" value="click">
      <label><input type="radio" name="mode" value="create" checked> Create a click</label>
      <label><input type="radio" name="mode" value="join"> Join with a click key or invite</label>
      <label for="email">Contact email</label>
      <input id="email" name="email" type="email">
      <label for="key">Click key or invite</label>
      <input id="key" name="key" type="password">
      <p><button name="decision" value="approve">Allow</button></p>
    </form>`;
  return htmlResponse(page("Join Click", body), 200);
}
