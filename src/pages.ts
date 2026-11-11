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

export function page(title: string, body: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 17px/1.5 "Iowan Old Style", Palatino, Georgia, serif; max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem; color: #1c1915; background: #f4f0e6; }
  h1 { font-size: 2rem; font-weight: 600; letter-spacing: -0.03em; margin-bottom: 0.25rem; }
  h2 { font-size: 1.15rem; margin-top: 2rem; }
  a { color: #1f4d3a; }
  code, input, button, textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92rem; }
  input { width: 100%; box-sizing: border-box; padding: 0.55rem 0.7rem; border: 1px solid #c9c0b2; background: #fffdf8; }
  label { display: block; margin: 0.9rem 0 0.3rem; }
  button { padding: 0.45rem 0.85rem; margin-right: 0.4rem; background: #1c1915; color: #f4f0e6; border: 0; cursor: pointer; }
  button.secondary { background: transparent; color: #1c1915; border: 1px solid #1c1915; }
  .error { color: #8c2f2f; }
  .secret { padding: 0.8rem 1rem; background: #fffdf8; border: 1px solid #c9c0b2; word-break: break-all; }
  .muted { color: #5c564c; }
</style>
${body}`;
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
