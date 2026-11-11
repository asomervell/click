import { DurableObject } from "cloudflare:workers";
import { randomToken, sha256Hex } from "./crypto";
import { getDirectory } from "./directory";
import { ClickError, type ClickProps, type Profile, type PublicAgent, type Role } from "./types";
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
};

export type WakeSummary = {
  attempted: number;
  delivered: number;
  retrying: number;
  failed: number;
};

const LOCK_MS = 60_000;

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
  }

  async initClick(input: { email: string; clickKey: string; adminId: string }): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO click_meta (id, email, click_key, admin_principal, created_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      input.email,
      input.clickKey,
      input.adminId,
      Date.now(),
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
    const label = this.ctx.storage.sql
      .exec<{ label: string | null }>(`SELECT label FROM principals WHERE id = ?`, props.principalId)
      .toArray()[0]?.label ?? null;
    const agent = this.agentByPrincipal(props.principalId);
    return {
      principal_id: props.principalId,
      click_id: props.clickId,
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
    const from = this.requireAgent(props.principalId);
    const since = Date.now() - 60_000;
    const recent = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE from_agent_id = ? AND created_at > ?`, from.id, since)
      .one().n;
    if (recent >= 30) throw new ClickError("Too many messages in the last minute. Wait and try again.");
    const text = requireText(input.text);
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
        `INSERT INTO events (id, kind, topic, from_agent_id, to_agent_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        kind,
        topic,
        from.id,
        toAgentId,
        text,
        now,
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
    await this.scheduleAlarm();
    return { event_id: eventId, kind, recipients: recipients.map((agent) => agent.handle) };
  }

  async inbox(props: ClickProps, limit: number | undefined): Promise<{
    messages: Array<{
      id: string;
      event_id: string;
      from: string;
      kind: string;
      topic: string | null;
      text: string;
      created_at: number;
    }>;
  }> {
    const agent = this.requireAgent(props.principalId);
    const messages = this.ctx.storage.sql
      .exec<{
        id: string;
        event_id: string;
        from_handle: string;
        kind: string;
        topic: string | null;
        text: string;
        created_at: number;
      }>(
        `SELECT d.id, d.event_id, COALESCE(s.handle, '(left)') AS from_handle, e.kind, e.topic, e.text, e.created_at
         FROM deliveries d
         JOIN events e ON e.id = d.event_id
         LEFT JOIN agents s ON s.id = e.from_agent_id
         WHERE d.agent_id = ? AND d.acked_at IS NULL
         ORDER BY e.created_at ASC
         LIMIT ?`,
        agent.id,
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
      }));
    return { messages };
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
    }>;
  }> {
    const agent = this.requireAgent(props.principalId);
    const limit = clampLimit(input.limit);
    const before = input.before ?? Number.MAX_SAFE_INTEGER;
    type HistoryRow = {
      id: string;
      kind: string;
      topic: string | null;
      from_handle: string;
      to_handle: string | null;
      text: string;
      created_at: number;
    };
    let rows: HistoryRow[];
    if (input.topic?.trim()) {
      const topic = requireHandle(input.topic, "topic");
      rows = this.ctx.storage.sql
        .exec<HistoryRow>(
          `SELECT e.id, e.kind, e.topic, COALESCE(s.handle, '(left)') AS from_handle, t.handle AS to_handle, e.text, e.created_at
           FROM events e
           LEFT JOIN agents s ON s.id = e.from_agent_id
           LEFT JOIN agents t ON t.id = e.to_agent_id
           WHERE e.kind = 'topic' AND e.topic = ? AND e.created_at < ?
           ORDER BY e.created_at DESC LIMIT ?`,
          topic,
          before,
          limit,
        )
        .toArray();
    } else if (input.with?.trim()) {
      const other = this.agentByHandle(requireHandle(input.with, "with"));
      if (!other) throw new ClickError(`No agent named ${input.with.trim().toLowerCase()}.`);
      rows = this.ctx.storage.sql
        .exec<HistoryRow>(
          `SELECT e.id, e.kind, e.topic, COALESCE(s.handle, '(left)') AS from_handle, t.handle AS to_handle, e.text, e.created_at
           FROM events e
           LEFT JOIN agents s ON s.id = e.from_agent_id
           LEFT JOIN agents t ON t.id = e.to_agent_id
           WHERE e.kind = 'dm' AND e.created_at < ?
             AND ((e.from_agent_id = ? AND e.to_agent_id = ?) OR (e.from_agent_id = ? AND e.to_agent_id = ?))
           ORDER BY e.created_at DESC LIMIT ?`,
          before,
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
          `SELECT e.id, e.kind, e.topic, COALESCE(s.handle, '(left)') AS from_handle, t.handle AS to_handle, e.text, e.created_at
           FROM events e
           LEFT JOIN agents s ON s.id = e.from_agent_id
           LEFT JOIN agents t ON t.id = e.to_agent_id
           WHERE e.created_at < ? AND (
             e.from_agent_id = ?
             OR e.id IN (SELECT event_id FROM deliveries WHERE agent_id = ?)
           )
           ORDER BY e.created_at DESC LIMIT ?`,
          before,
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

  async createInvite(props: ClickProps, label: string | null): Promise<{ invite: string; id: string }> {
    this.assertAdmin(props.role);
    const invite = randomToken("clk_inv_");
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO invites (id, token_hash, label, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      await sha256Hex(invite),
      label,
      props.principalId,
      Date.now(),
    );
    await getDirectory(this.env).rememberInvite(await sha256Hex(invite), props.clickId);
    return { invite, id };
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

  async processWakes(dueAt = Date.now()): Promise<WakeSummary> {
    const summary: WakeSummary = { attempted: 0, delivered: 0, retrying: 0, failed: 0 };
    for (let batch = 0; batch < 5; batch++) {
      const jobs = this.claim(dueAt);
      if (jobs.length === 0) break;
      for (const job of jobs) {
        summary.attempted += 1;
        const outcome = await postDoorbell(job);
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
