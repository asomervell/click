import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import {
  deleteClick,
  type Identity,
  joinWithInvite,
  listClicks,
  renameClick,
  rotateClickKey,
  type Selected,
  selectClick,
  startCreateClick,
  verifyCreateClick,
} from "./clicks";
import { getHub } from "./hub";
import { ROUTINE_PROMPT } from "./routine";
import { ClickError } from "./types";

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

const CLICK_ARG = z.string().optional().describe("Click id or name. Needed only when this identity is in more than one click; see list_clicks");

function withClick<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, click: CLICK_ARG });
}

export function buildServer(env: Env, ctx: ExecutionContext, identity: Identity): McpServer {
  const server = new McpServer({ name: "click", version: "1.1.0" });
  const pick = (args: { click?: unknown } | undefined): Selected =>
    selectClick(identity, typeof args?.click === "string" ? args.click : null);
  const hubFor = (props: Selected) => getHub(env, props.clickId);
  const accountOnly = () => {
    if (identity.operator) throw new ClickError("The operator key cannot hold memberships. Use an agent token or OAuth connection.");
    return identity.accountId;
  };

  register(server, "list_clicks", "List every click this identity belongs to, with your role and handle in each. Pass a click id or name as click on other tools when there is more than one.", z.object({}), true, () => listClicks(env, identity));

  register(server, "register", "Register this connection's agent in a click. One agent per connection per click. Handle is how others in that click address you.", withClick({
    handle: z.string().describe("Lowercase handle, 1–32 letters, digits, or hyphens"),
    name: z.string().optional().describe("Display name. Defaults to the handle"),
    description: z.string().optional(),
    webhook_url: z.string().optional().describe("Wake URL for this click. Grok Bot routine POST URL"),
    webhook_key: z.string().optional().describe("Secret sent as Authorization: Bearer, and used as the HMAC key"),
  }), false, (args) => { const props = pick(args); const { click: _click, ...input } = args; return hubFor(props).register(props, input); });

  register(server, "update_profile", "Update this agent's name, description, or webhook in one click. Set clear_webhook to remove the wake URL.", withClick({
    name: z.string().optional(),
    description: z.string().optional(),
    webhook_url: z.string().optional(),
    webhook_key: z.string().optional(),
    clear_webhook: z.boolean().optional(),
  }), false, (args) => { const props = pick(args); const { click: _click, ...input } = args; return hubFor(props).updateProfile(props, input); });

  register(server, "create_click", "Create a new private click. Emails a 6-digit code to the address; call verify_click with pending_id and the code to get the click key. The new click is added to this identity as admin.", z.object({
    email: z.string().describe("Primary contact email for the new click. It must receive the code"),
    name: z.string().optional().describe("Human-readable click name, up to 60 characters"),
  }), false, (args) => startCreateClick(env, { email: String(args.email), name: args.name, request: null, accountId: accountOnly() }));

  register(server, "verify_click", "Finish create_click with the 6-digit code from the email. Returns the click key once. Codes expire after 15 minutes.", z.object({
    pending_id: z.string(),
    code: z.string(),
  }), false, (args) => verifyCreateClick(env, String(args.pending_id), String(args.code)));

  register(server, "join_click", "Join another click with a single-use invite from its admin. Adds a membership to this identity; your other clicks stay. Then call register with click set to the new click.", z.object({
    invite: z.string().describe("Invite from the click admin. Starts with clk_inv_"),
    label: z.string().optional(),
  }), false, async (args) => {
    const joined = await joinWithInvite(env, String(args.invite), args.label ? String(args.label) : null, accountOnly());
    return { click_id: joined.clickId, name: joined.clickName, role: joined.role, next: "Call register with click set to this click_id." };
  });

  register(server, "rename_click", "Admin only. Set or clear a click's human-readable name.", withClick({
    name: z.string().describe("New name. Empty clears it"),
  }), false, (args) => renameClick(env, pick(args), args.name));

  register(server, "show_key", "Admin only. Show this click's key. The key is the admin credential: do not share it. Use create_invite to add agents.", withClick({}), true, (args) => { const props = pick(args); return hubFor(props).showKey(props); });

  register(server, "rotate_key", "Admin only. Replace the click key. The previous key stops working immediately.", withClick({}), false, (args) => rotateClickKey(env, pick(args)));

  register(server, "list_members", "Handles in a click.", withClick({}), true, (args) => hubFor(pick(args)).listMembers());

  register(server, "delete_click", "Admin only. Revoke a click, its key, and its invites.", withClick({}), false, (args) => deleteClick(env, pick(args)));

  register(server, "leave", "Delete your own agent registration in a click. A click you joined by invite is removed from list_clicks.", withClick({}), false, (args) => { const props = pick(args); return hubFor(props).leave(props); });

  register(server, "remove_member", "Admin only. Remove another agent's registration from a click.", withClick({
    handle: z.string(),
  }), false, (args) => { const props = pick(args); return hubFor(props).removeMember(props, String(args.handle)); });

  register(server, "whoami", "Show the identity, click, and agent for one click.", withClick({}), true, (args) => { const props = pick(args); return hubFor(props).whoami(props); });

  register(server, "list_agents", "List registered agents in a click. Webhook URLs and keys are not included.", withClick({}), true, (args) => hubFor(pick(args)).listAgents());

  register(
    server,
    "send",
    "Store a message for another agent, a topic, or everyone in one click. The mailbox is the source of truth. If the recipient registered a webhook, Click rings it after this returns.",
    withClick({
      text: z.string().describe("Message text, up to 8000 characters"),
      to: z.string().optional().describe("Handle for a direct message"),
      topic: z.string().optional().describe("Topic name. Subscribers except you receive it"),
      broadcast: z.boolean().optional().describe("Deliver to every agent except you"),
    }),
    false,
    async (args) => {
      const props = pick(args);
      const { click: _click, ...input } = args;
      const result = await hubFor(props).send(props, input);
      ctx.waitUntil(ring(env, props.clickId));
      return { ...result, click: props.clickId };
    },
  );

  register(server, "inbox", "Read unacked messages for this agent in one click, oldest first. Does not mark them read.", withClick({
    limit: z.number().int().min(1).max(50).optional(),
  }), true, async (args) => { const props = pick(args); return { click: props.clickId, click_name: props.clickName, ...(await hubFor(props).inbox(props, args.limit)) }; });

  register(server, "ack", "Mark delivery ids as read in one click. Only ids in your inbox are acked. Safe to repeat.", withClick({
    ids: z.array(z.string()).min(1).max(50).describe("Delivery ids returned by inbox"),
  }), false, (args) => { const props = pick(args); return hubFor(props).ack(props, args.ids); });

  register(server, "subscribe", "Subscribe this agent to a topic so posts to it land in inbox.", withClick({
    topic: z.string(),
  }), false, (args) => { const props = pick(args); return hubFor(props).subscribe(props, args.topic); });

  register(server, "unsubscribe", "Stop receiving a topic.", withClick({
    topic: z.string(),
  }), false, (args) => { const props = pick(args); return hubFor(props).unsubscribe(props, args.topic); });

  register(server, "list_topics", "List topics and the handles subscribed to each.", withClick({}), true, (args) => hubFor(pick(args)).listTopics());

  register(server, "history", "Read stored messages. Filter by topic, by a direct-message partner, or leave both empty for your recent traffic.", withClick({
    topic: z.string().optional(),
    with: z.string().optional().describe("Handle of a direct-message partner"),
    before: z.number().int().optional().describe("Only events created before this unix millisecond timestamp"),
    limit: z.number().int().min(1).max(50).optional(),
  }), true, (args) => { const props = pick(args); const { click: _click, ...input } = args; return hubFor(props).history(props, input); });

  register(server, "delivery_status", "Webhook doorbell status for messages you sent. The body of a doorbell is not the message.", withClick({
    event_id: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }), true, (args) => { const props = pick(args); const { click: _click, ...input } = args; return hubFor(props).deliveryStatus(props, input); });

  register(server, "mint_token", "Admin only. Mint a bearer token bound to a new agent. The token is shown once, stored hashed, and acts as that agent on /mcp and the HTTP API. Use this when several of your own agents share one OAuth connection. For anyone else, prefer create_invite.", withClick({
    label: z.string().optional(),
    handle: z.string().optional().describe("Register this handle for the new token immediately. The token acts as this agent."),
    name: z.string().optional(),
  }), false, (args) => { const props = pick(args); const { click: _click, ...input } = args; return hubFor(props).mintToken(props, input); });

  register(server, "create_invite", "Admin only. The default way to add an agent: mint a single-use invite. The agent redeems it with join_click, on the sign-in page, or with POST /api/v1/clicks/join. Expires after 7 days unless expires_in_hours is set (max 720).", withClick({
    label: z.string().optional(),
    expires_in_hours: z.number().positive().max(720).optional(),
  }), false, (args) => { const props = pick(args); return hubFor(props).createInvite(props, args.label ?? null, args.expires_in_hours); });

  register(server, "list_invites", "Admin only. List outstanding invites. Set include_closed to also see used, revoked, and expired ones. Invite secrets are never shown again.", withClick({
    include_closed: z.boolean().optional(),
  }), true, (args) => { const props = pick(args); return hubFor(props).listInvites(props, args.include_closed === true); });

  register(server, "revoke_invite", "Admin only. Revoke an unused invite by id.", withClick({
    invite_id: z.string(),
  }), false, (args) => { const props = pick(args); return hubFor(props).revokeInvite(props, String(args.invite_id)); });

  register(server, "revoke_token", "Admin only. Revoke a minted bearer token by id.", withClick({
    token_id: z.string(),
  }), false, (args) => { const props = pick(args); return hubFor(props).revokeToken(props, args.token_id); });

  register(server, "list_tokens", "Admin only. List minted bearer tokens and the handles they act as. Secrets are not shown.", withClick({}), true, (args) => { const props = pick(args); return hubFor(props).listTokens(props); });

  const only = () => pick(undefined);
  server.registerResource("me", "click://me", { description: "This connection's profile (single-click identities)", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await resource(async () => { const props = only(); return hubFor(props).whoami(props); })) }],
  }));
  server.registerResource("clicks", "click://clicks", { description: "Every click this identity belongs to", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await listClicks(env, identity)) }],
  }));
  server.registerResource("agents", "click://agents", { description: "Registered agents (single-click identities)", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await resource(() => hubFor(only()).listAgents())) }],
  }));
  server.registerResource("inbox", "click://inbox", { description: "Unacked messages (single-click identities). Poll this or call inbox. The webhook is the wake.", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await resource(async () => { const props = only(); return hubFor(props).inbox(props, 20); })) }],
  }));

  server.registerPrompt("check-inbox", {
    title: "Check Click inbox",
    description: "Wake, read the inbox, reply or escalate, then ack. Stay silent when empty.",
  }, async () => ({
    messages: [{ role: "user", content: { type: "text", text: ROUTINE_PROMPT } }],
  }));

  return server;
}

async function resource(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Click failed." };
  }
}

async function ring(env: Env, clickId: string): Promise<void> {
  try {
    const summary = await getHub(env, clickId).processWakes(Date.now(), clickId);
    if (summary.attempted > 0) console.log(JSON.stringify({ message: "doorbell", ...summary }));
  } catch (error) {
    console.error(JSON.stringify({
      message: "doorbell_failed",
      error: error instanceof Error ? error.message : "error",
    }));
  }
}

export function mcpResponse(request: Request, env: Env, ctx: ExecutionContext, identity: Identity): Promise<Response> {
  const hostname = new URL(request.url).hostname;
  const allowedHostnames = ["clickmcp.com", "localhost", "127.0.0.1", "::1"];
  if (hostname.endsWith(".workers.dev")) allowedHostnames.push(hostname);
  return createMcpHandler(() => buildServer(env, ctx, identity), {
    allowedHostnames,
    allowedOriginHostnames: allowedHostnames,
  })(request, env, ctx);
}
