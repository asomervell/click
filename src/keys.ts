import { ownerKeyConfigured, ownerKeyMatches } from "./crypto";
import { getHub } from "./hub";
import { ClickError } from "./types";
import { escapeHtml, htmlResponse, page } from "./pages";
import { cleanLabel } from "./validate";

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function handleKeys(request: Request, env: Env): Promise<Response> {
  if (!ownerKeyConfigured(env.OWNER_KEY_HASH)) {
    return htmlResponse(page("Click", `<h1>Click</h1><p>The owner key hash is not set.</p>`), 500);
  }
  if (request.method === "GET") return htmlResponse(page("Mint a Click token", form("")), 200);
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!sameOrigin(request)) return new Response("Cross-origin submission was rejected.", { status: 403 });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 32_768) return new Response("Payload too large", { status: 413 });
  const body = await request.formData();
  const key = String(body.get("key") ?? "");
  if (!(await ownerKeyMatches(key, env.OWNER_KEY_HASH))) {
    return htmlResponse(page("Mint a Click token", form("That owner key was not recognized.")), 401);
  }
  const action = String(body.get("action") ?? "mint");
  let label: string | null;
  try {
    label = cleanLabel(body.get("label"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid label";
    return htmlResponse(page("Mint a Click token", form(message)), 400);
  }
  const hub = getHub(env);
  const owner = { principalId: "owner", role: "owner" as const };
  try {
    if (action === "invite") {
      const invite = await hub.createInvite(owner, label);
      return htmlResponse(page("Invite", result("Invite", invite.invite, "Enter this on the Click sign-in page instead of the owner key. It works once.")), 200);
    }
    const handle = String(body.get("handle") ?? "").trim();
    const name = String(body.get("name") ?? "").trim();
    const minted = await hub.mintToken(owner, {
      label,
      role: "member",
      handle: handle || undefined,
      name: name || undefined,
    });
    return htmlResponse(page("Bearer token", result(
      "Bearer token",
      minted.token,
      `Send it as Authorization: Bearer. Token id ${minted.token_id}. It works until the owner revokes it.`,
    )), 200);
  } catch (error) {
    const message = error instanceof ClickError ? error.message : "Could not mint.";
    return htmlResponse(page("Mint a Click token", form(message)), 400);
  }
}

function form(error: string): string {
  const banner = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<h1>Mint a token</h1>
    <p>For a client that cannot complete OAuth. This page checks the owner key and shows the secret once.</p>
    ${banner}
    <form method="post">
      <label for="key">Owner key</label>
      <input id="key" name="key" type="password" autocomplete="current-password" required>
      <label for="label">Label (optional)</label>
      <input id="label" name="label" maxlength="80">
      <label for="handle">Handle to register now (optional)</label>
      <input id="handle" name="handle" maxlength="32" autocapitalize="none">
      <label for="name">Display name (optional)</label>
      <input id="name" name="name" maxlength="80">
      <p>
        <button name="action" value="mint">Mint bearer token</button>
        <button class="secondary" name="action" value="invite">Create invite</button>
      </p>
    </form>`;
}

function result(title: string, secret: string, note: string): string {
  return `<h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(note)}</p>
    <p class="secret">${escapeHtml(secret)}</p>
    <p class="muted">This is the only time Click will show it.</p>`;
}
