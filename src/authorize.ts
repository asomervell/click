import {
  AuthorizationError,
  CimdFetchError,
  getOAuthApi,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { ownerKeyConfigured, ownerKeyMatches, sha256Hex } from "./crypto";
import { getHub } from "./hub";
import { escapeHtml, htmlResponse, page } from "./pages";
import { providerOptions } from "./provider";
import { cleanLabel } from "./validate";

function oauth(request: Request, env: Env): OAuthHelpers {
  // A fresh helper per request. The library caches the first one on env, which
  // would pin every later sign-in to whichever host was hit first.
  return getOAuthApi(providerOptions(new URL(request.url).origin), env);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  if (!ownerKeyConfigured(env.OWNER_KEY_HASH)) {
    console.error(JSON.stringify({ message: "owner_key_unconfigured" }));
    return htmlResponse(page("Click", `<h1>Click</h1><p>The owner key hash is not set. Run <code>wrangler secret put OWNER_KEY_HASH</code>.</p>`), 500);
  }
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
  const body = `<h1>Sign in to Click</h1>
    <p>Allow <strong>${escapeHtml(details.clientName)}</strong> to use the mailbox as its own agent.</p>
    ${domain}
    <p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
    ${loopback}
    <form method="post">
      <input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">
      ${scopeFields}
      <label for="key">Owner key or invite</label>
      <input id="key" name="key" type="password" autocomplete="current-password" required>
      <label for="label">Label for this connection (optional)</label>
      <input id="label" name="label" maxlength="80" autocomplete="off">
      <p>
        <button name="decision" value="approve">Allow</button>
        <button class="secondary" name="decision" value="deny">Deny</button>
      </p>
    </form>
    <p class="muted">The key proves you may join. This connection then gets its own identity, not the owner key. A client that cannot do OAuth can <a href="/keys">mint a bearer token</a>.</p>`;
  return htmlResponse(page("Sign in to Click", body), 200, consent.headers);
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
  const key = String(form.get("key") ?? "");
  let label: string | null;
  try {
    label = cleanLabel(form.get("label"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid label";
    return retry(handle, message);
  }
  const principal = await acceptCredential(env, key, label);
  if (!principal) return retry(handle, "That key or invite was not recognized.");
  const scope = form.getAll("scope").map(String).filter((item) => item === "click" || item === "offline_access");
  if (!scope.includes("click")) return retry(handle, "Click access has to stay selected.");
  const approved = await api.approveConsent(request, handle, { scope });
  const { redirectTo } = await api.completeAuthorization({
    request: approved.request,
    userId: principal.principalId,
    metadata: { label },
    scope: approved.request.scope,
    props: principal,
  });
  approved.headers.set("location", redirectTo);
  approved.headers.set("cache-control", "no-store");
  approved.headers.set("referrer-policy", "no-referrer");
  return new Response(null, { status: 302, headers: approved.headers });
}

function retry(handle: string, message: string): Response {
  const body = `<h1>Sign in to Click</h1>
    <p class="error">${escapeHtml(message)}</p>
    <form method="post">
      <input type="hidden" name="handle" value="${escapeHtml(handle)}">
      <input type="hidden" name="scope" value="click">
      <label for="key">Owner key or invite</label>
      <input id="key" name="key" type="password" autocomplete="current-password" required>
      <label for="label">Label for this connection (optional)</label>
      <input id="label" name="label" maxlength="80" autocomplete="off">
      <p><button name="decision" value="approve">Allow</button></p>
    </form>`;
  return htmlResponse(page("Sign in to Click", body), 200);
}

async function acceptCredential(env: Env, key: string, label: string | null) {
  if (await ownerKeyMatches(key, env.OWNER_KEY_HASH)) return getHub(env).createMember(label);
  if (!key.startsWith("clk_inv_")) return null;
  return getHub(env).consumeInviteHash(await sha256Hex(key), label);
}
