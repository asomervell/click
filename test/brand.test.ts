import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LOCAL } from "./helpers";

describe("brand", () => {
  it("serves the stylesheet, self-hosted fonts, pictures and icons", async () => {
    const page = await (await SELF.fetch(`${LOCAL}/`)).text();
    const href = /<link rel="stylesheet" href="([^"]+)">/.exec(page)?.[1] ?? "";
    expect(href).toMatch(/^\/brand\/click\.css\?v=/);
    const css = await SELF.fetch(`${LOCAL}${href}`);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toContain("immutable");
    const text = await css.text();
    expect(text).toContain("--magenta: #ff55ff");
    expect(text).toContain("/brand/fonts/PressStart2P-400-latin.woff2");
    expect(text).not.toContain("fonts.googleapis.com");
    for (const [path, type] of [
      ["/brand/fonts/PressStart2P-400-latin.woff2", "font/woff2"],
      ["/brand/fonts/IBMPlexMono-400-latin.woff2", "font/woff2"],
      ["/brand/hero-campfire.png", "image/png"],
      ["/brand/lockup-magenta.png", "image/png"],
      ["/brand/logos/buckle-magenta.svg", "image/svg+xml"],
      ["/favicon.svg", "image/svg+xml"],
      ["/favicon.ico", "image/x-icon"],
      ["/og.png", "image/png"],
    ]) {
      const response = await SELF.fetch(`${LOCAL}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe(type);
      expect((await response.arrayBuffer()).byteLength, path).toBeGreaterThan(100);
    }
    expect(page).toContain('src="/brand/hero-campfire.png"');
    expect(page).toContain("Private DMs for agents");
    expect(page).toContain("In theory this costs us a couple of cents per user so yolo");
    expect(page).toContain("Connect to Click at <b>https://clickmcp.com/mcp</b>.</span>");
    expect(page).not.toContain("Streamable HTTP");
    expect(page).not.toContain("fonts.googleapis.com");
  });

  it("brands the sign-in, docs and error pages", async () => {
    for (const path of ["/keys", "/docs", "/about"]) {
      const html = await (await SELF.fetch(`${LOCAL}${path}`, { headers: { accept: "text/html" } })).text();
      expect(html, path).toContain("/brand/click.css?v=");
      expect(html, path).toContain('class="ck-brand"');
    }
    const missing = await SELF.fetch(`${LOCAL}/nope`, { headers: { accept: "text/html" } });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("<h1>Not found</h1>");
    const plain = await SELF.fetch(`${LOCAL}/nope`);
    expect(plain.headers.get("content-type")).toContain("text/plain");
  });
});
