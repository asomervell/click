import { getDirectory } from "./directory";
import { getHub } from "./hub";
import { escapeHtml, htmlResponse, page } from "./pages";
import { type ClickProps, PRODUCTION_ORIGIN } from "./types";

/**
 * The doorbell link. An agent that cannot read its own webhook key (a Grok Bot routine, for
 * one) asks Click for a one-time link and gives it to its person. The person pastes the
 * routine's webhook URL and key here, on clickmcp.com, so the key never passes through chat.
 */
export async function doorbellLink(env: Env, props: ClickProps, origin: string = PRODUCTION_ORIGIN): Promise<{
  url: string;
  handle: string;
  expires_at: number;
  message_for_person: string;
}> {
  const link = await getHub(env, props.clickId).createDoorbellLink(props);
  const url = `${origin}/doorbell?c=${encodeURIComponent(props.clickId)}&t=${encodeURIComponent(link.token)}`;
  return {
    url,
    handle: link.handle,
    expires_at: link.expires_at,
    message_for_person: `To wake me instantly when Click mail arrives, open this link and paste my doorbell routine's webhook URL and key there (not in this chat). It works once, for 30 minutes:\n${url}`,
  };
}

function form(clickId: string, token: string, handle: string, clickName: string | null, message: string | null): Response {
  const where = clickName ? ` in ${escapeHtml(clickName)}` : "";
  return htmlResponse(page("Set up the doorbell", `<h1>Set up the doorbell</h1>
    ${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
    <p>This wakes <strong>${escapeHtml(handle)}</strong>${where} as soon as a Click message arrives. Paste its routine's webhook URL and webhook key. They go straight to Click and never through chat.</p>
    <form method="post">
      <input type="hidden" name="c" value="${escapeHtml(clickId)}">
      <input type="hidden" name="t" value="${escapeHtml(token)}">
      <label for="url">Webhook URL</label>
      <input id="url" name="url" type="url" required autocomplete="off">
      <label for="key">Webhook key</label>
      <input id="key" name="key" type="password" required autocomplete="off">
      <p><button>Save doorbell</button></p>
    </form>
    <p class="muted">The link works once and expires 30 minutes after your agent made it.</p>`), message ? 400 : 200);
}

function closed(message: string, status = 400): Response {
  return htmlResponse(page("Doorbell", `<h1>Doorbell</h1><p class="error">${escapeHtml(message)}</p><p class="muted">Ask your agent for a new doorbell link.</p>`), status);
}

export async function handleDoorbell(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let clickId = url.searchParams.get("c") ?? "";
  let token = url.searchParams.get("t") ?? "";
  let posted: FormData | null = null;
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    if (origin && origin !== "null" && origin !== url.origin) return closed("This form was submitted from another site.", 403);
    posted = await request.formData();
    clickId = String(posted.get("c") ?? "");
    token = String(posted.get("t") ?? "");
  } else if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  if (!clickId || !token.startsWith("clk_bell_")) return closed("This doorbell link is incomplete.");
  let hub;
  try {
    if (!(await getDirectory(env).clickExists(clickId))) return closed("This doorbell link expired or was already used.");
    hub = getHub(env, clickId);
  } catch {
    return closed("This doorbell link expired or was already used.");
  }
  const info = await hub.doorbellLinkInfo(token);
  if (!info) return closed("This doorbell link expired or was already used.");
  if (!posted) return form(clickId, token, info.handle, info.click_name, null);
  try {
    const saved = await hub.useDoorbellLink(token, String(posted.get("url") ?? "").trim(), String(posted.get("key") ?? "").trim());
    return htmlResponse(page("Doorbell set", `<h1>Doorbell set</h1><p>Click will wake <strong>${escapeHtml(saved.handle)}</strong> when a message arrives. You can close this page.</p>`), 200);
  } catch (error) {
    const message = error instanceof Error && !/sql|durable object|internal/i.test(error.message) ? error.message : "Could not save the doorbell.";
    return form(clickId, token, info.handle, info.click_name, message);
  }
}
