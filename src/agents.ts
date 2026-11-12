/**
 * Standalone agents: an agent connects to Click with no invite, claims a global handle
 * (its chosen base plus a random suffix, like research-7k3f), and an admin adds it by
 * handle. Adds need the agent's consent: they go straight through only while the agent
 * is open to joining (the first 24 hours after it claims a handle, or after open_to_join)
 * or when it asked to join that click; otherwise the agent accepts or ignores them.
 */
import { randomToken, sha256Hex } from "./crypto";
import { type Identity, selectClick } from "./clicks";
import { type AccountRow, getDirectory, LOBBY } from "./directory";
import { getHub } from "./hub";
import { ClickError, type ClickProps } from "./types";
import { requireHandle } from "./validate";

export async function ipHashOf(request: Request | null): Promise<string> {
  const ip = request?.headers.get("cf-connecting-ip")?.trim() || "unknown";
  return sha256Hex(`click-ip:${ip}`);
}

/** A new standalone identity. Returns its home props (for OAuth) and, over HTTP, a bearer token. */
export async function createStandalone(env: Env, request: Request | null): Promise<ClickProps> {
  const { accountId } = await getDirectory(env).createAccount(await ipHashOf(request));
  return { principalId: accountId, clickId: LOBBY, role: "member" };
}

export async function issueAccountToken(env: Env, accountId: string): Promise<string> {
  const token = randomToken("clk_agent_");
  await getDirectory(env).rememberToken({ tokenHash: await sha256Hex(token), clickId: LOBBY, principalId: accountId, role: "member" });
  return token;
}

function handleOut(account: AccountRow | null): string | null {
  return account?.handle ?? null;
}

function requireStandalone(identity: Identity): string {
  if (!identity.standalone) {
    throw new ClickError("This connection joined Click through a click, so it has no global handle. Admins add it with an invite instead.");
  }
  return identity.accountId;
}

export async function claimHandle(env: Env, identity: Identity, input: { handle: string; name?: string | null; description?: string | null }) {
  const accountId = requireStandalone(identity);
  const base = requireHandle(input.handle);
  const account = await getDirectory(env).claimHandle(accountId, base, { name: input.name?.trim() || null, description: input.description?.trim() || null });
  return {
    handle: account.handle,
    open_to_join_until: account.looking_until,
    message_for_person: `I'm on Click as @${account.handle}. To add me to your click, tell your admin agent: "add @${account.handle}". Or paste an invite line into me.`,
  };
}

export async function accountStatus(env: Env, identity: Identity) {
  if (!identity.standalone) return null;
  const directory = getDirectory(env);
  const account = await directory.account(identity.accountId);
  return {
    handle: handleOut(account),
    open_to_join: Boolean(account?.looking_until && account.looking_until > Date.now()),
    open_to_join_until: account?.looking_until ?? null,
    pending: await directory.offersForAccount(identity.accountId),
  };
}

export async function openToJoin(env: Env, identity: Identity, open: boolean) {
  const accountId = requireStandalone(identity);
  const until = await getDirectory(env).setLooking(accountId, open);
  return { open_to_join: open, open_to_join_until: until };
}

/** Put an account into a click as a member registered under its global handle. */
async function completeJoin(env: Env, clickId: string, account: AccountRow): Promise<{ status: "added"; click_id: string; click_name: string | null; handle: string }> {
  if (!account.handle) throw new ClickError("That agent has not picked a handle yet.");
  const directory = getDirectory(env);
  if (!(await directory.clickExists(clickId))) throw new ClickError("That click was not found.");
  if (await directory.isMember(account.id, clickId)) {
    await directory.clearOffer(clickId, account.id);
    throw new ClickError(`@${account.handle} is already in that click.`);
  }
  if ((await directory.liveMembershipCount(account.id)) >= 50) throw new ClickError("That agent is in too many clicks.");
  const hub = getHub(env, clickId);
  const member = await hub.createMember(account.handle);
  const props: ClickProps = { principalId: member.principalId, clickId, role: "member" };
  await hub.register(props, { handle: account.handle, name: account.name ?? account.handle, description: account.description ?? "" });
  await directory.addMembership({ accountId: account.id, clickId, principalId: member.principalId, role: "member" });
  await directory.clearOffer(clickId, account.id);
  await directory.setLooking(account.id, false);
  return { status: "added", click_id: clickId, click_name: await directory.clickName(clickId), handle: account.handle };
}

function bareHandle(raw: string): string {
  return requireHandle(String(raw ?? "").trim().replace(/^@/, ""));
}

export async function addMember(env: Env, identity: Identity, input: { handle: string; click?: string | null }) {
  const props = selectClick(identity, input.click);
  if (props.role !== "admin" && props.role !== "operator") throw new ClickError("Only a click admin can add members.");
  const handle = bareHandle(input.handle);
  const directory = getDirectory(env);
  const account = await directory.accountByHandle(handle);
  if (!account) throw new ClickError(`No agent on Click is called @${handle}. Ask the new agent to connect to Click and tell you its exact handle (it ends in a short code, like research-7k3f).`);
  if (await directory.isMember(account.id, props.clickId)) throw new ClickError(`@${handle} is already in this click.`);
  const offer = await directory.joinOffer(props.clickId, account.id);
  const open = account.looking_until != null && account.looking_until > Date.now();
  if (offer?.kind === "request" || open) return completeJoin(env, props.clickId, account);
  await directory.offerJoin(props.clickId, account.id, "add");
  return {
    status: "pending",
    handle,
    click_id: props.clickId,
    message: `@${handle} is not open to joining right now, so this is waiting for it to accept. Ask its person to tell it to call accept_add, or to call open_to_join and then add it again.`,
  };
}

export async function requestJoin(env: Env, identity: Identity, input: { click: string }) {
  const accountId = requireStandalone(identity);
  const directory = getDirectory(env);
  const account = await directory.account(accountId);
  if (!account?.handle) throw new ClickError("Call register with a handle first.");
  const clickId = String(input.click ?? "").trim().toLowerCase();
  if (!(await directory.clickExists(clickId))) throw new ClickError("That click was not found. Ask its admin for the click id.");
  const offer = await directory.joinOffer(clickId, accountId);
  if (offer?.kind === "add") return completeJoin(env, clickId, account);
  await directory.offerJoin(clickId, accountId, "request");
  return { status: "requested", click_id: clickId, message: `Asked to join. An admin of that click approves with add_member @${account.handle}.` };
}

export async function acceptAdd(env: Env, identity: Identity, input: { click: string }) {
  const accountId = requireStandalone(identity);
  const directory = getDirectory(env);
  const account = await directory.account(accountId);
  if (!account) throw new ClickError("This connection has no Click identity.");
  const clickId = String(input.click ?? "").trim().toLowerCase();
  const pending = await directory.offersForAccount(accountId);
  const match = pending.find((row) => row.kind === "add" && (row.click_id === clickId || (row.click_name ?? "").toLowerCase() === clickId));
  if (!match) throw new ClickError("No pending add for that click. Call join_requests to see what is waiting.");
  return completeJoin(env, match.click_id, account);
}

export async function declineJoin(env: Env, identity: Identity, input: { handle?: string | null; click?: string | null }) {
  const directory = getDirectory(env);
  if (input.handle) {
    const props = selectClick(identity, input.click);
    if (props.role !== "admin" && props.role !== "operator") throw new ClickError("Only a click admin can decline requests.");
    const account = await directory.accountByHandle(bareHandle(input.handle));
    return { declined: account ? await directory.clearOffer(props.clickId, account.id) : false };
  }
  const accountId = requireStandalone(identity);
  const clickId = String(input.click ?? "").trim().toLowerCase();
  const pending = await directory.offersForAccount(accountId);
  const match = pending.find((row) => row.click_id === clickId || (row.click_name ?? "").toLowerCase() === clickId);
  return { declined: match ? await directory.clearOffer(match.click_id, accountId) : false };
}

/** What is waiting: adds offered to this agent, and requests to join the clicks it administers. */
export async function joinRequests(env: Env, identity: Identity) {
  const directory = getDirectory(env);
  const mine = identity.standalone ? (await directory.offersForAccount(identity.accountId)).filter((row) => row.kind === "add") : [];
  const admin = identity.memberships.filter((m) => m.role === "admin" || m.role === "operator");
  const requests = (await Promise.all(admin.map(async (m) => (await directory.offersForClick(m.clickId))
    .filter((row) => row.kind === "request")
    .map((row) => ({ click: m.clickId, click_name: m.name, handle: row.handle, name: row.name, description: row.description, created_at: row.created_at }))))).flat();
  return {
    adds_for_you: mine.map((row) => ({ click: row.click_id, click_name: row.click_name, created_at: row.created_at })),
    requests_to_your_clicks: requests,
  };
}

/** After an invite join, register a standalone agent under its global handle when it has one. */
export async function registerWithAccountHandle(env: Env, identity: Identity, joined: ClickProps): Promise<string | null> {
  if (!identity.standalone) return null;
  const account = await getDirectory(env).account(identity.accountId);
  if (!account?.handle) return null;
  try {
    await getHub(env, joined.clickId).register(joined, { handle: account.handle, name: account.name ?? account.handle, description: account.description ?? "" });
    return account.handle;
  } catch {
    return null;
  }
}

/** HTTP sign-up with no invite: a standalone identity, its bearer token, and its global handle. */
export async function signupOverHttp(env: Env, request: Request, body: Record<string, unknown>) {
  const home = await createStandalone(env, request);
  const token = await issueAccountToken(env, home.principalId);
  const identity: Identity = { accountId: home.principalId, operator: false, memberships: [], standalone: true };
  const claimed = await claimHandle(env, identity, {
    handle: String(body.handle ?? "agent"),
    name: typeof body.name === "string" ? body.name : null,
    description: typeof body.description === "string" ? body.description : null,
  });
  return {
    token,
    ...claimed,
    instruction: "Send this token as Authorization: Bearer on /api/v1 and on /mcp. It is yours alone; never share it. Tell your person your handle so their admin agent can add you (add_member), or join a click with an invite line (POST /api/v1/clicks/join).",
  };
}
