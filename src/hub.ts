import { DurableObject } from "cloudflare:workers";
import { randomToken, sha256Hex } from "./crypto";
import { getDirectory } from "./directory";
import { ClickError, inviteLine, type ClickProps, type Profile, type PublicAgent, type Role } from "./types";
import {
  clampLimit,
  parseWebhookUrl,
  requireDescription,
  requireHandle,
  requireName,
  requireText,
  requireWebhookKey,
} from "./validate";
import { postDoorbell, retryDelayMs, type WakeOutcome } from "./webhook";

type AgentRow = {
  id: string;
  principal_id: string;
  handle: string;
  name: string;
  description: string;
  webhook_url: string | null;
  webhook_key: string | null;
  created_at: number;
};

type SendInput = {
  text: string;
  to?: string;
  topic?: string;
  broadcast?: boolean;
  reply_to?: string;
};

/** What a caller may know about one message it can see, for routing a reply. */
export type LocatedMessage = {
  event_id: string;
  kind: "dm" | "topic" | "broadcast";
  topic: string | null;
  from: string | null;
  to: string | null;
  mine: boolean;
};

export type WakeSummary = {
  attempted: number;
  delivered: number;
  retrying: number;
  failed: number;
};

const LOCK_MS = 60_000;
const INVITE_DEFAULT_HOURS = 7 * 24;
const DOORBELL_LINK_MS = 30 * 60_000;
const INVITE_MAX_HOURS = 30 * 24;

const CLICK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function getHub(env: Env, clickId: string): DurableObjectStub<ClickHub> {
  if (!CLICK_ID.test(clickId)) throw new ClickError("Unknown click.");
  return env.CLICK.getByName(clickId);
}

/**
 * One SQLite Durable Object per click. Agents, messages, and webhook retries
 * for that click commit together and are invisible to every other click.
 */
export class ClickHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS principals (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL UNIQUE,
        handle TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        webhook_url TEXT,
        webhook_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        principal_id TEXT NOT NULL,
        role TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        created_by TEXT NOT NULL,
        used_by TEXT,
        created_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        topic TEXT,
        from_agent_id TEXT NOT NULL,
        to_agent_id TEXT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_created ON events (created_at);
      CREATE INDEX IF NOT EXISTS events_from ON events (from_agent_id, created_at);
      CREATE INDEX IF NOT EXISTS events_topic ON events (topic, created_at);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        acked_at INTEGER,
        wake_status TEXT NOT NULL,
        wake_attempts INTEGER NOT NULL DEFAULT 0,
        wake_next_at INTEGER,
        wake_locked_until INTEGER,
        wake_last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS deliveries_inbox ON deliveries (agent_id, acked_at, created_at);
      CREATE INDEX IF NOT EXISTS deliveries_wake ON deliveries (wake_status, wake_next_at);
      CREATE TABLE IF NOT EXISTS subscriptions (
        topic TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (topic, agent_id)
      );
      CREATE TABLE IF NOT EXISTS click_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        email TEXT NOT NULL,
        click_key TEXT NOT NULL,
        admin_principal TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.addColumn("click_meta", "click_id", "TEXT");
    this.addColumn("click_meta", "name", "TEXT");
    this.addColumn("invites", "expires_at", "INTEGER");
    this.addColumn("invites", "revoked_at", "INTEGER");
    this.addColumn("events", "reply_to", "TEXT");
  }

  private addColumn(table: string, column: string, type: string): void {
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
      .toArray()
      .map((row) => row.name);
    if (!columns.includes(column)) this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private knownClickId: string | null = null;

  /** Agents blocked in wait_for_message, by agent id. Woken on send. */
  private waiters = new Map<string, Set<() => void>>();

  /**
   * Wait up to ms for an unread message for this agent. Returns at once when one is already
   * waiting. Resolves true when something arrived, false on timeout.
   */
  async waitForMessage(props: ClickProps, ms: number): Promise<boolean> {
    const agent = this.requireAgent(props.principalId);
    if (this.unreadFor(agent.id) > 0) return true;
    const limit = Math.max(0, Math.min(ms, 50_000));
    if (limit === 0) return false;
    return new Promise<boolean>((resolve) => {
      const set = this.waiters.get(agent.id) ?? new Set<() => void>();
      this.waiters.set(agent.id, set);
      let done = false;
      const finish = (arrived: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        set.delete(wake);
        if (set.size === 0) this.waiters.delete(agent.id);
        resolve(arrived);
      };
      const wake = () => finish(true);
      const timer = setTimeout(() => finish(false), limit);
      set.add(wake);
    });
  }

  private unreadFor(agentId: string): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND acked_at IS NULL`, agentId)
      .one().n;
  }

  private wakeWaiters(agentIds: string[]): void {
    for (const id of agentIds) {
      const set = this.waiters.get(id);
      if (!set) continue;
      for (const wake of [...set]) wake();
    }
  }

  /** Remember which click this object serves, so alarms can label doorbells. Legacy hubs learn it lazily. */
  private noteClick(clickId: string): void {
    if (this.knownClickId === clickId) return;
    this.knownClickId = clickId;
    this.ctx.storage.sql.exec(`UPDATE click_meta SET click_id = ? WHERE id = 1 AND (click_id IS NULL OR click_id != ?)`, clickId, clickId);
  }

  private clickLabel(): { id: string | null; name: string | null } {
    const row = this.ctx.storage.sql
      .exec<{ click_id: string | null; name: string | null }>(`SELECT click_id, name FROM click_meta WHERE id = 1`)
      .toArray()[0];
    return { id: row?.click_id ?? this.knownClickId, name: row?.name ?? null };
  }

  async setName(props: ClickProps, name: string | null): Promise<{ click_id: string; name: string | null }> {
    this.assertAdmin(props.role);
    this.noteClick(props.clickId);
    this.ctx.storage.sql.exec(`UPDATE click_meta SET name = ? WHERE id = 1`, name);
    return { click_id: props.clickId, name };
  }

  /** Every principal created in this click. */
  async principalIds(): Promise<string[]> {
    return this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM principals`).toArray().map((row) => row.id);
  }

  /** Erase this click's storage: mailbox, agents, invites, tokens, meta, and any pending alarm. */
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.knownClickId = null;
  }

  /**
   * A one-time link the person opens to paste this agent's webhook URL and key straight
   * into Click, so the key never passes through chat. Expires in 30 minutes.
   */
  async createDoorbellLink(props: ClickProps): Promise<{ token: string; handle: string; expires_at: number }> {
    this.noteClick(props.clickId);
    const agent = this.requireAgent(props.principalId);
    this.ensureDoorbellTable();
    const token = randomToken("clk_bell_");
    const expiresAt = Date.now() + DOORBELL_LINK_MS;
    this.ctx.storage.sql.exec(
      `INSERT INTO doorbell_links (token_hash, principal_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      await sha256Hex(token),
      props.principalId,
      Date.now(),
      expiresAt,
    );
    return { token, handle: agent.handle, expires_at: expiresAt };
  }

  /** Who a doorbell link is for, while it is open. */
  async doorbellLinkInfo(token: string): Promise<{ handle: string; click_name: string | null } | null> {
    this.ensureDoorbellTable();
    const row = this.openDoorbellLink(await sha256Hex(token));
    if (!row) return null;
    const agent = this.agentByPrincipal(row.principal_id);
    if (!agent) return null;
    return { handle: agent.handle, click_name: this.clickLabel().name };
  }

  /** Use a doorbell link once: set the agent's webhook URL and key. */
  async useDoorbellLink(token: string, url: string, key: string): Promise<{ handle: string }> {
    this.ensureDoorbellTable();
    const tokenHash = await sha256Hex(token);
    const row = this.openDoorbellLink(tokenHash);
    if (!row) throw new ClickError("This doorbell link expired or was already used. Ask your agent for a new one.");
    const agent = this.agentByPrincipal(row.principal_id);
    if (!agent) throw new ClickError("That agent is no longer registered in this click.");
    const webhook = this.optionalWebhook(url, key);
    if (!webhook) throw new ClickError("Paste both the webhook URL and the webhook key.");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`UPDATE doorbell_links SET used_at = ? WHERE token_hash = ?`, Date.now(), tokenHash);
      this.ctx.storage.sql.exec(
        `UPDATE agents SET webhook_url = ?, webhook_key = ?, updated_at = ? WHERE id = ?`,
        webhook.url,
        webhook.key,
        Date.now(),
        agent.id,
      );
    });
    return { handle: agent.handle };
  }

  private ensureDoorbellTable(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS doorbell_links (
      token_hash TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    )`);
  }

  private openDoorbellLink(tokenHash: string): { principal_id: string } | undefined {
    return this.ctx.storage.sql
      .exec<{ principal_id: string }>(
        `SELECT principal_id FROM doorbell_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
        tokenHash,
        Date.now(),
      )
      .toArray()[0];
  }

  async initClick(input: { email: string; clickKey: string; adminId: string; clickId?: string; name?: string | null }): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO click_meta (id, email, click_key, admin_principal, created_at, click_id, name) VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      input.email,
      input.clickKey,
      input.adminId,
      Date.now(),
      input.clickId ?? null,
      input.name ?? null,
    );
    this.ensurePrincipal(input.adminId, "admin", null);
  }

  async createMember(label: string | null): Promise<{ principalId: string; role: "member" }> {
    const count = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM agents`).one().n;
    if (count >= 100) throw new ClickError("This click already has 100 agents.");
    const id = crypto.randomUUID();
    this.ensurePrincipal(id, "member", label);
    return { principalId: id, role: "member" };
  }

  async consumeInviteHash(tokenHash: string, label: string | null): Promise<{ principalId: string; role: "member" } | null> {
    const principalId = crypto.randomUUID();
    const now = Date.now();
    const consumed = this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql
        .exec<{ id: string }>(
          `UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL RETURNING id`,
          now,
          principalId,
          tokenHash,
        )
        .toArray();
      if (rows.length !== 1) return false;
      this.ensurePrincipal(principalId, "member", label);
      return true;
    });
    return consumed ? { principalId, role: "member" } : null;
  }

  async resolveTokenHash(tokenHash: string): Promise<{ principalId: string; role: Role } | null> {
    const row = this.ctx.storage.sql
      .exec<{ principal_id: string; role: Role }>(
        `SELECT principal_id, role FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL`,
        tokenHash,
      )
      .toArray()[0];
    if (!row || (row.role !== "admin" && row.role !== "member" && row.role !== "operator")) return null;
    return { principalId: row.principal_id, role: row.role };
  }

  async register(props: ClickProps, input: {
    handle: string;
    name?: string;
    description?: string;
    webhook_url?: string;
    webhook_key?: string;
  }): Promise<Profile> {
    const handle = requireHandle(input.handle);
    const existing = this.agentByPrincipal(props.principalId);
    if (existing) {
      if (existing.handle !== handle) {
        throw new ClickError(`This connection is already registered as ${existing.handle}. Use update_profile.`);
      }
      return this.updateProfile(props, {
        name: input.name,
        description: input.description,
        webhook_url: input.webhook_url,
        webhook_key: input.webhook_key,
      });
    }
    const name = requireName(input.name, handle);
    const description = requireDescription(input.description);
    const webhook = this.optionalWebhook(input.webhook_url, input.webhook_key);
    if (this.agentByHandle(handle)) throw new ClickError(`The handle ${handle} is taken.`);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ensurePrincipal(props.principalId, props.role, null);
      this.ctx.storage.sql.exec(
        `INSERT INTO agents (id, principal_id, handle, name, description, webhook_url, webhook_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        props.principalId,
        handle,
        name,
        description,
        webhook?.url ?? null,
        webhook?.key ?? null,
        now,
        now,
      );
    });
    return this.whoami(props);
  }

  async updateProfile(props: ClickProps, input: {
    name?: string;
    description?: string;
    webhook_url?: string;
    webhook_key?: string;
    clear_webhook?: boolean;
  }): Promise<Profile> {
    const agent = this.requireAgent(props.principalId);
    const name = input.name == null ? agent.name : requireName(input.name, agent.handle);
    const description = input.description == null ? agent.description : requireDescription(input.description);
    let webhookUrl = agent.webhook_url;
    let webhookKey = agent.webhook_key;
    if (input.clear_webhook) {
      webhookUrl = null;
      webhookKey = null;
    } else if (input.webhook_url != null || input.webhook_key != null) {
      const webhook = this.optionalWebhook(input.webhook_url, input.webhook_key);
      if (!webhook) throw new ClickError("Provide both webhook_url and webhook_key, or set clear_webhook.");
      webhookUrl = webhook.url;
      webhookKey = webhook.key;
    }
    this.ctx.storage.sql.exec(
      `UPDATE agents SET name = ?, description = ?, webhook_url = ?, webhook_key = ?, updated_at = ? WHERE id = ?`,
      name,
      description,
      webhookUrl,
      webhookKey,
      Date.now(),
      agent.id,
    );
    return this.whoami(props);
  }

  async whoami(props: ClickProps): Promise<Profile> {
    this.noteClick(props.clickId);
    const label = this.ctx.storage.sql
      .exec<{ label: string | null }>(`SELECT label FROM principals WHERE id = ?`, props.principalId)
      .toArray()[0]?.label ?? null;
    const agent = this.agentByPrincipal(props.principalId);
    return {
      principal_id: props.principalId,
      click_id: props.clickId,
      click_name: this.clickLabel().name,
      role: props.role,
      label,
      email: props.role === "member" ? null : (this.meta()?.email ?? null),
      agent: agent
        ? {
            handle: agent.handle,
            name: agent.name,
            description: agent.description,
            webhook_url: agent.webhook_url,
            webhook_configured: Boolean(agent.webhook_url && agent.webhook_key),
            created_at: agent.created_at,
          }
        : null,
    };
  }

  async listAgents(): Promise<PublicAgent[]> {
    return this.ctx.storage.sql
      .exec<PublicAgent>(
        `SELECT handle, name, description, created_at FROM agents ORDER BY handle LIMIT 200`,
      )
      .toArray();
  }

  async send(props: ClickProps, input: SendInput): Promise<{
    event_id: string;
    kind: "dm" | "topic" | "broadcast";
    recipients: string[];
  }> {
    this.noteClick(props.clickId);
    const from = this.requireAgent(props.principalId);
    const since = Date.now() - 60_000;
    const recent = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE from_agent_id = ? AND created_at > ?`, from.id, since)
      .one().n;
    if (recent >= 30) throw new ClickError("Too many messages in the last minute. Wait and try again.");
    const text = requireText(input.text);
    const replyTo = input.reply_to ? this.locateRow(from.id, input.reply_to)?.event_id ?? null : null;
    const chosen = [input.to?.trim(), input.topic?.trim(), input.broadcast ? "broadcast" : ""].filter(Boolean);
    if (chosen.length !== 1) throw new ClickError("Set exactly one of to, topic, or broadcast.");
    const now = Date.now();
    const eventId = crypto.randomUUID();
    let kind: "dm" | "topic" | "broadcast";
    let topic: string | null = null;
    let toAgentId: string | null = null;
    let recipients: AgentRow[] = [];

    if (input.to?.trim()) {
      const handle = requireHandle(input.to, "to");
      if (handle === from.handle) throw new ClickError("You cannot message yourself.");
      const to = this.agentByHandle(handle);
      if (!to) throw new ClickError(`No agent named ${handle}.`);
      kind = "dm";
      toAgentId = to.id;
      recipients = [to];
    } else if (input.topic?.trim()) {
      topic = requireHandle(input.topic, "topic");
      kind = "topic";
      recipients = this.subscribers(topic).filter((agent) => agent.id !== from.id);
    } else {
      kind = "broadcast";
      recipients = this.ctx.storage.sql
        .exec<AgentRow>(`SELECT * FROM agents WHERE id != ?`, from.id)
        .toArray();
    }

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO events (id, kind, topic, from_agent_id, to_agent_id, text, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        kind,
        topic,
        from.id,
        toAgentId,
        text,
        now,
        replyTo,
      );
      for (const recipient of recipients) {
        const wake = Boolean(recipient.webhook_url && recipient.webhook_key);
        this.ctx.storage.sql.exec(
          `INSERT INTO deliveries (id, event_id, agent_id, created_at, wake_status, wake_attempts, wake_next_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
          crypto.randomUUID(),
          eventId,
          recipient.id,
          now,
          wake ? "queued" : "none",
          wake ? 0 : null,
        );
      }
    });
    this.wakeWaiters(recipients.map((agent) => agent.id));
    await this.scheduleAlarm();
    return { event_id: eventId, kind, recipients: recipients.map((agent) => agent.handle) };
  }

  /**
   * Unacked deliveries. Oldest first by default (the single-click order).
   * order "desc" is newest first; with older_than it pages past a (created_at, id) cursor.
   */
  async inbox(props: ClickProps, limit: number | undefined, options: {
    order?: "asc" | "desc";
    olderThan?: { t: number; id: string } | null;
  } = {}): Promise<{
    messages: Array<{
      id: string;
      event_id: string;
      from: string;
      kind: string;
      topic: string | null;
      text: string;
      created_at: number;
      reply_to: string | null;
    }>;
  }> {
    const agent = this.requireAgent(props.principalId);
    const desc = options.order === "desc";
    const cursor = desc ? options.olderThan ?? null : null;
    const messages = this.ctx.storage.sql
      .exec<{
        id: string;
        event_id: string;
        from_handle: string;
        kind: string;
        topic: string | null;
        text: string;
        created_at: number;
        reply_to: string | null;
      }>(
        `SELECT d.id, d.event_id, COALESCE(s.handle, '(left)') AS from_handle, e.kind, e.topic, e.text, e.created_at, e.reply_to
         FROM deliveries d
         JOIN events e ON e.id = d.event_id
         LEFT JOIN agents s ON s.id = e.from_agent_id
         WHERE d.agent_id = ? AND d.acked_at IS NULL
           AND (? IS NULL OR e.created_at < ? OR (e.created_at = ? AND d.id < ?))
         ORDER BY ${desc ? "e.created_at DESC, d.id DESC" : "e.created_at ASC, d.id ASC"}
         LIMIT ?`,
        agent.id,
        cursor?.t ?? null,
        cursor?.t ?? null,
        cursor?.t ?? null,
        cursor?.id ?? "",
        clampLimit(limit),
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        event_id: row.event_id,
        from: row.from_handle,
        kind: row.kind,
        topic: row.topic,
        text: row.text,
        created_at: row.created_at,
        reply_to: row.reply_to,
      }));
    return { messages };
  }

  /** Unacked count, for "has more" across clicks. Zero when no agent is registered here. */
  async unreadCount(props: ClickProps): Promise<number> {
    const agent = this.agentByPrincipal(props.principalId);
    if (!agent) return 0;
    return this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND acked_at IS NULL`, agent.id)
      .one().n;
  }

  /** True when this connection has an agent registered here. */
  async isRegistered(props: ClickProps): Promise<boolean> {
    return Boolean(this.agentByPrincipal(props.principalId));
  }

  /** Whether a handle or a subscribed topic exists here, for routing a new send. */
  async hasTarget(input: { to?: string; topic?: string }): Promise<boolean> {
    if (input.to?.trim()) return Boolean(this.agentByHandle(input.to.trim().toLowerCase()));
    if (input.topic?.trim()) {
      return this.ctx.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM subscriptions WHERE topic = ?`, input.topic.trim().toLowerCase())
        .one().n > 0;
    }
    return false;
  }

  /** Find a message by delivery id or event id, if this caller can see it. */
  async locate(props: ClickProps, id: string): Promise<LocatedMessage | null> {
    const agent = this.agentByPrincipal(props.principalId);
    if (!agent) return null;
    return this.locateRow(agent.id, id);
  }

  private locateRow(agentId: string, rawId: string): LocatedMessage | null {
    const id = rawId.trim();
    if (!id) return null;
    const row = this.ctx.storage.sql
      .exec<{ event_id: string; kind: "dm" | "topic" | "broadcast"; topic: string | null; from_agent_id: string; from_handle: string | null; to_handle: string | null }>(
        `SELECT e.id AS event_id, e.kind, e.topic, e.from_agent_id, s.handle AS from_handle, t.handle AS to_handle
         FROM events e
         LEFT JOIN agents s ON s.id = e.from_agent_id
         LEFT JOIN agents t ON t.id = e.to_agent_id
         WHERE (e.id = ? OR e.id = (SELECT event_id FROM deliveries WHERE id = ? AND agent_id = ?))
           AND (e.from_agent_id = ? OR e.id IN (SELECT event_id FROM deliveries WHERE agent_id = ?))
         LIMIT 1`,
        id,
        id,
        agentId,
        agentId,
        agentId,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      event_id: row.event_id,
      kind: row.kind,
      topic: row.topic,
      from: row.from_handle,
      to: row.to_handle,
      mine: row.from_agent_id === agentId,
    };
  }

  async ack(props: ClickProps, ids: string[]): Promise<{ acked: string[]; missing: string[] }> {
    const agent = this.requireAgent(props.principalId);
    if (ids.length > 50) throw new ClickError("Ack at most 50 ids at a time.");
    const acked: string[] = [];
    const missing: string[] = [];
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) {
        const updated = this.ctx.storage.sql.exec(
          `UPDATE deliveries SET acked_at = ? WHERE id = ? AND agent_id = ? AND acked_at IS NULL`,
          now,
          id,
          agent.id,
        );
        if (updated.rowsWritten === 1) {
          acked.push(id);
          continue;
        }
        const already = this.ctx.storage.sql
          .exec<{ id: string }>(
            `SELECT id FROM deliveries WHERE id = ? AND agent_id = ? AND acked_at IS NOT NULL`,
            id,
            agent.id,
          )
          .toArray();
        if (already.length === 1) acked.push(id);
        else missing.push(id);
      }
    });
    return { acked, missing };
  }

  async subscribe(props: ClickProps, topic: string): Promise<{ topic: string; subscribed: true }> {
    const agent = this.requireAgent(props.principalId);
    const name = requireHandle(topic, "topic");
    this.ctx.storage.sql.exec(
      `INSERT INTO subscriptions (topic, agent_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT (topic, agent_id) DO NOTHING`,
      name,
      agent.id,
      Date.now(),
    );
    return { topic: name, subscribed: true };
  }

  async unsubscribe(props: ClickProps, topic: string): Promise<{ topic: string; subscribed: false }> {
    const agent = this.requireAgent(props.principalId);
    const name = requireHandle(topic, "topic");
    this.ctx.storage.sql.exec(`DELETE FROM subscriptions WHERE topic = ? AND agent_id = ?`, name, agent.id);
    return { topic: name, subscribed: false };
  }

  async listTopics(): Promise<Array<{ topic: string; subscribers: string[] }>> {
    const rows = this.ctx.storage.sql
      .exec<{ topic: string; handle: string }>(
        `SELECT s.topic, a.handle FROM subscriptions s JOIN agents a ON a.id = s.agent_id ORDER BY s.topic, a.handle`,
      )
      .toArray();
    const topics = new Map<string, string[]>();
    for (const row of rows) {
      const handles = topics.get(row.topic) ?? [];
      handles.push(row.handle);
      topics.set(row.topic, handles);
    }
    return [...topics.entries()].map(([topic, subscribers]) => ({ topic, subscribers }));
  }

  async history(props: ClickProps, input: {
    topic?: string;
    with?: string;
    before?: number;
    before_id?: string;
    limit?: number;
  }): Promise<{
    events: Array<{
      id: string;
      kind: string;
      topic: string | null;
      from: string;
      to: string | null;
      text: string;
      created_at: number;
      reply_to: string | null;
    }>;
  }> {
    const agent = this.requireAgent(props.principalId);
    const limit = clampLimit(input.limit);
    const before = input.before ?? Number.MAX_SAFE_INTEGER;
    const beforeId = input.before_id ?? "";
    type HistoryRow = {
      id: string;
      kind: string;
      topic: string | null;
      from_handle: string;
      to_handle: string | null;
      text: string;
      created_at: number;
      reply_to: string | null;
    };
    let rows: HistoryRow[];
    if (input.topic?.trim()) {
      const topic = requireHandle(input.topic, "topic");
      rows = this.ctx.storage.sql
        .exec<HistoryRow>(
          `SELECT e.id, e.kind, e.topic, COALESCE(s.handle, '(left)') AS from_handle, t.handle AS to_handle, e.text, e.created_at, e.reply_to
           FROM events e
           LEFT JOIN agents s ON s.id = e.from_agent_id
           LEFT JOIN agents t ON t.id = e.to_agent_id
           WHERE e.kind = 'topic' AND e.topic = ? AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))
           ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
          topic,
          before,
          before,
          beforeId,
          limit,
        )
        .toArray();
    } else if (input.with?.trim()) {
      const other = this.agentByHandle(requireHandle(input.with, "with"));
      if (!other) throw new ClickError(`No agent named ${input.with.trim().toLowerCase()}.`);
      rows = this.ctx.storage.sql
        .exec<HistoryRow>(
          `SELECT e.id, e.kind, e.topic, COALESCE(s.handle, '(left)') AS from_handle, t.handle AS to_handle, e.text, e.created_at, e.reply_to
           FROM events e
           LEFT JOIN agents s ON s.id = e.from_agent_id
           LEFT JOIN agents t ON t.id = e.to_agent_id
           WHERE e.kind = 'dm' AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))
             AND ((e.from_agent_id = ? AND e.to_agent_id = ?) OR (e.from_agent_id = ? AND e.to_agent_id = ?))
           ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
          before,
          before,
          beforeId,
          agent.id,
          other.id,
          other.id,
          agent.id,
          limit,
        )
        .toArray();
    } else {
      rows = this.ctx.storage.sql
        .exec<HistoryRow>(
          `SELECT e.id, e.kind, e.topic, COALESCE(s.handle, '(left)') AS from_handle, t.handle AS to_handle, e.text, e.created_at, e.reply_to
           FROM events e
           LEFT JOIN agents s ON s.id = e.from_agent_id
           LEFT JOIN agents t ON t.id = e.to_agent_id
           WHERE (e.created_at < ? OR (e.created_at = ? AND e.id < ?)) AND (
             e.from_agent_id = ?
             OR e.id IN (SELECT event_id FROM deliveries WHERE agent_id = ?)
           )
           ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
          before,
          before,
          beforeId,
          agent.id,
          agent.id,
          limit,
        )
        .toArray();
    }
    return {
      events: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        topic: row.topic,
        from: row.from_handle,
        to: row.to_handle,
        text: row.text,
        created_at: row.created_at,
        reply_to: row.reply_to,
      })),
    };
  }

  async mintToken(props: ClickProps, input: {
    label?: string | null;
    role?: Role;
    handle?: string;
    name?: string;
  }): Promise<{ token: string; token_id: string; principal_id: string; role: Role; handle: string | null }> {
    this.assertAdmin(props.role);
    const role: Role = "member";
    const label = input.label ?? null;
    const requestedHandle = input.handle ? requireHandle(input.handle) : null;
    if (requestedHandle && this.agentByHandle(requestedHandle)) {
      throw new ClickError(`The handle ${requestedHandle} is taken.`);
    }
    const principalId = crypto.randomUUID();
    const token = randomToken("clk_");
    const tokenHash = await sha256Hex(token);
    const tokenId = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ensurePrincipal(principalId, role, label);
      this.ctx.storage.sql.exec(
        `INSERT INTO api_tokens (id, token_hash, principal_id, role, label, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        tokenId,
        tokenHash,
        principalId,
        role,
        label,
        now,
      );
    });
    let registered: string | null = null;
    if (requestedHandle) {
      const profile = await this.register(
        { principalId, clickId: props.clickId, role },
        { handle: requestedHandle, name: input.name, description: "" },
      );
      registered = profile.agent?.handle ?? null;
    }
    await getDirectory(this.env).rememberToken({
      tokenHash,
      clickId: props.clickId,
      principalId,
      role,
    });
    return { token, token_id: tokenId, principal_id: principalId, role, handle: registered };
  }

  async createInvite(props: ClickProps, label: string | null, expiresInHours?: number): Promise<{
    invite: string;
    id: string;
    click_id: string;
    expires_at: number | null;
    paste_line: string;
  }> {
    this.assertAdmin(props.role);
    this.noteClick(props.clickId);
    const hours = expiresInHours ?? INVITE_DEFAULT_HOURS;
    if (!Number.isFinite(hours) || hours <= 0 || hours > INVITE_MAX_HOURS) {
      throw new ClickError(`expires_in_hours must be between 0 and ${INVITE_MAX_HOURS}.`);
    }
    const open = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
        Date.now(),
      )
      .one().n;
    if (open >= 100) throw new ClickError("This click already has 100 open invites. Revoke some first.");
    const invite = randomToken("clk_inv_");
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = Math.round(now + hours * 3_600_000);
    const tokenHash = await sha256Hex(invite);
    this.ctx.storage.sql.exec(
      `INSERT INTO invites (id, token_hash, label, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      tokenHash,
      label,
      props.principalId,
      now,
      expiresAt,
    );
    await getDirectory(this.env).rememberInvite(tokenHash, props.clickId, expiresAt);
    return { invite, id, click_id: props.clickId, expires_at: expiresAt, paste_line: inviteLine(invite) };
  }

  async listInvites(props: ClickProps, includeClosed = false): Promise<Array<{
    id: string;
    label: string | null;
    status: "open" | "used" | "revoked" | "expired";
    created_at: number;
    expires_at: number | null;
    used_at: number | null;
    used_by: string | null;
  }>> {
    this.assertAdmin(props.role);
    const now = Date.now();
    return this.ctx.storage.sql
      .exec<{ id: string; label: string | null; created_at: number; expires_at: number | null; used_at: number | null; revoked_at: number | null; used_by: string | null }>(
        `SELECT i.id, i.label, i.created_at, i.expires_at, i.used_at, i.revoked_at, a.handle AS used_by
         FROM invites i LEFT JOIN agents a ON a.principal_id = i.used_by
         ORDER BY i.created_at DESC LIMIT 200`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        label: row.label,
        status: row.revoked_at != null
          ? "revoked" as const
          : row.used_at != null
            ? "used" as const
            : row.expires_at != null && row.expires_at <= now
              ? "expired" as const
              : "open" as const,
        created_at: row.created_at,
        expires_at: row.expires_at,
        used_at: row.used_at,
        used_by: row.used_by,
      }))
      .filter((row) => includeClosed || row.status === "open");
  }

  async revokeInvite(props: ClickProps, inviteId: string): Promise<{ id: string; revoked: boolean }> {
    this.assertAdmin(props.role);
    const row = this.ctx.storage.sql
      .exec<{ token_hash: string }>(
        `SELECT token_hash FROM invites WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
        inviteId.trim(),
      )
      .toArray()[0];
    if (!row) return { id: inviteId, revoked: false };
    this.ctx.storage.sql.exec(`UPDATE invites SET revoked_at = ? WHERE id = ?`, Date.now(), inviteId.trim());
    await getDirectory(this.env).revokeInvite(row.token_hash);
    return { id: inviteId, revoked: true };
  }

  async markInviteUsed(tokenHash: string, principalId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL`,
      Date.now(),
      principalId,
      tokenHash,
    );
  }

  async revokeToken(props: ClickProps, tokenId: string): Promise<{ revoked: boolean }> {
    this.assertAdmin(props.role);
    const existing = this.ctx.storage.sql
      .exec<{ token_hash: string }>(`SELECT token_hash FROM api_tokens WHERE id = ? AND revoked_at IS NULL`, tokenId)
      .toArray()[0];
    if (!existing) return { revoked: false };
    this.ctx.storage.sql.exec(`UPDATE api_tokens SET revoked_at = ? WHERE id = ?`, Date.now(), tokenId);
    await getDirectory(this.env).revokeHash(existing.token_hash);
    return { revoked: true };
  }

  async listTokens(props: ClickProps): Promise<Array<{
    id: string;
    principal_id: string;
    role: Role;
    label: string | null;
    handle: string | null;
    created_at: number;
    revoked: boolean;
  }>> {
    this.assertAdmin(props.role);
    return this.ctx.storage.sql
      .exec<{
        id: string;
        principal_id: string;
        role: Role;
        label: string | null;
        handle: string | null;
        created_at: number;
        revoked_at: number | null;
      }>(
        `SELECT t.id, t.principal_id, t.role, t.label, a.handle, t.created_at, t.revoked_at
         FROM api_tokens t
         LEFT JOIN agents a ON a.principal_id = t.principal_id
         ORDER BY t.created_at DESC
         LIMIT 100`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        principal_id: row.principal_id,
        role: row.role,
        label: row.label,
        handle: row.handle,
        created_at: row.created_at,
        revoked: row.revoked_at != null,
      }));
  }

  async deliveryStatus(props: ClickProps, input: { event_id?: string; limit?: number }): Promise<{
    deliveries: Array<{
      id: string;
      event_id: string;
      recipient: string;
      status: string;
      attempts: number;
      next_attempt_at: number | null;
      last_error: string | null;
      acked: boolean;
    }>;
  }> {
    const agent = this.requireAgent(props.principalId);
    const eventId = input.event_id ?? "";
    const deliveries = this.ctx.storage.sql
      .exec<{
        id: string;
        event_id: string;
        recipient: string;
        wake_status: string;
        wake_attempts: number;
        wake_next_at: number | null;
        wake_last_error: string | null;
        acked_at: number | null;
      }>(
        `SELECT d.id, d.event_id, a.handle AS recipient, d.wake_status, d.wake_attempts,
                d.wake_next_at, d.wake_last_error, d.acked_at
         FROM deliveries d
         JOIN events e ON e.id = d.event_id
         JOIN agents a ON a.id = d.agent_id
         WHERE e.from_agent_id = ? AND (? = '' OR e.id = ?)
         ORDER BY d.created_at DESC
         LIMIT ?`,
        agent.id,
        eventId,
        eventId,
        clampLimit(input.limit),
      )
      .toArray();
    return {
      deliveries: deliveries.map((row) => ({
        id: row.id,
        event_id: row.event_id,
        recipient: row.recipient,
        status: row.wake_status,
        attempts: row.wake_attempts,
        next_attempt_at: row.wake_next_at,
        last_error: row.wake_last_error,
        acked: row.acked_at != null,
      })),
    };
  }

  async processWakes(dueAt = Date.now(), clickId?: string): Promise<WakeSummary> {
    if (clickId) this.noteClick(clickId);
    const click = this.clickLabel();
    const summary: WakeSummary = { attempted: 0, delivered: 0, retrying: 0, failed: 0 };
    for (let batch = 0; batch < 5; batch++) {
      const jobs = this.claim(dueAt);
      if (jobs.length === 0) break;
      for (const job of jobs) {
        summary.attempted += 1;
        const outcome = await postDoorbell({ ...job, deliveryId: job.id, clickId: click.id, clickName: click.name });
        const state = this.recordWake(job.id, job.attempts, outcome, Date.now());
        summary[state] += 1;
      }
    }
    await this.scheduleAlarm();
    return summary;
  }

  async alarm(): Promise<void> {
    const summary = await this.processWakes(Date.now());
    if (summary.attempted > 0) {
      console.log(JSON.stringify({ message: "doorbell_alarm", ...summary }));
    }
  }

  private claim(dueAt: number): Array<{ id: string; attempts: number; handle: string; pending: number; url: string; key: string }> {
    return this.ctx.storage.transactionSync(() => {
      const due = this.ctx.storage.sql
        .exec<{
          id: string;
          wake_attempts: number;
          handle: string;
          pending: number;
          webhook_url: string;
          webhook_key: string;
        }>(
          `SELECT d.id, d.wake_attempts, a.handle, a.webhook_url, a.webhook_key,
                  (SELECT COUNT(*) FROM deliveries u WHERE u.agent_id = d.agent_id AND u.acked_at IS NULL) AS pending
           FROM deliveries d
           JOIN agents a ON a.id = d.agent_id
           WHERE a.webhook_url IS NOT NULL AND a.webhook_key IS NOT NULL
             AND (
               (d.wake_status = 'queued' AND d.wake_next_at <= ?)
               OR (d.wake_status = 'inflight' AND d.wake_locked_until <= ?)
             )
           ORDER BY d.created_at
           LIMIT 20`,
          dueAt,
          dueAt,
        )
        .toArray();
      const now = Date.now();
      const jobs = [];
      for (const row of due) {
        const attempts = row.wake_attempts + 1;
        this.ctx.storage.sql.exec(
          `UPDATE deliveries SET wake_status = 'inflight', wake_attempts = ?, wake_locked_until = ?, wake_next_at = NULL WHERE id = ?`,
          attempts,
          now + LOCK_MS,
          row.id,
        );
        jobs.push({
          id: row.id,
          attempts,
          handle: row.handle,
          pending: row.pending,
          url: row.webhook_url,
          key: row.webhook_key,
        });
      }
      return jobs;
    });
  }

  private recordWake(id: string, attempts: number, outcome: WakeOutcome, now: number): "delivered" | "retrying" | "failed" {
    if (outcome.ok) {
      this.ctx.storage.sql.exec(
        `UPDATE deliveries SET wake_status = 'delivered', wake_locked_until = NULL, wake_next_at = NULL, wake_last_error = NULL WHERE id = ?`,
        id,
      );
      return "delivered";
    }
    const delay = retryDelayMs(attempts);
    if (delay == null) {
      this.ctx.storage.sql.exec(
        `UPDATE deliveries SET wake_status = 'failed', wake_locked_until = NULL, wake_next_at = NULL, wake_last_error = ? WHERE id = ?`,
        outcome.error,
        id,
      );
      return "failed";
    }
    this.ctx.storage.sql.exec(
      `UPDATE deliveries SET wake_status = 'queued', wake_locked_until = NULL, wake_next_at = ?, wake_last_error = ? WHERE id = ?`,
      now + delay,
      outcome.error,
      id,
    );
    return "retrying";
  }

  private async scheduleAlarm(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ next: number | null }>(
        `SELECT MIN(t) AS next FROM (
           SELECT wake_next_at AS t FROM deliveries WHERE wake_status = 'queued' AND wake_next_at IS NOT NULL
           UNION ALL
           SELECT wake_locked_until AS t FROM deliveries WHERE wake_status = 'inflight' AND wake_locked_until IS NOT NULL
         )`,
      )
      .toArray()[0];
    if (row?.next == null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const when = Math.max(row.next, Date.now() + 250);
    const existing = await this.ctx.storage.getAlarm();
    if (existing != null && existing <= when) return;
    await this.ctx.storage.setAlarm(when);
  }

  private ensurePrincipal(id: string, role: Role, label: string | null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO principals (id, role, label, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      id,
      role,
      label,
      Date.now(),
    );
  }

  async rememberIssuedToken(input: { token: string; principalId: string; role: Role; label: string | null }): Promise<void> {
    this.ensurePrincipal(input.principalId, input.role, input.label);
    this.ctx.storage.sql.exec(
      `INSERT INTO api_tokens (id, token_hash, principal_id, role, label, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      await sha256Hex(input.token),
      input.principalId,
      input.role,
      input.label,
      Date.now(),
    );
  }

  async showKey(props: ClickProps): Promise<{ click_id: string; click_key: string; email: string }> {
    this.assertAdmin(props.role);
    const meta = this.requireMeta();
    return { click_id: props.clickId, click_key: meta.click_key, email: meta.email };
  }

  async setKey(clickKey: string): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE click_meta SET click_key = ? WHERE id = 1`, clickKey);
  }

  async leave(props: ClickProps): Promise<{ handle: string }> {
    const agent = this.agentByPrincipal(props.principalId);
    if (!agent) throw new ClickError("You have no agent to remove.");
    this.deleteAgent(agent.id, props.principalId);
    await getDirectory(this.env).forgetPrincipal(props.clickId, props.principalId);
    return { handle: agent.handle };
  }

  async removeMember(props: ClickProps, handle: string): Promise<{ handle: string }> {
    this.assertAdmin(props.role);
    const name = requireHandle(handle, "handle");
    const agent = this.agentByHandle(name);
    if (!agent) throw new ClickError(`No agent named ${name}.`);
    if (agent.principal_id === props.principalId) throw new ClickError("Use leave to remove your own agent.");
    const meta = this.requireMeta();
    if (agent.principal_id === meta.admin_principal) throw new ClickError("The click admin cannot be removed. They can leave.");
    this.deleteAgent(agent.id, agent.principal_id);
    await getDirectory(this.env).forgetPrincipal(props.clickId, agent.principal_id);
    return { handle: name };
  }

  async listMembers(): Promise<Array<{ handle: string; name: string; role: string; created_at: number }>> {
    return this.ctx.storage.sql
      .exec<{ handle: string; name: string; role: string; created_at: number }>(
        `SELECT a.handle, a.name, p.role, a.created_at
         FROM agents a JOIN principals p ON p.id = a.principal_id
         ORDER BY a.created_at`,
      )
      .toArray();
  }

  tokenHashesForPrincipal(principalId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ token_hash: string }>(`SELECT token_hash FROM api_tokens WHERE principal_id = ?`, principalId)
      .toArray()
      .map((row) => row.token_hash);
  }

  private deleteAgent(agentId: string, principalId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM subscriptions WHERE agent_id = ?`, agentId);
      this.ctx.storage.sql.exec(`DELETE FROM api_tokens WHERE principal_id = ?`, principalId);
      this.ctx.storage.sql.exec(`DELETE FROM agents WHERE id = ?`, agentId);
    });
  }

  private meta(): { email: string; click_key: string; admin_principal: string } | undefined {
    return this.ctx.storage.sql
      .exec<{ email: string; click_key: string; admin_principal: string }>(
        `SELECT email, click_key, admin_principal FROM click_meta WHERE id = 1`,
      )
      .toArray()[0];
  }

  private requireMeta(): { email: string; click_key: string; admin_principal: string } {
    const meta = this.meta();
    if (!meta) throw new ClickError("This click is not initialized.");
    return meta;
  }

  private assertAdmin(role: Role): void {
    if (role !== "admin" && role !== "operator") throw new ClickError("Only a click admin can do that.");
  }

  private requireAgent(principalId: string): AgentRow {
    const agent = this.agentByPrincipal(principalId);
    if (!agent) throw new ClickError("Register an agent before using the mailbox.");
    return agent;
  }

  private agentByPrincipal(principalId: string): AgentRow | undefined {
    return this.ctx.storage.sql.exec<AgentRow>(`SELECT * FROM agents WHERE principal_id = ?`, principalId).toArray()[0];
  }

  private agentByHandle(handle: string): AgentRow | undefined {
    return this.ctx.storage.sql.exec<AgentRow>(`SELECT * FROM agents WHERE handle = ?`, handle).toArray()[0];
  }

  private subscribers(topic: string): AgentRow[] {
    return this.ctx.storage.sql
      .exec<AgentRow>(
        `SELECT a.* FROM subscriptions s JOIN agents a ON a.id = s.agent_id WHERE s.topic = ?`,
        topic,
      )
      .toArray();
  }

  private optionalWebhook(url: string | undefined, key: string | undefined): { url: string; key: string } | null {
    if (!url && !key) return null;
    if (!url || !key) throw new ClickError("Provide both webhook_url and webhook_key.");
    return { url: parseWebhookUrl(url).toString(), key: requireWebhookKey(key) };
  }
}
