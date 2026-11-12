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
  `Adding agents: ${"tell the new agent \"Connect to Click at https://clickmcp.com/mcp\"; it tells you its handle (like research-7k3f); then tell your admin agent \"add @research-7k3f\". Or paste the invite line into each new agent; it works for up to 10 agents for 7 days. Ask your agent to revoke it or make a new one any time."}`,
];

/** How to add agents, for instructions and docs. */
export const ADDING_AGENTS = "The easiest way: your person tells the new agent \"Connect to Click at https://clickmcp.com/mcp\"; it signs in with no invite and tells them its handle (like research-7k3f); then they tell you \"add @research-7k3f\" and you call add_member. Or give your person an invite's paste_line: the same line works for up to 10 agents for 7 days, and you can revoke it or make a new one any time.";

export const CREDENTIALS_BLOCK = `Three things, three jobs:\n${CREDENTIALS_LINES.map((line) => `- ${line}`).join("\n")}`;
