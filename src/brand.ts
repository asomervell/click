import { BRAND_VERSION } from "./brand-version";

/** The Buckle, inlined so it takes the colour of its parent. 13 by 10 grid, shown at 26 by 20. */
export const BUCKLE_SVG = `<svg viewBox="0 0 13 10" width="26" height="20" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><g fill="currentColor"><rect x="1" y="0" width="8" height="1"/><rect x="10" y="0" width="2" height="1"/><rect x="0" y="1" width="9" height="1"/><rect x="10" y="1" width="3" height="1"/><rect x="0" y="2" width="4" height="1"/><rect x="10" y="2" width="3" height="1"/><rect x="0" y="3" width="4" height="1"/><rect x="5" y="3" width="8" height="1"/><rect x="0" y="4" width="4" height="1"/><rect x="5" y="4" width="8" height="1"/><rect x="0" y="5" width="4" height="1"/><rect x="5" y="5" width="8" height="1"/><rect x="0" y="6" width="4" height="1"/><rect x="5" y="6" width="8" height="1"/><rect x="0" y="7" width="4" height="1"/><rect x="10" y="7" width="3" height="1"/><rect x="0" y="8" width="9" height="1"/><rect x="10" y="8" width="3" height="1"/><rect x="1" y="9" width="8" height="1"/><rect x="10" y="9" width="2" height="1"/></g></svg>`;

const CSS_HREF = `/brand/click.css?v=${BRAND_VERSION}`;

/** Stylesheet, self-hosted fonts and icons for every HTML page. */
export function brandHead(): string {
  return `<meta name="theme-color" content="#000000">
<meta name="color-scheme" content="dark">
<link rel="preload" href="/brand/fonts/PressStart2P-400-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/brand/fonts/IBMPlexMono-400-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${CSS_HREF}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;
}

/** The nav: the Buckle and CLICK, linking home, with optional text links on the right. */
export function brandNav(links: Array<{ href: string; label: string }> = []): string {
  const right = links.length
    ? `<span class="links ck-label">${links.map((link) => `<a href="${link.href}">${link.label}</a>`).join("")}</span>`
    : "";
  return `<nav class="ck-nav" aria-label="Click"><a class="ck-brand" href="/" aria-label="Click home">${BUCKLE_SVG}<span aria-hidden="true">CLICK</span></a>${right}</nav>`;
}

/**
 * Brand files are Workers static assets (public/, built by scripts/build-brand.mjs) and are
 * served without running the worker. Only the stylesheet runs the worker first, so the
 * current ?v= version can be cached as immutable.
 */
export async function brandStylesheet(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/brand/click.css" || !env.ASSETS) return null;
  const asset = await env.ASSETS.fetch(new Request(new URL("/brand/click.css", url.origin), request));
  if (!asset.ok) return asset;
  const headers = new Headers(asset.headers);
  const versioned = url.searchParams.get("v") === BRAND_VERSION;
  headers.set("cache-control", versioned ? "public, max-age=31536000, immutable" : "public, max-age=86400");
  headers.set("content-type", "text/css; charset=utf-8");
  return new Response(asset.body, { status: asset.status, headers });
}
