import { ownerKeyMatches, sha256Hex } from "./crypto";
import { randomToken } from "./crypto";
import { getDirectory } from "./directory";
import { signupMode } from "./email";
import { getHub } from "./hub";
import { cachedIdentity, rememberIdentity } from "./identity-cache";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { providerOptions } from "./provider";
import { ClickError, CREDENTIALS_BLOCK, inviteLine, KEY_NOTICE, PRODUCTION_ORIGIN, type ClickProps, type Identity, type Membership, type Role } from "./types";
import { cleanClickName, cleanLabel, clickSlug } from "./validate";

export type { Identity } from "./types";

export type Selected = ClickProps & { clickName: string | null };

export type CreateStarted =
  | { status: "verification_sent"; pending_id: string; email: string; expires_at: number; verify: string }
  | (ClickHandoff & { email_verified: false });

export type CreateVerified = ClickHandoff & { email_verified: true };

export { KEY_NOTICE } from "./types";

/** What creating a click hands back: the admin key, a first invite, and what to do next. */
export type ClickHandoff = {
  status: "created";
  email_verified: boolean;
  click_id: string;
  name: string | null;
  principal_id: string;
  role: "admin";
  click_key: string;
  admin_key: {
    click_key: string;
    notice: string;
    instruction: string;
  };
  first_invite: {
    invite: string;
    id: string;
    expires_at: number | null;
    max_uses: number;
    paste_line: string;
    instruction: string;
  };
  message_for_person: string;
  next_steps: string[];
};


/**
 * Finish a new click: mint its first reusable invite (10 agents, 7 days) and build the block an
 * agent relays to its person. Used by verify_click, POST /api/v1/clicks/verify, and the
 * sign-in page.
 */
export async function clickHandoff(env: Env, input: {
  clickId: string;
  principalId: string;
  clickKey: string;
  name: string | null;
  emailVerified: boolean;
  origin?: string;
}): Promise<ClickHandoff> {
  const origin = input.origin ?? PRODUCTION_ORIGIN;
  const invite = await getHub(env, input.clickId).createInvite(
    { principalId: input.principalId, clickId: input.clickId, role: "admin" },
    "first invite",
  );
  const line = inviteLine(invite.invite, origin);
  const days = invite.expires_at ? Math.round((invite.expires_at - Date.now()) / 86_400_000) : 7;
  const label = input.name ? `"${input.name}"` : "your new click";
  const message = [
    `Your click ${label} is ready. I'm already in it as its admin.`,
    "",
    "Admin key (for you, not for any agent):",
    input.clickKey,
    `${KEY_NOTICE} It is for safekeeping and recovery only.`,
    "",
    `To add your other agents, tell each one "Connect to Click at ${origin}/mcp and ask to join ${input.name ?? "my click"}". It tells you its handle (like riff); then tell me "approve @riff".`,
    `Or paste this invite line into each new agent. It works for up to ${invite.max_uses} agents for ${days} days; ask me to revoke it or make a new one any time:`,
    line,
    "",
    CREDENTIALS_BLOCK,
  ].join("\n");
  return {
    status: "created",
    email_verified: input.emailVerified,
    click_id: input.clickId,
    name: input.name,
    principal_id: input.principalId,
    role: "admin",
    click_key: input.clickKey,
    admin_key: {
      click_key: input.clickKey,
      notice: KEY_NOTICE,
      instruction: `Show this key to your person now and tell them: "${KEY_NOTICE}" It belongs to the person, for safekeeping and recovery. You are already in the click as its admin through your own sign-in, so you never need it. Do not store it in your notes, send it to other agents, or post it anywhere else. Admins can show it again later with show_key.`,
    },
    first_invite: {
      invite: invite.invite,
      id: invite.id,
      expires_at: invite.expires_at,
      max_uses: invite.max_uses,
      paste_line: line,
      instruction: `A reusable invite. Give your person this line now. They paste the same line into each new agent; it works for up to ${invite.max_uses} agents for ${days} days. Revoke it with revoke_invite or make another with create_invite any time. Agents that connected without an invite can instead ask to join by name (request_join); approve them with approve_join.`,
    },
    message_for_person: message,
    next_steps: [
      "Now: send your person message_for_person word for word. It has the admin key (theirs, for safekeeping), how to add agents by handle, and a reusable invite line.",
      `Call register with click set to ${input.clickId}, a handle, a name, and a one-line description.`,
      "Make a scheduled routine on your own platform (for example every 15 minutes) whose prompt is Click's routine prompt, so you check the inbox without any keys.",
      "Optional, for instant wake-ups: call doorbell_link and give your person the link. They paste your routine's webhook URL and key straight into Click, never into chat.",
    ],
  };
}

async function ipHash(request: Request | null): Promise<string> {
  const ip = request?.headers.get("cf-connecting-ip")?.trim() || "unknown";
  return sha256Hex(`click-ip:${ip}`);
}

/**
 * Step one of creating a click. With a live email sender this mails a code and
 * returns a pending id; the click key comes from verifyCreateClick. Only when
 * no sender is configured and ALLOW_UNVERIFIED_SIGNUP is "true" does it return
 * the key at once, marked email_verified false.
 */
export async function startCreateClick(env: Env, input: {
  email: string;
  name?: unknown;
  request: Request | null;
  accountId?: string | null;
  origin?: string;
}): Promise<CreateStarted> {
  const name = cleanClickName(input.name);
  const mode = signupMode(env);
  if (!mode.verify) {
    const created = await getDirectory(env).createClick(input.email, name);
    await getHub(env, created.clickId).initClick({
      email: input.email.trim().toLowerCase(),
      clickKey: created.clickKey,
      adminId: created.adminId,
      clickId: created.clickId,
      name,
    });
    if (input.accountId && input.accountId !== created.adminId) {
      await getDirectory(env).addMembership({ accountId: input.accountId, clickId: created.clickId, principalId: created.adminId, role: "admin" });
    }
    const handoff = await clickHandoff(env, {
      clickId: created.clickId,
      principalId: created.adminId,
      clickKey: created.clickKey,
      name,
      emailVerified: false,
      origin: input.origin,
    });
    return { ...handoff, email_verified: false };
  }
  const directory = getDirectory(env);
  const started = await directory.startSignup({
    email: input.email,
    name,
    ipHash: await ipHash(input.request),
    accountId: input.accountId ?? null,
  });
  try {
    await mode.sender.sendVerification({ to: started.email, code: started.code, expiresAt: started.expiresAt, clickName: name });
  } catch (error) {
    await directory.cancelSignup(started.pendingId);
    console.error(JSON.stringify({ message: "verification_send_failed", error: error instanceof Error ? error.message.slice(0, 200) : "error" }));
    throw new ClickError("The verification email could not be sent. Check the address and try again in a minute.");
  }
  return {
    status: "verification_sent",
    pending_id: started.pendingId,
    email: started.email,
    expires_at: started.expiresAt,
    verify: "POST /api/v1/clicks/verify with {\"pending_id\",\"code\"} using the 6-digit code from the email.",
  };
}

export async function verifyCreateClick(env: Env, pendingId: string, code: string, origin?: string): Promise<CreateVerified> {
  if (!pendingId.trim() || !code.trim()) throw new ClickError("Send pending_id and code.");
  const created = await getDirectory(env).verifySignup(pendingId, code);
  await getHub(env, created.clickId).initClick({
    email: created.email,
    clickKey: created.clickKey,
    adminId: created.adminId,
    clickId: created.clickId,
    name: created.name,
  });
  const handoff = await clickHandoff(env, {
    clickId: created.clickId,
    principalId: created.adminId,
    clickKey: created.clickKey,
    name: created.name,
    emailVerified: true,
    origin,
  });
  return { ...handoff, email_verified: true };
}

/** The click key is the admin credential. Presenting it signs in as that click's admin. */
export async function signInWithKey(env: Env, clickKey: string): Promise<ClickProps> {
  const key = clickKey.trim();
  if (!key.startsWith("clk_") || key.startsWith("clk_inv_")) throw new ClickError("That click key was not recognized.");
  const resolved = await getDirectory(env).resolveKeyHash(await sha256Hex(key));
  if (!resolved || resolved.role !== "admin") throw new ClickError("That click key was not recognized.");
  return { principalId: resolved.principalId, clickId: resolved.clickId, role: "admin" };
}

/**
 * Take one use of an invite. With an account, the click is added to that
 * identity's memberships. Without one, the invite creates a new identity whose
 * home is that click.
 */
export async function joinWithInvite(env: Env, invite: string, label: string | null, accountId: string | null = null): Promise<ClickProps & { clickName: string | null }> {
  const presented = invite.trim();
  if (!presented.startsWith("clk_inv_")) {
    throw new ClickError("That is not an invite. Ask the click admin for an invite (it starts with clk_inv_).");
  }
  const tokenHash = await sha256Hex(presented);
  const directory = getDirectory(env);
  const clickId = await directory.takeInvite(tokenHash, accountId);
  if (!clickId) throw new ClickError("That invite was not recognized, or it was already used or revoked.");
  const hub = getHub(env, clickId);
  const member = await hub.createMember(label);
  await hub.markInviteUsed(tokenHash, member.principalId);
  if (accountId) {
    await directory.addMembership({ accountId, clickId, principalId: member.principalId, role: "member" });
  }
  return { principalId: member.principalId, clickId, role: "member", clickName: await directory.clickName(clickId) };
}

/** HTTP join without an existing credential: redeem an invite and get a member token. */
export async function joinWithInviteToken(env: Env, invite: string, label: string | null): Promise<ClickProps & { token: string; clickName: string | null }> {
  const joined = await joinWithInvite(env, invite, label, null);
  const token = await issueMemberToken(env, { clickId: joined.clickId, principalId: joined.principalId, role: "member", label });
  return { ...joined, token };
}

export async function rotateClickKey(env: Env, props: ClickProps): Promise<{ click_key: string }> {
  const current = await getHub(env, props.clickId).showKey(props);
  const next = randomToken("clk_");
  await getDirectory(env).replaceKey(props.clickId, await sha256Hex(current.click_key), await sha256Hex(next));
  await getHub(env, props.clickId).setKey(next);
  return { click_key: next };
}

export async function renameClick(env: Env, props: ClickProps, rawName: unknown): Promise<{ click_id: string; name: string | null }> {
  if (props.role !== "admin" && props.role !== "operator") throw new ClickError("Only a click admin can do that.");
  const name = cleanClickName(rawName);
  await getDirectory(env).renameClick(props.clickId, name);
  return getHub(env, props.clickId).setName(props, name);
}

export async function resolveBearer(env: Env, token: string, request: Request): Promise<ClickProps | null> {
  const presented = token.trim();
  if (!presented || presented.length > 512) return null;
  if (await ownerKeyMatches(presented, env.OWNER_KEY_HASH)) {
    const clickId = request.headers.get("x-click-id")?.trim() ?? "";
    if (!clickId) return null;
    const home: ClickProps = { principalId: "operator", clickId, role: "operator" };
    const identity = await getDirectory(env).identity(home);
    if (!identity) return null;
    rememberIdentity(home, identity);
    return home;
  }
  if (!presented.startsWith("clk_") || presented.startsWith("clk_inv_")) return null;
  // One Directory call: the key lookup and everything it can reach.
  const resolved = await getDirectory(env).resolveIdentity(await sha256Hex(presented));
  if (!resolved) return null;
  const home: ClickProps = { principalId: resolved.props.principalId, clickId: resolved.props.clickId, role: resolved.props.role };
  rememberIdentity(home, resolved.identity);
  return home;
}

/** Expand a credential's home props into every live membership. Null when nothing is left. */
export async function loadIdentity(env: Env, home: ClickProps): Promise<Identity | null> {
  const cached = cachedIdentity(home);
  if (cached) return cached;
  const identity = await getDirectory(env).identity(home);
  rememberIdentity(home, identity);
  return identity;
}

/**
 * Pick one membership. A click id or name selects it. With no selector, the
 * only membership is used; several memberships need an explicit click.
 */
export function selectClick(identity: Identity, selector?: string | null): Selected {
  const wanted = selector?.trim() ?? "";
  const pick = (membership: Membership): Selected => ({
    principalId: membership.principalId,
    clickId: membership.clickId,
    role: membership.role,
    clickName: membership.name,
  });
  const describe = () => identity.memberships
    .map((membership) => membership.name ? `${membership.name} (${membership.clickId})` : membership.clickId)
    .join(", ");
  if (identity.memberships.length === 0) {
    throw new ClickError("You are not in a click yet. Call register with a handle if you have not, then tell your person your handle and, when they name a click, call request_join with its name. Or join with an invite (join_click).");
  }
  if (!wanted) {
    const only = identity.memberships[0];
    if (identity.memberships.length === 1 && only) return pick(only);
    throw new ClickError(`This identity is in ${identity.memberships.length} clicks: ${describe()}. Pass click with a click id or name. Call list_clicks to see them.`);
  }
  const byId = identity.memberships.find((membership) => membership.clickId === wanted.toLowerCase());
  if (byId) return pick(byId);
  const slug = clickSlug(wanted);
  const byName = identity.memberships.filter((membership) => membership.name && (membership.name.toLowerCase() === wanted.toLowerCase() || clickSlug(membership.name) === slug));
  if (byName.length === 1 && byName[0]) return pick(byName[0]);
  if (byName.length > 1) throw new ClickError(`More than one of your clicks is named ${wanted}. Pass the click id instead.`);
  throw new ClickError(`You are not in a click called ${wanted}. Your clicks: ${describe()}.`);
}

export async function listClicks(env: Env, identity: Identity): Promise<{
  clicks: Array<{ click_id: string; name: string | null; role: Role; home: boolean; handle: string | null; webhook_configured: boolean }>;
}> {
  const clicks = await Promise.all(identity.memberships.map(async (membership) => {
    let handle: string | null = null;
    let webhookConfigured = false;
    try {
      const profile = await getHub(env, membership.clickId).whoami({
        principalId: membership.principalId,
        clickId: membership.clickId,
        role: membership.role,
      });
      handle = profile.agent?.handle ?? null;
      webhookConfigured = profile.agent?.webhook_configured ?? false;
    } catch {
      // A click that cannot answer still appears in the list.
    }
    return {
      click_id: membership.clickId,
      name: membership.name,
      role: membership.role,
      home: membership.home,
      handle,
      webhook_configured: webhookConfigured,
    };
  }));
  return { clicks };
}

export async function forgetMember(env: Env, props: ClickProps, principalId: string): Promise<void> {
  await getDirectory(env).forgetPrincipal(props.clickId, principalId);
}

async function issueMemberToken(env: Env, input: {
  clickId: string;
  principalId: string;
  role: Role;
  label: string | null;
}): Promise<string> {
  const token = randomToken("clk_");
  await getDirectory(env).rememberToken({
    tokenHash: await sha256Hex(token),
    clickId: input.clickId,
    principalId: input.principalId,
    role: input.role,
  });
  await getHub(env, input.clickId).rememberIssuedToken({
    token,
    principalId: input.principalId,
    role: input.role,
    label: input.label,
  });
  return token;
}

export async function deleteClick(env: Env, props: ClickProps): Promise<{ deleted: true; click_id: string }> {
  if (props.role !== "admin" && props.role !== "operator") throw new ClickError("Only a click admin can do that.");
  await purgeClick(env, props.clickId);
  return { deleted: true, click_id: props.clickId };
}

/**
 * Delete a click for good: its mailbox, agents, invites and tokens, its Directory rows and
 * memberships, and the OAuth grants of identities that lived only in it.
 */
export async function purgeClick(env: Env, clickId: string): Promise<{ click_id: string; grants_revoked: number }> {
  const hub = getHub(env, clickId);
  const principals = await hub.principalIds();
  const orphans = await getDirectory(env).purgeClick(clickId, principals);
  await hub.purge();
  let grantsRevoked = 0;
  if (orphans.length > 0 && env.OAUTH_KV) {
    const api = getOAuthApi(providerOptions(PRODUCTION_ORIGIN), env);
    for (const userId of orphans) {
      let cursor: string | undefined;
      do {
        const page = await api.listUserGrants(userId, cursor ? { cursor } : undefined);
        for (const grant of page.items) {
          await api.revokeGrant(grant.id, userId);
          grantsRevoked += 1;
        }
        cursor = page.cursor;
      } while (cursor);
    }
  }
  return { click_id: clickId, grants_revoked: grantsRevoked };
}

export { cleanLabel };
