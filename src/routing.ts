import { base64url } from "./crypto";
import { type Identity, type Selected, selectClick } from "./clicks";
import { getHub } from "./hub";
import { ClickError, type Membership } from "./types";
import { clampLimit } from "./validate";

/** Opaque cursor: per-click position of the oldest item already returned. */
type CursorMap = Record<string, { t: number; id: string }>;

function encodeCursor(map: CursorMap): string {
  return base64url(new TextEncoder().encode(JSON.stringify(map)));
}

function decodeCursor(raw: string | null | undefined): CursorMap {
  if (!raw) return {};
  try {
    const padded = raw.replaceAll("-", "+").replaceAll("_", "/");
    const json = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bad");
    const out: CursorMap = {};
    for (const [click, pos] of Object.entries(value as Record<string, unknown>)) {
      const p = pos as { t?: unknown; id?: unknown };
      if (typeof p?.t !== "number" || typeof p?.id !== "string") throw new Error("bad");
      out[click] = { t: p.t, id: p.id };
    }
    return out;
  } catch {
    throw new ClickError("That cursor is not valid. Start again without one.");
  }
}

function label(membership: Membership | Selected): string {
  const id = "clickId" in membership ? membership.clickId : "";
  const name = "clickName" in membership ? membership.clickName : (membership as Membership).name;
  return name ? `${id} (${name})` : id;
}

function propsOf(membership: Membership): Selected {
  return { principalId: membership.principalId, clickId: membership.clickId, role: membership.role, clickName: membership.name };
}

function explicit(click: string | null | undefined): string | null {
  const value = click?.trim();
  return value ? value : null;
}

/** Memberships where this identity has a registered agent. */
async function registered(env: Env, identity: Identity): Promise<Selected[]> {
  const all = identity.memberships.map(propsOf);
  const flags = await Promise.all(all.map((props) => getHub(env, props.clickId).isRegistered(props).catch(() => false)));
  return all.filter((_, index) => flags[index]);
}

type InboxMessage = {
  id: string;
  event_id: string;
  from: string;
  kind: string;
  topic: string | null;
  text: string;
  created_at: number;
  reply_to: string | null;
  click: string;
  click_name: string | null;
};

/**
 * Inbox. With click: that click only, oldest first, as before. Without click:
 * every click this identity is registered in, merged newest first, each message
 * labelled with click and click_name. next_cursor pages to older messages.
 */
export async function inboxAcross(env: Env, identity: Identity, input: { click?: string | null; limit?: number; cursor?: string | null }): Promise<{
  click?: string;
  click_name?: string | null;
  messages: InboxMessage[];
  next_cursor: string | null;
}> {
  const limit = clampLimit(input.limit);
  // One click (every single-click agent and legacy token): exactly the old
  // behaviour, oldest first. Several clicks without click: merged newest first.
  const chosen = explicit(input.click) ?? (identity.memberships.length === 1 ? identity.memberships[0]?.clickId ?? null : null);
  if (chosen) {
    const props = selectClick(identity, chosen);
    const page = await getHub(env, props.clickId).inbox(props, limit);
    return {
      click: props.clickId,
      click_name: props.clickName,
      messages: page.messages.map((message) => ({ ...message, click: props.clickId, click_name: props.clickName })),
      next_cursor: null,
    };
  }
  const cursor = decodeCursor(input.cursor);
  const targets = await registered(env, identity);
  if (targets.length === 0) {
    throw new ClickError("Register an agent before using the mailbox.");
  }

  const pages = await Promise.all(targets.map(async (props) => {
    const page = await getHub(env, props.clickId).inbox(props, limit, { order: "desc", olderThan: cursor[props.clickId] ?? null });
    return { props, messages: page.messages.map((message) => ({ ...message, click: props.clickId, click_name: props.clickName })) };
  }));
  const merged = pages.flatMap((page) => page.messages).sort(newestFirst);
  const taken = merged.slice(0, limit);
  const next: CursorMap = { ...cursor };
  for (const message of taken) next[message.click] = { t: message.created_at, id: message.id };
  const more = merged.length > limit || pages.some((page) => page.messages.length === limit);
  return {
    messages: taken,
    next_cursor: more ? encodeCursor(next) : null,
  };
}

function newestFirst(a: { created_at: number; id: string }, b: { created_at: number; id: string }): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Ack ids from any click. Without click, each id is acked wherever it belongs. */
export async function ackAcross(env: Env, identity: Identity, input: { click?: string | null; ids: string[] }): Promise<{
  acked: string[];
  missing: string[];
  by_click: Record<string, string[]>;
}> {
  if (input.ids.length > 50) throw new ClickError("Ack at most 50 ids at a time.");
  const chosen = explicit(input.click);
  const targets = chosen ? [selectClick(identity, chosen)] : await registered(env, identity);
  if (targets.length === 0) throw new ClickError("Register an agent before using the mailbox.");
  const results = await Promise.all(targets.map(async (props) => ({ props, result: await getHub(env, props.clickId).ack(props, input.ids) })));
  const acked = new Set<string>();
  const byClick: Record<string, string[]> = {};
  for (const { props, result } of results) {
    if (result.acked.length > 0) byClick[props.clickId] = result.acked;
    for (const id of result.acked) acked.add(id);
  }
  return {
    acked: input.ids.filter((id) => acked.has(id)),
    missing: input.ids.filter((id) => !acked.has(id)),
    by_click: byClick,
  };
}

type HistoryEvent = {
  id: string;
  kind: string;
  topic: string | null;
  from: string;
  to: string | null;
  text: string;
  created_at: number;
  reply_to: string | null;
  click: string;
  click_name: string | null;
};

/** History. Without click it merges every registered click, newest first, with a per-click cursor. */
export async function historyAcross(env: Env, identity: Identity, input: {
  click?: string | null;
  topic?: string;
  with?: string;
  before?: number;
  limit?: number;
  cursor?: string | null;
}): Promise<{ click?: string; click_name?: string | null; events: HistoryEvent[]; next_cursor: string | null }> {
  const limit = clampLimit(input.limit);
  const chosen = explicit(input.click);
  const cursor = decodeCursor(input.cursor);
  const targets = chosen ? [selectClick(identity, chosen)] : await registered(env, identity);
  if (targets.length === 0) {
    const only = identity.memberships[0];
    if (identity.memberships.length === 1 && only) await getHub(env, only.clickId).history(propsOf(only), { limit });
    throw new ClickError("Register an agent before using the mailbox.");
  }
  const settled = await Promise.allSettled(targets.map(async (props) => {
    const position = cursor[props.clickId];
    const page = await getHub(env, props.clickId).history(props, {
      topic: input.topic,
      with: input.with,
      before: position?.t ?? input.before,
      before_id: position?.id,
      limit,
    });
    return { props, events: page.events.map((event) => ({ ...event, click: props.clickId, click_name: props.clickName })) };
  }));
  const pages = settled.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
  if (pages.length === 0) {
    const failure = settled.find((item) => item.status === "rejected");
    throw failure && failure.status === "rejected" ? failure.reason : new ClickError("Click failed.");
  }
  const merged = pages.flatMap((page) => page.events).sort(newestFirst);
  const taken = merged.slice(0, limit);
  const next: CursorMap = { ...cursor };
  for (const event of taken) next[event.click] = { t: event.created_at, id: event.id };
  const more = merged.length > limit || pages.some((page) => page.events.length === limit);
  const single = targets.length === 1 ? targets[0] : undefined;
  return {
    ...(single ? { click: single.clickId, click_name: single.clickName } : {}),
    events: taken,
    next_cursor: more ? encodeCursor(next) : null,
  };
}

export type SendRequest = {
  text: string;
  to?: string;
  topic?: string;
  broadcast?: boolean;
  reply_to?: string;
  click?: string | null;
};

/**
 * Pick the click for a send. A reply goes to the click of the message it
 * answers. A new send uses the only click, or the only click where the
 * recipient exists; anything else is an error that names the candidates.
 */
export async function routeSend(env: Env, identity: Identity, input: SendRequest): Promise<{
  props: Selected;
  send: { text: string; to?: string; topic?: string; broadcast?: boolean; reply_to?: string };
}> {
  const chosen = explicit(input.click);
  const base = { text: input.text, to: input.to?.trim() || undefined, topic: input.topic?.trim() || undefined, broadcast: input.broadcast === true || undefined };
  const replyTo = input.reply_to?.trim();
  if (replyTo) {
    const searched = chosen ? identity.memberships.map(propsOf) : await registered(env, identity);
    const found = (await Promise.all(searched.map(async (props) => ({
      props,
      message: await getHub(env, props.clickId).locate(props, replyTo).catch(() => null),
    })))).find((row) => row.message);
    if (!found?.message) throw new ClickError(`No message with id ${replyTo} in any of your clicks.`);
    if (chosen) {
      const asked = selectClick(identity, chosen);
      if (asked.clickId !== found.props.clickId) {
        throw new ClickError(`Click conflict: message ${replyTo} is in click ${label(found.props)}, but click ${label(asked)} was given. Leave click out to reply where the message came from.`);
      }
    }
    const message = found.message;
    let target: { to?: string; topic?: string; broadcast?: boolean };
    if (base.to || base.topic || base.broadcast) target = { to: base.to, topic: base.topic, broadcast: base.broadcast };
    else if (message.kind === "topic" && message.topic) target = { topic: message.topic };
    else if (message.kind === "dm" && message.mine) {
      if (!message.to) throw new ClickError("The recipient of that message left the click.");
      target = { to: message.to };
    } else if (message.kind === "broadcast" && message.mine) target = { broadcast: true };
    else {
      if (!message.from) throw new ClickError("The sender of that message left the click.");
      target = { to: message.from };
    }
    return { props: found.props, send: { text: input.text, ...target, reply_to: message.event_id } };
  }
  if (chosen) return { props: selectClick(identity, chosen), send: base };
  const only = identity.memberships[0];
  if (identity.memberships.length === 1 && only) return { props: propsOf(only), send: base };
  const all = identity.memberships.map(propsOf);
  const list = (items: Selected[]) => items.map(label).join(", ");
  if (!base.to && !base.topic) {
    throw new ClickError(`You are in ${all.length} clicks, so a broadcast needs click. Candidates: ${list(all)}.`);
  }
  const mine = await registered(env, identity);
  const hits = await Promise.all(mine.map((props) => getHub(env, props.clickId).hasTarget({ to: base.to, topic: base.topic }).catch(() => false)));
  const candidates = mine.filter((_, index) => hits[index]);
  const what = base.to ? `an agent named ${base.to.toLowerCase()}` : `a topic named ${base.topic?.toLowerCase()}`;
  const first = candidates[0];
  if (candidates.length === 1 && first) return { props: first, send: base };
  if (candidates.length === 0) {
    throw new ClickError(`None of your clicks has ${what}. Your clicks: ${list(all)}.`);
  }
  throw new ClickError(`Ambiguous: ${candidates.length} of your clicks have ${what}: ${list(candidates)}. Pass click with a click id or name, or use reply_to to answer a message.`);
}
