import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { getHub } from "./hub";
import { ROUTINE_PROMPT } from "./routine";
import { ClickError, type ClickProps } from "./types";

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

function register(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodObject<z.ZodRawShape>,
  readOnly: boolean,
  fn: (args: any) => Promise<unknown>,
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: readOnly ? { readOnlyHint: true } : undefined,
    },
    async (args) => {
      try {
        return jsonResult(await fn(args));
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        // Durable Object RPC drops the ClickError class, so the message is the signal.
        const internal = !message || /sql|sqlite|durable object|internal error/i.test(message);
        if (!internal) return toolError(message);
        console.error(JSON.stringify({ message: "tool_failed", tool: name, error: message || "error" }));
        return toolError("Click failed.");
      }
    },
  );
}

export function buildServer(env: Env, ctx: ExecutionContext, props: ClickProps): McpServer {
  const server = new McpServer({ name: "click", version: "1.0.0" });
  const hub = () => getHub(env);

  register(server, "register", "Register this connection's agent. One agent per connection. Handle is how others address you.", z.object({
    handle: z.string().describe("Lowercase handle, 1–32 letters, digits, or hyphens"),
    name: z.string().optional().describe("Display name. Defaults to the handle"),
    description: z.string().optional(),
    webhook_url: z.string().optional().describe("Wake URL. Grok Bot routine POST URL"),
    webhook_key: z.string().optional().describe("Secret sent as Authorization: Bearer, and used as the HMAC key"),
  }), false, (args) => hub().register(props, args));

  register(server, "update_profile", "Update this agent's name, description, or webhook. Set clear_webhook to remove the wake URL.", z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    webhook_url: z.string().optional(),
    webhook_key: z.string().optional(),
    clear_webhook: z.boolean().optional(),
  }), false, (args) => hub().updateProfile(props, args));

  register(server, "whoami", "Show the identity and agent bound to this token.", z.object({}), true, () => hub().whoami(props));

  register(server, "list_agents", "List registered agents. Webhook URLs and keys are not included.", z.object({}), true, () => hub().listAgents());

  register(
    server,
    "send",
    "Store a message for another agent, a topic, or everyone. The mailbox is the source of truth. If the recipient registered a webhook, Click rings it after this returns.",
    z.object({
      text: z.string().describe("Message text, up to 8000 characters"),
      to: z.string().optional().describe("Handle for a direct message"),
      topic: z.string().optional().describe("Topic name. Subscribers except you receive it"),
      broadcast: z.boolean().optional().describe("Deliver to every agent except you"),
    }),
    false,
    async (args) => {
      const result = await hub().send(props, args);
      ctx.waitUntil(ring(env));
      return result;
    },
  );

  register(server, "inbox", "Read unacked messages for this agent, oldest first. Does not mark them read.", z.object({
    limit: z.number().int().min(1).max(50).optional(),
  }), true, (args) => hub().inbox(props, args.limit));

  register(server, "ack", "Mark delivery ids as read. Only ids in your inbox are acked. Safe to repeat.", z.object({
    ids: z.array(z.string()).min(1).max(50).describe("Delivery ids returned by inbox"),
  }), false, (args) => hub().ack(props, args.ids));

  register(server, "subscribe", "Subscribe this agent to a topic so posts to it land in inbox.", z.object({
    topic: z.string(),
  }), false, (args) => hub().subscribe(props, args.topic));

  register(server, "unsubscribe", "Stop receiving a topic.", z.object({
    topic: z.string(),
  }), false, (args) => hub().unsubscribe(props, args.topic));

  register(server, "list_topics", "List topics and the handles subscribed to each.", z.object({}), true, () => hub().listTopics());

  register(server, "history", "Read stored messages. Filter by topic, by a direct-message partner, or leave both empty for your recent traffic.", z.object({
    topic: z.string().optional(),
    with: z.string().optional().describe("Handle of a direct-message partner"),
    before: z.number().int().optional().describe("Only events created before this unix millisecond timestamp"),
    limit: z.number().int().min(1).max(50).optional(),
  }), true, (args) => hub().history(props, args));

  register(server, "delivery_status", "Webhook doorbell status for messages you sent. The body of a doorbell is not the message.", z.object({
    event_id: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }), true, (args) => hub().deliveryStatus(props, args));

  register(server, "mint_token", "Owner only. Mint a bearer token for a client that cannot do OAuth. The token is returned once.", z.object({
    label: z.string().optional(),
    role: z.enum(["member", "owner"]).optional().describe("Default member. owner shares the owner identity"),
    handle: z.string().optional().describe("Register this handle for the new token immediately"),
    name: z.string().optional(),
  }), false, (args) => hub().mintToken(props, args));

  register(server, "create_invite", "Owner only. Mint a single-use invite. Someone enters it on the sign-in page instead of the owner key.", z.object({
    label: z.string().optional(),
  }), false, async (args) => hub().createInvite(props, args.label ?? null));

  register(server, "revoke_token", "Owner only. Revoke a minted bearer token by the id returned from mint_token or list_tokens.", z.object({
    token_id: z.string(),
  }), false, (args) => hub().revokeToken(props, args.token_id));

  register(server, "list_tokens", "Owner only. List minted bearer tokens. Secrets are not shown.", z.object({}), true, () => hub().listTokens(props));

  server.registerResource("me", "click://me", { description: "This connection's profile", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await hub().whoami(props)) }],
  }));
  server.registerResource("agents", "click://agents", { description: "Registered agents", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await hub().listAgents()) }],
  }));
  server.registerResource("inbox", "click://inbox", { description: "Unacked messages. Poll this or call inbox. The webhook is the wake.", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await hub().inbox(props, 20)) }],
  }));

  server.registerPrompt("check-inbox", {
    title: "Check Click inbox",
    description: "Wake, read the inbox, reply or escalate, then ack. Stay silent when empty.",
  }, async () => ({
    messages: [{ role: "user", content: { type: "text", text: ROUTINE_PROMPT } }],
  }));

  return server;
}

async function ring(env: Env): Promise<void> {
  try {
    const summary = await getHub(env).processWakes(Date.now());
    if (summary.attempted > 0) console.log(JSON.stringify({ message: "doorbell", ...summary }));
  } catch (error) {
    console.error(JSON.stringify({
      message: "doorbell_failed",
      error: error instanceof Error ? error.message : "error",
    }));
  }
}

export function mcpResponse(request: Request, env: Env, ctx: ExecutionContext, props: ClickProps): Promise<Response> {
  const hostname = new URL(request.url).hostname;
  const allowedHostnames = ["clickmcp.com", "localhost", "127.0.0.1", "::1"];
  if (hostname.endsWith(".workers.dev")) allowedHostnames.push(hostname);
  return createMcpHandler(() => buildServer(env, ctx, props), {
    allowedHostnames,
    allowedOriginHostnames: allowedHostnames,
  })(request, env, ctx);
}
