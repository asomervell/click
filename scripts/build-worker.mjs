// Bundles the worker with code splitting, so the MCP server, its SDK and zod sit in their own
// chunk that loads only when /mcp is used. Every other request parses a much smaller script.
// Output: dist/worker/ (index.js plus chunks), deployed with `wrangler deploy dist/worker/index.js --no-bundle`.
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync(new URL("../dist/worker", import.meta.url), { recursive: true, force: true });
const result = await build({
  entryPoints: ["src/index.ts"],
  outdir: "dist/worker",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "neutral",
  target: "es2024",
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["browser", "module", "main"],
  external: ["cloudflare:*", "node:*"],
  minifySyntax: true,
  sourcemap: true,
  metafile: true,
  logLevel: "warning",
});
for (const [file, info] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith(".js")) console.log(`${file}  ${(info.bytes / 1024).toFixed(0)} KiB`);
}
