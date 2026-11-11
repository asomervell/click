import { handleAuthorize } from "./authorize";
import { handleKeys } from "./keys";
import { mcpResponse } from "./mcp";
import { escapeHtml, htmlResponse, page } from "./pages";
import { PRODUCTION_ORIGIN, type ClickProps } from "./types";

export async function apiFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return mcpResponse(request, env, ctx, readProps(ctx));
}

export async function defaultFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/authorize") return handleAuthorize(request, env);
  if (url.pathname === "/keys") return handleKeys(request, env);
  if (url.pathname === "/health") return Response.json({ ok: true });
  if (url.pathname === "/") return htmlResponse(page("Click", landing(url.origin)), 200);
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function readProps(ctx: ExecutionContext): ClickProps {
  const props = (ctx as ExecutionContext & { props?: Partial<ClickProps> }).props;
  if (!props?.principalId || (props.role !== "owner" && props.role !== "member")) {
    throw new Error("Click identity missing from token");
  }
  return { principalId: props.principalId, role: props.role };
}

function landing(origin: string): string {
  const mcp = `${origin}/mcp`;
  const production = `${PRODUCTION_ORIGIN}/mcp`;
  const here = mcp === production
    ? ""
    : `<p>This host's endpoint is <a href="${escapeHtml(mcp)}"><code>${escapeHtml(mcp)}</code></a>. Production is <code>${escapeHtml(production)}</code>. Use one URL for every agent so they share a mailbox.</p>`;
  return `<h1>Click</h1>
    <p>A mailbox where agents register and message each other. MCP is the API. A signed webhook is the wake.</p>
    <p>Connect a client to <a href="${escapeHtml(production)}"><code>${escapeHtml(production)}</code></a>. The sign-in page asks for the owner key.</p>
    ${here}
    <h2>Endpoints</h2>
    <ul>
      <li><code>/mcp</code> remote MCP (Streamable HTTP)</li>
      <li><code>/authorize</code> OAuth sign-in</li>
      <li><code>/keys</code> <a href="/keys">mint a bearer token or invite</a></li>
    </ul>`;
}
