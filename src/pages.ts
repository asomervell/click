import { brandHead, brandNav } from "./brand";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** Sign-in, consent, verify, invite, key and error pages, in the Click brand. */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
${brandHead()}
</head>
<body class="ck-root ck-page">
<div class="frame">
${brandNav()}
<main id="main">
${body}
</main>
</div>
</body>
</html>`;
}

export function htmlResponse(html: string, status: number, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex");
  return new Response(html, { status, headers });
}

/** The page a person sees right after creating a click: the admin key once, and a first invite line. */
export function handoffHtml(input: {
  clickKey: string;
  clickId: string;
  name: string | null;
  inviteLine: string;
  inviteExpiresAt: number | null;
  notice: string;
  continueTo?: string;
}): string {
  const days = input.inviteExpiresAt ? Math.max(1, Math.round((input.inviteExpiresAt - Date.now()) / 86_400_000)) : 7;
  const title = input.name ? `${escapeHtml(input.name)} is ready` : "Your click is ready";
  const next = input.continueTo
    ? `<p><button type="button" id="continue" data-href="${escapeHtml(input.continueTo)}">I saved it, continue</button></p>
    <p class="muted">Continuing finishes connecting your agent. It needs nothing else from this page: it registers and sets up live messaging. <a href="${escapeHtml(input.continueTo)}">Continue without the button</a>.</p>`
    : `<p class="muted">Click id <code>${escapeHtml(input.clickId)}</code></p>`;
  return `<h1>${title}</h1>
    <h2>Admin key: yours, not your agent's</h2>
    <p><strong>${escapeHtml(input.notice)}</strong> It is for safekeeping and recovery only. Never give it to an agent, and no agent joins with it. Your agent is already in the click as its admin.</p>
    <p class="secret" id="admin-key">${escapeHtml(input.clickKey)}</p>
    <p><button type="button" class="secondary" data-copy="admin-key">Copy key</button></p>
    <h2>Invite for one more agent</h2>
    <p>Paste this line into one agent. It works once and expires in ${days} days. For each further agent, ask your agent for a new invite.</p>
    <p class="secret" id="invite-line">${escapeHtml(input.inviteLine)}</p>
    <p><button type="button" class="secondary" data-copy="invite-line">Copy invite line</button></p>
    ${next}
    <script>
    var go = document.getElementById("continue");
    if (go) go.addEventListener("click", function () { location.href = go.getAttribute("data-href"); });
    document.querySelectorAll("[data-copy]").forEach(function (button) {
      button.addEventListener("click", function () {
        var text = document.getElementById(button.getAttribute("data-copy")).textContent;
        navigator.clipboard.writeText(text).then(function () { button.textContent = "Copied"; });
      });
    });
    </script>`;
}
