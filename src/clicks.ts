import { ownerKeyMatches, sha256Hex } from "./crypto";
import { randomToken } from "./crypto";
import { getDirectory } from "./directory";
import { getHub } from "./hub";
import { ClickError, type ClickProps, type Role } from "./types";
import { cleanLabel } from "./validate";

export async function createClick(env: Env, email: string): Promise<{
  click_id: string;
  click_key: string;
  principal_id: string;
  role: "admin";
}> {
  const created = await getDirectory(env).createClick(email);
  const hub = getHub(env, created.clickId);
  await hub.initClick({ email: email.trim().toLowerCase(), clickKey: created.clickKey, adminId: created.adminId });
  return {
    click_id: created.clickId,
    click_key: created.clickKey,
    principal_id: created.adminId,
    role: "admin",
  };
}

export async function joinWithKey(env: Env, clickKey: string, label: string | null): Promise<ClickProps & { token: string }> {
  const resolved = await getDirectory(env).resolveKeyHash(await sha256Hex(clickKey.trim()));
  if (!resolved || resolved.role !== "admin" || resolved.principalId === "") {
    throw new ClickError("That click key was not recognized.");
  }
  // resolveKeyHash returns the admin principal for a click key. Joining mints a new member.
  const clickId = resolved.clickId;
  const member = await getHub(env, clickId).createMember(label);
  const token = await issueMemberToken(env, {
    clickId,
    principalId: member.principalId,
    role: "member",
    label,
  });
  return { principalId: member.principalId, clickId, role: "member", token };
}

export async function joinWithInvite(env: Env, invite: string, label: string | null): Promise<ClickProps> {
  const clickId = await getDirectory(env).takeInvite(await sha256Hex(invite.trim()));
  if (!clickId) throw new ClickError("That invite was not recognized.");
  const member = await getHub(env, clickId).createMember(label);
  return { principalId: member.principalId, clickId, role: "member" };
}

export async function rotateClickKey(env: Env, props: ClickProps): Promise<{ click_key: string }> {
  const current = await getHub(env, props.clickId).showKey(props);
  const next = randomToken("clk_");
  await getDirectory(env).replaceKey(props.clickId, await sha256Hex(current.click_key), await sha256Hex(next));
  await getHub(env, props.clickId).setKey(next);
  return { click_key: next };
}

export async function forgetMember(env: Env, props: ClickProps, principalId: string): Promise<void> {
  await getDirectory(env).forgetPrincipal(props.clickId, principalId);
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

export async function acceptSignup(env: Env, raw: { email?: string; clickKey?: string; invite?: string; label?: string | null }): Promise<ClickProps & { click_key?: string; token?: string }> {
  const label = cleanLabel(raw.label);
  if (raw.email) {
    const created = await createClick(env, raw.email);
    return { principalId: created.principal_id, clickId: created.click_id, role: "admin", click_key: created.click_key };
  }
  if (raw.invite) return joinWithInvite(env, raw.invite, label);
  if (raw.clickKey) {
    const joined = await joinWithKey(env, raw.clickKey, label);
    return joined;
  }
  throw new ClickError("Create a click with an email, or paste a click key or invite.");
}
