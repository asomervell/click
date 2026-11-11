export const PRODUCTION_ORIGIN = "https://clickmcp.com";
export const OWNER_ID = "owner";

export type Role = "owner" | "member";

export type ClickProps = {
  principalId: string;
  role: Role;
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
  role: Role;
  label: string | null;
  agent: {
    handle: string;
    name: string;
    description: string;
    webhook_url: string | null;
    webhook_configured: boolean;
    created_at: number;
  } | null;
};
