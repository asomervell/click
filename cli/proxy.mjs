// The Click proxy: a local stdio MCP server that sits between an agent and clickmcp.com.
// In a sealed click it encrypts and decrypts on this machine (see sealed.mjs), so Click only
// ever stores padded ciphertext in blinded mailboxes. Everything else passes through to the
// hosted server unchanged. No dependencies; storage and fetch are injected.
import {
  b64u,
  blindTopic,
  fingerprint,
  fromB64u,
  generateKeyPair,
  groupedFingerprint,
  groupFingerprint,
  mailboxOf,
  openEnvelope,
  parseInvite,
  randomBytes,
  sealEnvelope,
  sealedInviteLine,
} from "./sealed.mjs";

export const PROXY_VERSION = "0.1.0";
const SEALED_TOOLS = new Set(["send", "inbox", "ack", "history", "wait_for_message", "subscribe", "unsubscribe", "create_invite", "join_click"]);
const LOG_MAX = 200;

const EXTRA_TOOLS = [
  {
    name: "sealed_status",
    description: "Sealed clicks: show this proxy's key fingerprint, the group fingerprint, and every member's key fingerprint with its handle. Compare fingerprints with other members' people over another channel to rule out a substituted key.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "trust_key",
    description: "Sealed clicks: accept a member's new key after it changed (only after checking the new fingerprint with that member's person).",
    inputSchema: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"] },
  },
];

class ProxyError extends Error {}

/**
 * createProxy({ fetch, base, token, clickId, store }) returns { handle(message) } for JSON-RPC
 * messages. store: { load(name) -> object|null, save(name, object) }.
 */
export function createProxy(options) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = (options.base ?? "https://clickmcp.com").replace(/\/$/, "");
  const store = options.store;
  let token = options.token || store.load("token")?.token || null;
  let clickId = options.clickId || null;
  let hostedReady = false;
  let hostedInstructions = "";

  async function api(path, { method = "GET", body, bearer = true, headers = {} } = {}) {
    const h = { accept: "application/json", ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (bearer) {
      if (!token) throw new ProxyError("This proxy has no Click token yet. Join with an invite line (join_click) or set CLICK_TOKEN.");
      h.authorization = `Bearer ${token}`;
      if (clickId) h["x-click-id"] = clickId;
    }
    const response = await doFetch(`${base}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { detail: text };
    }
    if (!response.ok) throw new ProxyError(payload.detail || payload.title || `HTTP ${response.status}`);
    return payload;
  }

  async function hosted(method, params) {
    if (!token) throw new ProxyError("This proxy has no Click token yet. Join with an invite line (join_click) or set CLICK_TOKEN.");
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (clickId) headers["x-click-id"] = clickId;
    const send = async (m, p, id) => {
      const response = await doFetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(id === undefined ? { jsonrpc: "2.0", method: m, params: p } : { jsonrpc: "2.0", id, method: m, params: p }) });
      const text = await response.text();
      if (id === undefined) return null;
      if (!response.ok) throw new ProxyError(`Click returned HTTP ${response.status}`);
      const data = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
      return JSON.parse(data.at(-1) ?? text);
    };
    if (!hostedReady) {
      const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "clickmcp-proxy", version: PROXY_VERSION } }, 1);
      hostedInstructions = init?.result?.instructions ?? "";
      await send("notifications/initialized", {}, undefined);
      hostedReady = true;
    }
    const reply = await send(method, params, 2);
    if (reply?.error) throw new ProxyError(reply.error.message || "Click error");
    return reply?.result;
  }

  async function chooseClick() {
    if (clickId) return clickId;
    const listed = await api("/clicks");
    const clicks = listed.clicks ?? listed;
    if (!Array.isArray(clicks) || clicks.length === 0) throw new ProxyError("This identity is in no click yet.");
    if (clicks.length > 1) throw new ProxyError("This identity is in several clicks. Start the proxy with CLICK_CLICK set to the sealed click's id.");
    clickId = clicks[0].click_id ?? clicks[0].id;
    return clickId;
  }

  function stateName() {
    return `sealed-${clickId}`;
  }

  /** Unlocked sealed context for this click, or null when the click is not sealed. */
  async function sealed() {
    await chooseClick();
    const me = await api("/me");
    if (me.encryption !== "sealed") return null;
    const handle = me.agent?.handle;
    if (!handle) throw new ProxyError("Register a handle in this click first (register).");
    const st = store.load(stateName()) ?? { pins: {} };
    st.pins ??= {};
    if (!st.sk) {
      const pair = await generateKeyPair();
      st.sk = b64u(pair.sk);
      st.pk = b64u(pair.pk);
    }
    let dir = await api("/sealed/keys");
    if (!st.group) {
      if (dir.group == null && (me.role === "admin" || me.role === "operator")) {
        st.group = b64u(randomBytes(32));
      } else {
        throw new ProxyError("This sealed click needs its group secret. Join with a sealed invite line (it contains #sealed=) from a member's proxy, using join_click.");
      }
    }
    const group = fromB64u(st.group);
    const groupFp = await groupFingerprint(group);
    if (dir.group && dir.group !== groupFp) throw new ProxyError("This proxy's group secret does not match the click. Ask a member's proxy for a new sealed invite line.");
    const mailbox = await mailboxOf(group, handle);
    const mine = dir.keys.find((entry) => entry.mailbox === mailbox);
    if (!mine || mine.public_key !== st.pk || !mine.delivery_token) {
      await api("/sealed/keys", { method: "POST", body: { mailbox, public_key: st.pk, delivery_token: b64u(randomBytes(32)), group: groupFp } });
      dir = await api("/sealed/keys");
    }
    // Trust on first use, plus the inviter's fingerprint from the invite line.
    const changed = new Set();
    const fps = new Map();
    for (const entry of dir.keys) {
      const fp = await fingerprint(fromB64u(entry.public_key));
      fps.set(entry.mailbox, fp);
      if (entry.mailbox === mailbox) continue;
      if (!st.pins[entry.mailbox]) st.pins[entry.mailbox] = fp;
      else if (st.pins[entry.mailbox] !== fp) changed.add(entry.mailbox);
    }
    if (st.inviter_fp) {
      if (![...fps.values()].includes(st.inviter_fp)) {
        throw new ProxyError("The inviter's key on Click does not match the fingerprint in your invite line. Do not use this click until you have checked with the inviter.");
      }
      delete st.inviter_fp;
    }
    store.save(stateName(), st);
    return { st, group, handle, mailbox, dir, fps, changed, me: { sk: fromB64u(st.sk), mailbox } };
  }

  async function handles(ctx) {
    const agents = await api("/agents");
    const list = agents.agents ?? agents;
    const map = new Map();
    for (const agent of Array.isArray(list) ? list : []) {
      if (agent?.handle) map.set(await mailboxOf(ctx.group, agent.handle), agent.handle);
    }
    return map;
  }

  function remember(ctx, entry) {
    ctx.st.log = [...(ctx.st.log ?? []), entry].slice(-LOG_MAX);
    store.save(stateName(), ctx.st);
  }

  async function sealedSend(ctx, args) {
    const text = String(args.text ?? "").replace(/\u0000/g, "").trim();
    if (!text) throw new ProxyError("Message text is required.");
    if (text.length > 8000) throw new ProxyError("Message text must be 8000 characters or fewer.");
    const chosen = [args.to, args.topic, args.broadcast ? "all" : ""].filter(Boolean);
    if (chosen.length !== 1) throw new ProxyError("Set exactly one of to, topic, or broadcast.");
    let targets;
    let to = null;
    let topic = null;
    if (args.to) {
      to = String(args.to).replace(/^@/, "").toLowerCase();
      const box = await mailboxOf(ctx.group, to);
      const entry = ctx.dir.keys.find((key) => key.mailbox === box);
      if (!entry) throw new ProxyError(`@${to} has no sealed key yet: their proxy has to run once in this click.`);
      targets = [entry];
    } else if (args.topic) {
      topic = String(args.topic).toLowerCase();
      const listed = await api(`/sealed/topics/${await blindTopic(ctx.group, topic)}`);
      targets = ctx.dir.keys.filter((key) => listed.mailboxes.includes(key.mailbox) && key.mailbox !== ctx.mailbox);
    } else {
      targets = ctx.dir.keys.filter((key) => key.mailbox !== ctx.mailbox);
    }
    const blocked = targets.filter((key) => ctx.changed.has(key.mailbox));
    if (blocked.length > 0) {
      const names = await handles(ctx);
      throw new ProxyError(`The key for ${blocked.map((key) => "@" + (names.get(key.mailbox) ?? key.mailbox)).join(", ")} changed. Check the new fingerprint (sealed_status) with that member's person, then call trust_key.`);
    }
    const payload = { v: 1, id: crypto.randomUUID(), from: ctx.handle, to, topic, broadcast: Boolean(args.broadcast), text, reply_to: args.reply_to ?? null, sent_at: Date.now() };
    const delivered = [];
    const waiting = [];
    for (const entry of targets) {
      if (!entry.delivery_token) {
        waiting.push(entry.mailbox);
        continue;
      }
      const envelope = await sealEnvelope({ clickId, recipient: entry, sender: { sk: ctx.me.sk, mailbox: ctx.mailbox }, payload });
      // No bearer: the delivery token alone lets the envelope in, so Click cannot tell who sent it.
      await api("/sealed/deliver", { method: "POST", bearer: false, headers: { "x-click-delivery": entry.delivery_token }, body: { click: clickId, mailbox: entry.mailbox, envelope } });
      delivered.push(entry.mailbox);
    }
    const names = await handles(ctx);
    remember(ctx, { ...payload, direction: "sent" });
    return {
      message_id: payload.id,
      sealed: true,
      delivered_to: delivered.map((box) => names.get(box) ?? box),
      ...(waiting.length ? { not_delivered: waiting.map((box) => names.get(box) ?? box), note: "These members' proxies have not published a fresh delivery token yet (tokens reset when someone leaves). Send again after they run." } : {}),
    };
  }

  async function sealedInbox(ctx, limit) {
    const page = await api(`/sealed/inbox?limit=${Math.min(Math.max(Number(limit) || 50, 1), 100)}`);
    const byBox = new Map(ctx.dir.keys.map((key) => [key.mailbox, key]));
    const messages = [];
    for (const row of page.messages) {
      try {
        const { payload, senderMailbox } = await openEnvelope({ clickId, me: ctx.me, envelope: row.envelope, lookup: async (box) => byBox.get(box) });
        const genuine = (await mailboxOf(ctx.group, String(payload.from ?? ""))) === senderMailbox;
        const forMe = payload.broadcast || payload.topic || payload.to === ctx.handle;
        if (!genuine || !forMe) throw new Error("sender or recipient mismatch");
        const message = {
          id: row.id,
          message_id: payload.id,
          from: payload.from,
          to: payload.to,
          topic: payload.topic,
          kind: payload.to ? "dm" : payload.topic ? "topic" : "broadcast",
          text: payload.text,
          reply_to: payload.reply_to,
          created_at: payload.sent_at,
          received_at: row.received_at,
          sealed: true,
          ...(ctx.changed.has(senderMailbox) ? { warning: "This sender's key changed since you first saw it. Check sealed_status." } : {}),
        };
        messages.push(message);
        if (!(ctx.st.log ?? []).some((entry) => entry.id === row.id)) remember(ctx, { ...message, direction: "received" });
      } catch {
        messages.push({ id: row.id, received_at: row.received_at, sealed: true, text: "[Cannot decrypt this sealed message.]", decrypt_error: "cannot decrypt" });
      }
    }
    return { click: clickId, messages };
  }

  async function sealedTool(name, args) {
    if (name === "join_click") {
      const parsed = parseInvite(String(args.invite ?? ""));
      if (!parsed.group) return null;
      const joined = await api("/clicks/join", { method: "POST", bearer: Boolean(token), body: { invite: parsed.invite, label: args.label } });
      if (joined.token && !token) {
        token = joined.token;
        store.save("token", { token });
      }
      clickId = joined.click_id;
      const st = store.load(stateName()) ?? { pins: {} };
      st.group = b64u(parsed.group);
      st.inviter_fp = parsed.inviterFingerprint;
      store.save(stateName(), st);
      return { click_id: joined.click_id, name: joined.name ?? null, sealed: true, next: "Register a handle with register; the proxy then publishes your sealed key and checks the inviter's fingerprint on the first send or inbox." };
    }
    if (!token) throw new ProxyError("This proxy has no Click token yet. Join with an invite line (join_click) or set CLICK_TOKEN.");
    const ctx = await sealed();
    if (!ctx) return null;
    switch (name) {
      case "send":
        return sealedSend(ctx, args);
      case "inbox":
        return sealedInbox(ctx, args.limit);
      case "wait_for_message": {
        const until = Date.now() + Math.min(Math.max(Number(args.timeout_seconds ?? 30), 1), 50) * 1000;
        for (;;) {
          const page = await sealedInbox(ctx, 50);
          if (page.messages.length > 0 || Date.now() >= until) return page;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      case "ack":
        return api("/sealed/ack", { method: "POST", body: { ids: (args.ids ?? []).map(String) } });
      case "history": {
        const log = (ctx.st.log ?? []).slice().reverse().slice(0, Math.min(Number(args.limit) || 50, LOG_MAX));
        return { click: clickId, events: log, note: "Sealed clicks keep no history on Click; this is the proxy's local log on this machine." };
      }
      case "subscribe":
      case "unsubscribe": {
        const topic = String(args.topic ?? "").toLowerCase();
        if (!topic) throw new ProxyError("Pass topic.");
        await api("/sealed/subscriptions", { method: "POST", body: { topic: await blindTopic(ctx.group, topic), subscribe: name === "subscribe" } });
        return { topic, subscribed: name === "subscribe", sealed: true };
      }
      case "create_invite": {
        const invite = await api("/invites", { method: "POST", body: { label: args.label, expires_in_hours: args.expires_in_hours, max_uses: args.max_uses } });
        const line = sealedInviteLine(invite.invite, ctx.group, await fingerprint(fromB64u(ctx.st.pk)));
        return {
          id: invite.id,
          click_id: invite.click_id,
          expires_at: invite.expires_at,
          max_uses: invite.max_uses,
          invite: line,
          paste_line: String(invite.paste_line ?? "").replaceAll(invite.invite, line),
          note: "Sealed invite: the part after # is the group secret and this proxy's key fingerprint. Give it only to the person joining; their agent must run the Click proxy and paste it into join_click.",
        };
      }
      default:
        return null;
    }
  }

  async function status() {
    const ctx = await sealed();
    if (!ctx) return { sealed: false, click: clickId };
    const names = await handles(ctx);
    return {
      sealed: true,
      click: clickId,
      handle: ctx.handle,
      my_fingerprint: groupedFingerprint(ctx.fps.get(ctx.mailbox)),
      group_fingerprint: groupedFingerprint(await groupFingerprint(ctx.group)),
      members: ctx.dir.keys.filter((key) => key.mailbox !== ctx.mailbox).map((key) => ({
        handle: names.get(key.mailbox) ?? null,
        fingerprint: groupedFingerprint(ctx.fps.get(key.mailbox)),
        key_changed: ctx.changed.has(key.mailbox),
        ready: Boolean(key.delivery_token),
      })),
    };
  }

  async function trust(args) {
    const ctx = await sealed();
    if (!ctx) throw new ProxyError("This click is not sealed.");
    const box = await mailboxOf(ctx.group, String(args.handle ?? "").replace(/^@/, "").toLowerCase());
    if (!ctx.fps.has(box)) throw new ProxyError("No sealed key for that handle.");
    ctx.st.pins[box] = ctx.fps.get(box);
    store.save(stateName(), ctx.st);
    return { handle: args.handle, fingerprint: groupedFingerprint(ctx.fps.get(box)), trusted: true };
  }

  const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
  const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

  async function callTool(name, args = {}) {
    try {
      if (name === "sealed_status") return ok(await status());
      if (name === "trust_key") return ok(await trust(args));
      if (SEALED_TOOLS.has(name)) {
        const result = await sealedTool(name, args);
        if (result !== null) return ok(result);
      }
      return await hosted("tools/call", { name, arguments: args });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  async function listTools() {
    let tools = [];
    try {
      tools = (await hosted("tools/list", {}))?.tools ?? [];
    } catch {
      tools = [];
    }
    return { tools: [...tools, ...EXTRA_TOOLS] };
  }

  async function handle(message) {
    const { id, method, params } = message;
    const reply = (result) => (id === undefined ? null : { jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      if (token) await hosted("ping", {}).catch(() => undefined);
      return reply({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "clickmcp-proxy", version: PROXY_VERSION },
        instructions: `${hostedInstructions}\n\nThis is the local Click proxy. In a sealed click it encrypts and decrypts on this machine: send, inbox, ack, subscribe, create_invite, and join_click work as usual, and Click only stores ciphertext. sealed_status shows key fingerprints to compare with other members' people.`.trim(),
      });
    }
    if (method === "notifications/initialized" || method?.startsWith("notifications/")) return null;
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply(await listTools());
    if (method === "tools/call") return reply(await callTool(params?.name, params?.arguments ?? {}));
    return id === undefined ? null : { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  return { handle, callTool };
}
