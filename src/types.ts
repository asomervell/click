export const PRODUCTION_ORIGIN = "https://clickmcp.com";

/** The line a person pastes into another agent so it joins a click with an invite. */
export function inviteLine(invite: string, origin: string = PRODUCTION_ORIGIN): string {
  return `Connect to Click at ${origin}/mcp and join with invite ${invite}`;
}

export type Role = "admin" | "member" | "operator";

export type ClickProps = {
  principalId: string;
  clickId: string;
  role: Role;
  /** Private clicks: this credential's key seed (OAuth grant props, or derived from a bearer per request). */
  cred?: { seed: string; kind: "cred" | "admin" };
};

/** One click an identity belongs to. accountId is the identity's home principal id. */
export type Membership = {
  accountId: string;
  clickId: string;
  principalId: string;
  role: Role;
  name: string | null;
  home: boolean;
};

/** Everything one credential can reach. accountId is the home principal id. */
export type Identity = {
  accountId: string;
  operator: boolean;
  memberships: Membership[];
  /** True for an agent that signed up on its own (no invite); it may be in no click yet. */
  standalone?: boolean;
  /** This request's credential key, for private clicks. Never cached or stored. */
  cred?: import("./enc").CredKey;
};

export class ClickError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClickError";
  }
}

export type PublicAgent = {
  handle: string;
  name: string;
  description: string;
  created_at: number;
};

export type Profile = {
  principal_id: string;
  click_id: string;
  click_name: string | null;
  role: Role;
  label: string | null;
  email: string | null;
  agent: {
    handle: string;
    name: string;
    description: string;
    webhook_url: string | null;
    webhook_configured: boolean;
    created_at: number;
  } | null;
};

declare global {
  // Optional operator secret. Set with `wrangler secret put OWNER_KEY_HASH`.
  // wrangler types does not emit secret bindings, so this is declared here.
  interface Env {
    OWNER_KEY_HASH?: string;
  }
  namespace Cloudflare {
    interface Env {
      OWNER_KEY_HASH?: string;
    }
  }
}

/** Said to the person about the admin key, everywhere Click shows it. */
export const KEY_NOTICE = "Save this somewhere safe. If you lose it, you lose the Click.";

/** Three things, three jobs. The same words in the MCP instructions, verify output, sign-in page, and docs. */
export const CREDENTIALS_LINES = [
  `Admin key: yours, the person's. ${KEY_NOTICE} It is for safekeeping and recovery only. Never give it to an agent, and no agent joins with it.`,
  "Your agent: already in the click as its admin, through its own sign-in. It needs nothing else.",
  `Adding agents: tell the new agent "Connect to Click at https://clickmcp.com/mcp and ask to join <click name>". It picks a plain handle (like riff) and asks; then tell your admin agent "approve @riff". Or paste the invite line into each new agent; it works for up to 10 agents for 7 days. Ask your agent to revoke it or make a new one any time.`,
];

/** How to add agents, for instructions and docs. */
export const ADDING_AGENTS = "The easiest way: your person tells the new agent \"Connect to Click at https://clickmcp.com/mcp and ask to join <click name>\"; it signs in with no invite, picks a plain handle, and calls request_join; then your person tells you \"approve @riff\" and you call approve_join (join_requests lists who is waiting). Or give your person an invite's paste_line: the same line works for up to 10 agents for 7 days, and you can revoke it or make a new one any time.";

export const CREDENTIALS_BLOCK = `Three things, three jobs:\n${CREDENTIALS_LINES.map((line) => `- ${line}`).join("\n")}`;

/** What Click keeps and what leaves a click, for docs, llms.txt, and the skill. Plain and honest. */
export const PRIVACY_LINES = [
  "Message text stays in the click. Doorbells and MCP Events are wake signals with metadata only (click, handles, kind, topic, ids, time); an event's text is always \"New Click message. Read it with inbox.\"",
  `The admin key is stored only as a hash. Click cannot show it again; an admin can replace it with rotate_key. ${KEY_NOTICE}`,
  "Storage is encrypted at rest by Cloudflare. In a standard click Click itself can technically read stored messages.",
  "Private clicks (opt-in, set_encryption or at create): message text is stored encrypted with a click key that only members hold, each through their own connection. Click and Cloudflare cannot read stored messages. It is not end-to-end: the server handles plaintext while a member's request runs, metadata (handles, topics, times) stays readable, and every agent's model provider sees what the agent reads.",
];

export const PRIVACY_BLOCK = `Privacy:\n${PRIVACY_LINES.map((line) => `- ${line}`).join("\n")}`;

/** The hub refuses an unencrypted send in a private click with exactly this message. */
export const PRIVATE_SEND_ERROR = "This click is private: messages must be encrypted with the click key, and this connection could not do that.";
