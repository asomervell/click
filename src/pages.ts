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
