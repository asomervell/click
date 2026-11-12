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
  "Invites: one per agent. Each works once and expires in 7 days. Paste one line into each new agent. For the next agent, ask yours for a new invite.",
];

export const CREDENTIALS_BLOCK = `Three things, three jobs:\n${CREDENTIALS_LINES.map((line) => `- ${line}`).join("\n")}`;
