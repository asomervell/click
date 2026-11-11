import { createProvider } from "./provider";
import { PRODUCTION_ORIGIN } from "./types";

export { ClickHub } from "./hub";

function originOf(request: Request): string | null {
  try {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = originOf(request);
    if (!origin) return new Response("Bad request", { status: 400 });
    try {
      return await createProvider(origin).fetch(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({
        message: "request_failed",
        error: error instanceof Error ? error.message : "error",
      }));
      return new Response("Click failed", { status: 500 });
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const provider = createProvider(PRODUCTION_ORIGIN);
    ctx.waitUntil(provider.purgeExpiredData(env).then((result) => {
      console.log(JSON.stringify({
        message: "oauth_purge",
        grantsPurged: result.grantsPurged,
        tokensPurged: result.tokensPurged,
      }));
    }));
  },
} satisfies ExportedHandler<Env>;
