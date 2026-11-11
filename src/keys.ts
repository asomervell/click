import { joinWithInviteToken, startCreateClick, verifyCreateClick } from "./clicks";
import { ClickError } from "./types";
import { escapeHtml, htmlResponse, page } from "./pages";

function keyPage(clickKey: string, clickId: string, verified: boolean): Response {
  const note = verified ? "" : `<p class="muted">This server is not verifying emails yet.</p>`;
  return htmlResponse(page("Click key", `<h1>Click key</h1><p>This is the admin credential for your click. Keep it private. To add an agent, create an invite (create_invite or POST /api/v1/invites) and give them that instead.</p><p class="secret">${escapeHtml(clickKey)}</p><p>Click id <code>${escapeHtml(clickId)}</code></p>${note}`), 200);
}

function codePage(pendingId: string, email: string, message: string | null): Response {
  return htmlResponse(page("Check your email", `<h1>Check your email</h1>
    ${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
    <p>We sent a 6-digit code to <strong>${escapeHtml(email)}</strong>. It expires in 15 minutes.</p>
    <form method="post">
      <input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}">
      <input type="hidden" name="email" value="${escapeHtml(email)}">
      <label for="code">Code</label>
      <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>
      <p><button>Verify</button></p>
    </form>`), message ? 400 : 200);
}

export async function handleKeys(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return htmlResponse(page("Click", `<h1>Click without OAuth</h1>
      <p>Create a click, or join one with an invite from its admin. Secrets are shown once on this page.</p>
      <form method="post">
        <label for="email">Your email, to create a click. We email you a 6-digit code.</label>
        <input id="email" name="email" type="email">
        <label for="name">Click name (optional)</label>
        <input id="name" name="name" maxlength="60">
        <label for="invite">Invite, to join. Ask the click's admin for one.</label>
        <input id="invite" name="invite" type="password">
        <p><button>Continue</button></p>
      </form>`), 200);
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const form = await request.formData();
  const pendingId = String(form.get("pending_id") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  const invite = String(form.get("invite") ?? form.get("key") ?? "").trim();
  try {
    if (pendingId) {
      try {
        const created = await verifyCreateClick(env, pendingId, String(form.get("code") ?? ""));
        return keyPage(created.click_key, created.click_id, true);
      } catch (error) {
        return codePage(pendingId, email, error instanceof Error ? error.message : "Could not verify.");
      }
    }
    if (email) {
      const started = await startCreateClick(env, { email, name: form.get("name"), request, accountId: null });
      if (started.status === "verification_sent") return codePage(started.pending_id, started.email, null);
      return keyPage(started.click_key, started.click_id, false);
    }
    if (!invite.startsWith("clk_inv_")) throw new ClickError("Ask the click admin for an invite. The click key is not used to join.");
    const joined = await joinWithInviteToken(env, invite, null);
    return htmlResponse(page("Member token", `<h1>Member token</h1><p>Use it as Authorization: Bearer on /mcp or /api/v1.</p><p class="secret">${escapeHtml(joined.token)}</p>`), 200);
  } catch (error) {
    const message = error instanceof Error && !/sql|durable object|internal/i.test(error.message) ? error.message : "Could not continue.";
    return htmlResponse(page("Click", `<p class="error">${escapeHtml(message)}</p>`), 400);
  }
}
