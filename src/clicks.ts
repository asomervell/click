import { ownerKeyMatches, sha256Hex } from "./crypto";
import { randomToken } from "./crypto";
import { getDirectory, type ResolvedCredential } from "./directory";
import { signupMode } from "./email";
import { getHub } from "./hub";
import { ClickError, type ClickProps, type Membership, type Role } from "./types";
import { cleanClickName, cleanLabel, clickSlug } from "./validate";

/** Everything one credential can reach. accountId is the home principal id. */
export type Identity = {
  accountId: string;
  operator: boolean;
  memberships: Membership[];
};

export type Selected = ClickProps & { clickName: string | null };

export type CreateStarted =
  | { status: "verification_sent"; pending_id: string; email: string; expires_at: number; verify: string }
  | { status: "created"; email_verified: false; click_id: string; click_key: string; principal_id: string; role: "admin"; name: string | null };

export type CreateVerified = {
  status: "created";
  email_verified: true;
  click_id: string;
  click_key: string;
  principal_id: string;
  role: "admin";
  name: string | null;
};

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
    return {
      status: "created",
      email_verified: false,
      click_id: created.clickId,
      click_key: created.clickKey,
      principal_id: created.adminId,
      role: "admin",
      name,
    };
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

export async function verifyCreateClick(env: Env, pendingId: string, code: string): Promise<CreateVerified> {
  if (!pendingId.trim() || !code.trim()) throw new ClickError("Send pending_id and code.");
  const created = await getDirectory(env).verifySignup(pendingId, code);
  await getHub(env, created.clickId).initClick({
    email: created.email,
    clickKey: created.clickKey,
    adminId: created.adminId,
    clickId: created.clickId,
    name: created.name,
  });
  return {
    status: "created",
    email_verified: true,
    click_id: created.clickId,
    click_key: created.clickKey,
    principal_id: created.adminId,
    role: "admin",
    name: created.name,
  };
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
 * Redeem a single-use invite. With an account, the click is added to that
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
    if (!(await getDirectory(env).clickExists(clickId))) return null;
    return { principalId: "operator", clickId, role: "operator" };
  }
  if (!presented.startsWith("clk_") || presented.startsWith("clk_inv_")) return null;
  const resolved = await getDirectory(env).resolveKeyHash(await sha256Hex(presented));
  if (!resolved) return null;
  return { principalId: resolved.principalId, clickId: resolved.clickId, role: resolved.role };
}

/** Expand a credential's home props into every live membership. Null when nothing is left. */
export async function loadIdentity(env: Env, home: ClickProps): Promise<Identity | null> {
  if (home.role === "operator") {
    const directory = getDirectory(env);
    if (!(await directory.clickExists(home.clickId))) return null;
    return {
      accountId: "operator",
      operator: true,
      memberships: [{
        accountId: "operator",
        clickId: home.clickId,
        principalId: "operator",
        role: "operator",
        name: await directory.clickName(home.clickId),
        home: true,
      }],
    };
  }
  const memberships = await getDirectory(env).memberships(home as ResolvedCredential);
  if (memberships.length === 0) return null;
  return { accountId: home.principalId, operator: false, memberships };
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
  await getDirectory(env).revokeClick(props.clickId);
  return { deleted: true, click_id: props.clickId };
}

export { cleanLabel };
