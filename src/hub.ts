import { DurableObject } from "cloudflare:workers";
import { randomToken, sha256Hex } from "./crypto";
import { getDirectory } from "./directory";
import { ClickError, inviteLine, PRIVATE_SEND_ERROR, type ClickProps, type Profile, type PublicAgent, type Role } from "./types";
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
import { callbackHost, eventBody, eventRetryDelayMs, type EventOutcome, logEvent, postEvent, redactEventBody } from "./events";

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
  /** Private clicks: the body, already encrypted in the Worker. text is then empty. */
  sealed?: SealedBody;
};

/** An encrypted message body. event_id and created_at are bound into the ciphertext. */
export type SealedBody = { epoch: number; ct: string; event_id: string; created_at: number };

/** A credential's public key, registered so members can share the click key with it. */
export type PublicKeyInput = { id: string; pub: string; kind: "cred" | "admin" };

/** Everything the Worker needs to unlock a private click for one credential, in one call. */
export type KeyState = {
  mode: "standard" | "private";
  epoch: number;
  slot: string | null;
  chain: Array<{ epoch: number; wrapped: string }>;
  keys: Array<{ key_id: string; public_key: string; slotted: boolean }>;
  rotate: boolean;
  plaintext: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID = /^[0-9a-f]{32}$/;
const MAX_CT = 16_000;

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
const INVITE_DEFAULT_USES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOLD_MS = 7 * DAY_MS;
const RENAMES_PER_DAY = 3;
const INVITE_MAX_USES = 100;

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
    this.addColumn("invites", "max_uses", "INTEGER");
    this.addColumn("invites", "uses", "INTEGER NOT NULL DEFAULT 0");
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS handle_holds (
      handle TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      until INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS handle_renames (
      agent_id TEXT NOT NULL,
      old_handle TEXT NOT NULL,
      new_handle TEXT NOT NULL,
      at INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS invite_uses (
      invite_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      used_at INTEGER NOT NULL,
      PRIMARY KEY (invite_id, principal_id)
    )`);
    this.addColumn("events", "reply_to", "TEXT");
    // The admin key lives only as a sha256 in the directory. Older clicks kept a plaintext copy here; wipe it.
    this.ctx.storage.sql.exec(`UPDATE click_meta SET click_key = '' WHERE click_key != ''`);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS event_subs (
        id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS event_deliveries (
        id TEXT PRIMARY KEY,
        sub_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER,
        locked_until INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_deliveries_due ON event_deliveries (status, next_at);
    `);
    // Event payloads no longer carry message text. Strip it from any queued rows written before that.
    this.stripQueuedEventText();
    // Private clicks (opt-in): encrypted bodies, member key slots, and the chain of older keys.
    this.addColumn("click_meta", "enc_mode", "TEXT NOT NULL DEFAULT 'standard'");
    this.addColumn("click_meta", "enc_epoch", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("click_meta", "enc_rotate", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("events", "enc", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("events", "key_epoch", "INTEGER");
    this.addColumn("events", "body_ct", "TEXT");
    this.addColumn("invites", "key_wrap", "TEXT");
    this.addColumn("invites", "key_epoch", "INTEGER");
    this.addColumn("principals", "removed_at", "INTEGER");
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS member_keys (
        key_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        public_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS key_slots (
        epoch INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        wrapped TEXT NOT NULL,
        PRIMARY KEY (epoch, key_id)
      );
      CREATE TABLE IF NOT EXISTS epoch_keys (
        epoch INTEGER PRIMARY KEY,
        wrapped TEXT NOT NULL
      );
    `);
  }

  private stripQueuedEventText(): void {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; body: string }>(`SELECT id, body FROM event_deliveries WHERE body LIKE '%"text"%'`)
      .toArray();
    for (const row of rows) {
      const next = redactEventBody(row.body);
      if (next !== row.body) this.ctx.storage.sql.exec(`UPDATE event_deliveries SET body = ? WHERE id = ?`, next, row.id);
    }
  }

  /** Store or refresh an MCP Events subscription for this agent. */
  async eventSubscribe(props: ClickProps, input: { id: string; url: string; secret: string; expiresAt: number }): Promise<void> {
    this.noteClick(props.clickId);
    const agent = this.requireAgent(props.principalId);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO event_subs (id, agent_id, url, secret, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id, agent_id) DO UPDATE SET url = excluded.url, secret = excluded.secret, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      input.id, agent.id, input.url, input.secret, input.expiresAt, now, now,
    );
  }

  async eventUnsubscribe(props: ClickProps, id: string): Promise<void> {
    const agent = this.agentByPrincipal(props.principalId);
    if (!agent) return;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM event_subs WHERE id = ? AND agent_id = ?`, id, agent.id);
      this.ctx.storage.sql.exec(`DELETE FROM event_deliveries WHERE sub_id = ? AND agent_id = ? AND status IN ('queued', 'inflight')`, id, agent.id);
    });
  }

  /** Active subscriptions for this agent, for whoami and tests. Secrets are never returned. */
  async eventSubscriptions(props: ClickProps): Promise<Array<{ id: string; url: string; expires_at: number }>> {
    const agent = this.requireAgent(props.principalId);
    return this.ctx.storage.sql
      .exec<{ id: string; url: string; expires_at: number }>(`SELECT id, url, expires_at FROM event_subs WHERE agent_id = ? AND expires_at > ?`, agent.id, Date.now())
      .toArray();
  }

  private addColumn(table: string, column: string, type: string): void {
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
      .toArray()
      .map((row) => row.name);
    if (!columns.includes(column)) this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private knownClickId: string | null = null;

  /**
   * The cheap check behind wait_for_message: does this agent have anything unread? The worker
   * polls it with backoff, so no request is held open inside this object while an agent waits.
   */
  async hasUnread(props: ClickProps): Promise<boolean> {
    const agent = this.requireAgent(props.principalId);
    return this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT EXISTS(SELECT 1 FROM deliveries WHERE agent_id = ? AND acked_at IS NULL) AS n`, agent.id)
      .one().n === 1;
  }

  /**
   * Legacy blocking wait, kept only so a worker isolate still running the previous build
   * during a deploy keeps working. New code calls hasUnread from the worker instead.
   */
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

  async initClick(input: { email: string; adminId: string; clickId?: string; name?: string | null }): Promise<void> {
    // click_key stays empty: the admin key is never stored in plaintext, only as a hash in the directory.
    this.ctx.storage.sql.exec(
      `INSERT INTO click_meta (id, email, click_key, admin_principal, created_at, click_id, name) VALUES (1, ?, '', ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      input.email,
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
        throw new ClickError(`Click conflict: this connection is already registered as ${existing.handle}. Use update_profile.`);
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
    if (this.handleHeld(handle, null)) throw new ClickError(`The handle ${handle} is taken.`);
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

  async send(props: ClickProps, input: SendInput, key?: PublicKeyInput | null): Promise<{
    event_id: string;
    kind: "dm" | "topic" | "broadcast";
    recipients: string[];
  }> {
    if (key) this.rememberKey(props.principalId, key);
    return this.sendInternal(props, input, false);
  }

  private async sendInternal(props: ClickProps, input: SendInput, system: boolean): Promise<{
    event_id: string;
    kind: "dm" | "topic" | "broadcast";
    recipients: string[];
  }> {
    this.noteClick(props.clickId);
    const from = this.requireAgent(props.principalId);
    const enc = this.encMeta();
    let sealed: SealedBody | null = null;
    if (input.sealed) {
      sealed = this.checkSealed(input.sealed, enc.epoch);
    } else if (enc.mode === "private" && !system) {
      throw new ClickError(PRIVATE_SEND_ERROR);
    }
    const since = Date.now() - 60_000;
    const recent = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE from_agent_id = ? AND created_at > ?`, from.id, since)
      .one().n;
    if (recent >= 30) throw new ClickError("Too many messages in the last minute. Wait and try again.");
    const text = sealed ? "" : requireText(input.text);
    const replyTo = input.reply_to ? this.locateRow(from.id, input.reply_to)?.event_id ?? null : null;
    const chosen = [input.to?.trim(), input.topic?.trim(), input.broadcast ? "broadcast" : ""].filter(Boolean);
    if (chosen.length !== 1) throw new ClickError("Set exactly one of to, topic, or broadcast.");
    const now = sealed ? sealed.created_at : Date.now();
    const eventId = sealed ? sealed.event_id : crypto.randomUUID();
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

    const deliveryIds = new Map<string, string>();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO events (id, kind, topic, from_agent_id, to_agent_id, text, created_at, reply_to, enc, key_epoch, body_ct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        kind,
        topic,
        from.id,
        toAgentId,
        text,
        now,
        replyTo,
        sealed ? 1 : 0,
        sealed?.epoch ?? null,
        sealed?.ct ?? null,
      );
      for (const recipient of recipients) {
        const wake = Boolean(recipient.webhook_url && recipient.webhook_key);
        const deliveryId = crypto.randomUUID();
        deliveryIds.set(recipient.id, deliveryId);
        this.ctx.storage.sql.exec(
          `INSERT INTO deliveries (id, event_id, agent_id, created_at, wake_status, wake_attempts, wake_next_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
          deliveryId,
          eventId,
          recipient.id,
          now,
          wake ? "queued" : "none",
          wake ? 0 : null,
        );
      }
    });
    this.wakeWaiters(recipients.map((agent) => agent.id));
    this.queueEvents(recipients, deliveryIds, { from: from.handle, kind, topic, replyTo, createdAt: now, clickId: props.clickId });
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
    key?: PublicKeyInput | null;
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
      sealed?: { epoch: number; ct: string };
    }>;
  }> {
    if (options.key) this.rememberKey(props.principalId, options.key);
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
        enc: number;
        key_epoch: number | null;
        body_ct: string | null;
      }>(
        `SELECT d.id, d.event_id, COALESCE(s.handle, '(left)') AS from_handle, e.kind, e.topic, e.text, e.created_at, e.reply_to, e.enc, e.key_epoch, e.body_ct
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
        ...sealedOf(row),
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
    key?: PublicKeyInput | null;
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
      sealed?: { epoch: number; ct: string };
    }>;
  }> {
    if (input.key) this.rememberKey(props.principalId, input.key);
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
      enc: number;
      key_epoch: number | null;
      body_ct: string | null;
    };
    let rows: HistoryRow[];
    if (input.topic?.trim()) {
      const topic = requireHandle(input.topic, "topic");
      rows = this.ctx.storage.sql
        .exec<HistoryRow>(
          `SELECT e.id, e.kind, e.topic, COALESCE(s.handle, '(left)') AS from_handle, t.handle AS to_handle, e.text, e.created_at, e.reply_to, e.enc, e.key_epoch, e.body_ct
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
          `SELECT e.id, e.kind, e.topic, COALESCE(s.handle, '(left)') AS from_handle, t.handle AS to_handle, e.text, e.created_at, e.reply_to, e.enc, e.key_epoch, e.body_ct
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
          `SELECT e.id, e.kind, e.topic, COALESCE(s.handle, '(left)') AS from_handle, t.handle AS to_handle, e.text, e.created_at, e.reply_to, e.enc, e.key_epoch, e.body_ct
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
        ...sealedOf(row),
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
    if (requestedHandle && this.handleHeld(requestedHandle, null)) {
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

  async createInvite(props: ClickProps, label: string | null, expiresInHours?: number, maxUses?: number): Promise<{
    invite: string;
    id: string;
    click_id: string;
    expires_at: number | null;
    max_uses: number;
    paste_line: string;
  }> {
    this.assertAdmin(props.role);
    this.noteClick(props.clickId);
    const hours = expiresInHours ?? INVITE_DEFAULT_HOURS;
    if (!Number.isFinite(hours) || hours <= 0 || hours > INVITE_MAX_HOURS) {
      throw new ClickError(`expires_in_hours must be between 0 and ${INVITE_MAX_HOURS}.`);
    }
    const uses = maxUses ?? INVITE_DEFAULT_USES;
    if (!Number.isInteger(uses) || uses < 1 || uses > INVITE_MAX_USES) {
      throw new ClickError(`max_uses must be a whole number from 1 to ${INVITE_MAX_USES}.`);
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
      `INSERT INTO invites (id, token_hash, label, created_by, created_at, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      id,
      tokenHash,
      label,
      props.principalId,
      now,
      expiresAt,
      uses,
    );
    await getDirectory(this.env).rememberInvite(tokenHash, props.clickId, expiresAt, uses);
    return { invite, id, click_id: props.clickId, expires_at: expiresAt, max_uses: uses, paste_line: inviteLine(invite) };
  }

  async listInvites(props: ClickProps, includeClosed = false): Promise<Array<{
    id: string;
    label: string | null;
    status: "open" | "used up" | "revoked" | "expired";
    created_at: number;
    expires_at: number | null;
    max_uses: number;
    uses: number;
    uses_left: number;
    joined: string[];
  }>> {
    this.assertAdmin(props.role);
    const now = Date.now();
    const joinedBy = new Map<string, string[]>();
    for (const row of this.ctx.storage.sql
      .exec<{ invite_id: string; handle: string | null }>(
        `SELECT u.invite_id, a.handle FROM invite_uses u LEFT JOIN agents a ON a.principal_id = u.principal_id ORDER BY u.used_at`,
      )
      .toArray()) {
      const list = joinedBy.get(row.invite_id) ?? [];
      list.push(row.handle ?? "(not registered yet)");
      joinedBy.set(row.invite_id, list);
    }
    return this.ctx.storage.sql
      .exec<{ id: string; label: string | null; created_at: number; expires_at: number | null; used_at: number | null; revoked_at: number | null; used_by: string | null; max_uses: number | null; uses: number }>(
        `SELECT i.id, i.label, i.created_at, i.expires_at, i.used_at, i.revoked_at, a.handle AS used_by, i.max_uses, i.uses
         FROM invites i LEFT JOIN agents a ON a.principal_id = i.used_by
         ORDER BY i.created_at DESC LIMIT 200`,
      )
      .toArray()
      .map((row) => {
        const max = row.max_uses ?? 1;
        // Rows from before reusable invites count a use through used_at only.
        const uses = row.max_uses == null ? (row.used_at != null ? 1 : 0) : row.uses;
        const joined = joinedBy.get(row.id) ?? (row.used_by ? [row.used_by] : []);
        return {
          id: row.id,
          label: row.label,
          status: row.revoked_at != null
            ? "revoked" as const
            : uses >= max
              ? "used up" as const
              : row.expires_at != null && row.expires_at <= now
                ? "expired" as const
                : "open" as const,
          created_at: row.created_at,
          expires_at: row.expires_at,
          max_uses: max,
          uses,
          uses_left: Math.max(0, max - uses),
          joined,
        };
      })
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
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const invite = this.ctx.storage.sql
        .exec<{ id: string }>(
          `UPDATE invites SET uses = uses + 1, used_by = ?,
             used_at = CASE WHEN uses + 1 >= COALESCE(max_uses, 1) THEN ? ELSE NULL END
           WHERE token_hash = ? AND used_at IS NULL RETURNING id`,
          principalId,
          now,
          tokenHash,
        )
        .toArray()[0];
      if (invite) this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO invite_uses (invite_id, principal_id, used_at) VALUES (?, ?, ?)`, invite.id, principalId, now);
    });
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

  private queueEvents(
    recipients: AgentRow[],
    deliveryIds: Map<string, string>,
    message: { from: string; kind: string; topic: string | null; replyTo: string | null; createdAt: number; clickId: string },
  ): void {
    if (recipients.length === 0) return;
    const now = Date.now();
    const subs = this.ctx.storage.sql
      .exec<{ id: string; agent_id: string }>(`SELECT id, agent_id FROM event_subs WHERE expires_at > ?`, now)
      .toArray()
      .filter((sub) => deliveryIds.has(sub.agent_id));
    if (subs.length === 0) return;
    const click = this.clickLabel();
    const byId = new Map(recipients.map((agent) => [agent.id, agent]));
    this.ctx.storage.transactionSync(() => {
      for (const sub of subs) {
        const eventId = `evt_${crypto.randomUUID().replaceAll("-", "")}`;
        const body = eventBody({
          eventId,
          click: click.id ?? message.clickId,
          clickName: click.name,
          messageId: deliveryIds.get(sub.agent_id)!,
          from: message.from,
          to: byId.get(sub.agent_id)?.handle ?? "",
          kind: message.kind,
          topic: message.topic,
          replyTo: message.replyTo,
          createdAt: message.createdAt,
        });
        this.ctx.storage.sql.exec(
          `INSERT INTO event_deliveries (id, sub_id, agent_id, body, status, attempts, next_at, created_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`,
          eventId, sub.id, sub.agent_id, body, now, now,
        );
      }
    });
  }

  private claimEvents(dueAt: number): Array<{ id: string; attempts: number; subId: string; agentId: string; url: string; secret: string; body: string }> {
    return this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql
        .exec<{ id: string; attempts: number; sub_id: string; agent_id: string; url: string; secret: string; body: string }>(
          `SELECT d.id, d.attempts, d.sub_id, d.agent_id, s.url, s.secret, d.body
           FROM event_deliveries d JOIN event_subs s ON s.id = d.sub_id AND s.agent_id = d.agent_id
           WHERE s.expires_at > ? AND ((d.status = 'queued' AND d.next_at <= ?) OR (d.status = 'inflight' AND d.locked_until <= ?))
           ORDER BY d.created_at LIMIT 20`,
          Date.now(), dueAt, dueAt,
        )
        .toArray();
      const now = Date.now();
      for (const row of rows) {
        this.ctx.storage.sql.exec(
          `UPDATE event_deliveries SET status = 'inflight', attempts = ?, locked_until = ?, next_at = NULL WHERE id = ?`,
          row.attempts + 1, now + LOCK_MS, row.id,
        );
      }
      return rows.map((row) => ({ id: row.id, attempts: row.attempts + 1, subId: row.sub_id, agentId: row.agent_id, url: row.url, secret: row.secret, body: row.body }));
    });
  }

  private recordEvent(job: { id: string; attempts: number; subId: string; agentId: string }, outcome: EventOutcome): "delivered" | "retrying" | "failed" {
    const sql = this.ctx.storage.sql;
    if (outcome.ok) {
      sql.exec(`UPDATE event_deliveries SET status = 'delivered', locked_until = NULL, last_error = NULL WHERE id = ?`, job.id);
      return "delivered";
    }
    if (outcome.final === "gone") {
      // 410: the receiver dropped the subscription. Stop it here too.
      sql.exec(`DELETE FROM event_subs WHERE id = ? AND agent_id = ?`, job.subId, job.agentId);
      sql.exec(`UPDATE event_deliveries SET status = 'failed', locked_until = NULL, last_error = ? WHERE sub_id = ? AND agent_id = ? AND status IN ('queued', 'inflight')`, outcome.error, job.subId, job.agentId);
      return "failed";
    }
    const delay = outcome.final ? null : eventRetryDelayMs(job.attempts);
    if (delay == null) {
      sql.exec(`UPDATE event_deliveries SET status = 'failed', locked_until = NULL, last_error = ? WHERE id = ?`, outcome.error, job.id);
      return "failed";
    }
    sql.exec(`UPDATE event_deliveries SET status = 'queued', locked_until = NULL, next_at = ?, last_error = ? WHERE id = ?`, Date.now() + delay, outcome.error, job.id);
    return "retrying";
  }

  /** Event delivery state for tests and operators: no bodies or secrets. */
  async eventDeliveryStates(): Promise<Array<{ id: string; status: string; attempts: number; last_error: string | null }>> {
    return this.ctx.storage.sql
      .exec<{ id: string; status: string; attempts: number; last_error: string | null }>(`SELECT id, status, attempts, last_error FROM event_deliveries ORDER BY created_at`)
      .toArray();
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
    for (let batch = 0; batch < 5; batch++) {
      const jobs = this.claimEvents(dueAt);
      if (jobs.length === 0) break;
      for (const job of jobs) {
        summary.attempted += 1;
        const outcome = await postEvent({ url: job.url, secret: job.secret, eventId: job.id, subId: job.subId, body: job.body });
        const state = this.recordEvent(job, outcome);
        summary[state] += 1;
        logEvent("deliver", {
          sub: job.subId,
          event: job.id,
          host: callbackHost(job.url),
          click: click.id,
          attempt: job.attempts,
          ok: outcome.ok,
          state,
          ...(outcome.ok ? {} : { error: outcome.error }),
        });
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
           UNION ALL
           SELECT next_at AS t FROM event_deliveries WHERE status = 'queued' AND next_at IS NOT NULL
           UNION ALL
           SELECT locked_until AS t FROM event_deliveries WHERE status = 'inflight' AND locked_until IS NOT NULL
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
      this.ctx.storage.sql.exec(`DELETE FROM event_subs WHERE agent_id = ?`, agentId);
      this.ctx.storage.sql.exec(`DELETE FROM event_deliveries WHERE agent_id = ?`, agentId);
      // Private clicks: the removed member's keys and slots go now, and the click key is
      // replaced on the next member request (older keys stay readable through the chain).
      this.ctx.storage.sql.exec(`DELETE FROM key_slots WHERE key_id IN (SELECT key_id FROM member_keys WHERE principal_id = ? AND kind = 'cred')`, principalId);
      const dropped = this.ctx.storage.sql.exec(`DELETE FROM member_keys WHERE principal_id = ? AND kind = 'cred'`, principalId).rowsWritten;
      // The admin principal keeps its admin-key recovery copy, so the admin key can still recover the click.
      if (principalId !== this.meta()?.admin_principal) {
        this.ctx.storage.sql.exec(`UPDATE principals SET removed_at = ? WHERE id = ?`, Date.now(), principalId);
      }
      if (dropped > 0) this.ctx.storage.sql.exec(`UPDATE click_meta SET enc_rotate = 1 WHERE id = 1 AND enc_epoch > 0`);
    });
  }

  private meta(): { email: string; admin_principal: string } | undefined {
    return this.ctx.storage.sql
      .exec<{ email: string; admin_principal: string }>(
        `SELECT email, admin_principal FROM click_meta WHERE id = 1`,
      )
      .toArray()[0];
  }

  private requireMeta(): { email: string; admin_principal: string } {
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

  /** Taken by another agent here, or held for 7 days by an agent that renamed away from it. */
  private handleHeld(handle: string, selfAgentId: string | null): boolean {
    const owner = this.agentByHandle(handle);
    if (owner && owner.id !== selfAgentId) return true;
    const hold = this.ctx.storage.sql
      .exec<{ agent_id: string }>(`SELECT agent_id FROM handle_holds WHERE handle = ? AND until > ?`, handle, Date.now())
      .toArray()[0];
    return Boolean(hold && hold.agent_id !== selfAgentId);
  }

  async handleAvailable(props: ClickProps, handle: string): Promise<boolean> {
    const agent = this.agentByPrincipal(props.principalId);
    return !this.handleHeld(requireHandle(handle), agent?.id ?? null);
  }

  /**
   * Rename this agent. Its id, messages, subscriptions, and membership stay; the old handle is
   * held for it for 7 days so nobody can take it to impersonate; everyone else in the click gets
   * a note. At most 3 renames a day unless the caller already enforced a global limit.
   */
  async renameAgent(props: ClickProps, rawHandle: string, options: { skipLimit?: boolean } = {}): Promise<{ old_handle: string; handle: string; click_id: string; click_name: string | null }> {
    this.noteClick(props.clickId);
    const agent = this.requireAgent(props.principalId);
    const handle = requireHandle(rawHandle.trim().replace(/^@/, ""));
    const click = this.clickLabel();
    if (handle === agent.handle) return { old_handle: agent.handle, handle, click_id: props.clickId, click_name: click.name };
    if (this.handleHeld(handle, agent.id)) throw new ClickError(`The handle ${handle} is taken in this click.`);
    const now = Date.now();
    if (!options.skipLimit) {
      const recent = this.ctx.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM handle_renames WHERE agent_id = ? AND at > ?`, agent.id, now - DAY_MS)
        .one().n;
      if (recent >= RENAMES_PER_DAY) throw new ClickError(`Too many renames: at most ${RENAMES_PER_DAY} a day. Try again tomorrow.`);
    }
    const old = agent.handle;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`UPDATE agents SET handle = ?, name = CASE WHEN name = ? THEN ? ELSE name END, updated_at = ? WHERE id = ?`, handle, old, handle, now, agent.id);
      this.ctx.storage.sql.exec(`DELETE FROM handle_holds WHERE handle = ?`, handle);
      this.ctx.storage.sql.exec(
        `INSERT INTO handle_holds (handle, agent_id, until) VALUES (?, ?, ?) ON CONFLICT (handle) DO UPDATE SET agent_id = excluded.agent_id, until = excluded.until`,
        old, agent.id, now + HOLD_MS,
      );
      this.ctx.storage.sql.exec(`INSERT INTO handle_renames (agent_id, old_handle, new_handle, at) VALUES (?, ?, ?, ?)`, agent.id, old, handle, now);
    });
    const others = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM agents WHERE id != ?`, agent.id).one().n;
    if (others > 0) {
      await this.sendInternal(props, { broadcast: true, text: `Click note: @${old} is now @${handle}. Same agent, same history; message it as @${handle}.` }, true);
    }
    return { old_handle: old, handle, click_id: props.clickId, click_name: click.name };
  }

  // ---------------------------------------------------------------------------
  // Private clicks. The hub never sees a click key or plaintext of an encrypted body:
  // it stores ciphertext, public keys, and data keys wrapped to those public keys.

  private encMeta(): { mode: "standard" | "private"; epoch: number; rotate: boolean } {
    const row = this.ctx.storage.sql
      .exec<{ enc_mode: string; enc_epoch: number; enc_rotate: number }>(`SELECT enc_mode, enc_epoch, enc_rotate FROM click_meta WHERE id = 1`)
      .toArray()[0];
    return { mode: row?.enc_mode === "private" ? "private" : "standard", epoch: row?.enc_epoch ?? 0, rotate: (row?.enc_rotate ?? 0) === 1 };
  }

  private checkSealed(sealed: SealedBody, epoch: number): SealedBody {
    if (epoch === 0 || sealed.epoch !== epoch) throw new ClickError("This click's key changed. Try again.");
    if (typeof sealed.ct !== "string" || !sealed.ct.startsWith("v1.") || sealed.ct.length > MAX_CT) throw new ClickError("That encrypted message is not valid.");
    if (!UUID.test(sealed.event_id)) throw new ClickError("That encrypted message is not valid.");
    if (!Number.isInteger(sealed.created_at) || Math.abs(sealed.created_at - Date.now()) > 120_000) throw new ClickError("That encrypted message is not valid.");
    const clash = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE id = ?`, sealed.event_id).one().n;
    if (clash > 0) throw new ClickError("That encrypted message is not valid.");
    return sealed;
  }

  /** Register a credential's public key for a live member. Keys of removed members are refused. */
  private rememberKey(principalId: string, key: PublicKeyInput): boolean {
    if (!KEY_ID.test(key.id) || typeof key.pub !== "string" || key.pub.length < 40 || key.pub.length > 64) return false;
    const principal = this.ctx.storage.sql
      .exec<{ removed_at: number | null }>(`SELECT removed_at FROM principals WHERE id = ?`, principalId)
      .toArray()[0];
    if (!principal || principal.removed_at != null) return false;
    const kind = key.kind === "admin" ? "admin" : "cred";
    if (kind === "admin" && principalId !== this.meta()?.admin_principal) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO member_keys (key_id, principal_id, kind, public_key, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key_id) DO NOTHING`,
      key.id, principalId, kind, key.pub, Date.now(),
    );
    return true;
  }

  /** Cheap: whether sends here must be encrypted. */
  async encMode(): Promise<{ mode: "standard" | "private"; epoch: number }> {
    const meta = this.encMeta();
    return { mode: meta.mode, epoch: meta.epoch };
  }

  /** Register the caller's key (if given) and return what it needs to unlock and maintain this click's keys. */
  async keyState(props: ClickProps, key: PublicKeyInput | null): Promise<KeyState> {
    if (key) this.rememberKey(props.principalId, key);
    const meta = this.encMeta();
    const slot = key && meta.epoch > 0
      ? this.ctx.storage.sql
        .exec<{ wrapped: string }>(
          `SELECT s.wrapped FROM key_slots s JOIN member_keys k ON k.key_id = s.key_id WHERE s.epoch = ? AND s.key_id = ? AND k.principal_id = ?`,
          meta.epoch, key.id, props.principalId,
        )
        .toArray()[0]?.wrapped ?? null
      : null;
    const chain = slot
      ? this.ctx.storage.sql.exec<{ epoch: number; wrapped: string }>(`SELECT epoch, wrapped FROM epoch_keys ORDER BY epoch`).toArray()
      : [];
    const keys = meta.epoch > 0 && slot
      ? this.ctx.storage.sql
        .exec<{ key_id: string; public_key: string; slotted: number }>(
          `SELECT k.key_id, k.public_key, (s.key_id IS NOT NULL) AS slotted
           FROM member_keys k
           JOIN principals p ON p.id = k.principal_id AND p.removed_at IS NULL
           LEFT JOIN key_slots s ON s.key_id = k.key_id AND s.epoch = ?`,
          meta.epoch,
        )
        .toArray()
        .map((row) => ({ key_id: row.key_id, public_key: row.public_key, slotted: row.slotted === 1 }))
      : [];
    const plaintext = meta.mode === "private" && slot
      ? this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE enc = 0`).one().n
      : 0;
    return { mode: meta.mode, epoch: meta.epoch, slot, chain, keys, rotate: meta.rotate, plaintext };
  }

  /** Public keys of every live member, for turning encryption on or starting fresh. Admin only. */
  async memberKeys(props: ClickProps, key: PublicKeyInput | null): Promise<Array<{ key_id: string; public_key: string }>> {
    this.assertAdmin(props.role);
    if (key) this.rememberKey(props.principalId, key);
    return this.ctx.storage.sql
      .exec<{ key_id: string; public_key: string }>(
        `SELECT k.key_id, k.public_key FROM member_keys k JOIN principals p ON p.id = k.principal_id AND p.removed_at IS NULL`,
      )
      .toArray();
  }

  /** Register a key for another principal of this click (the Worker hands keys over at join, mint, and admin-key sign-in). */
  async registerKeyFor(principalId: string, key: PublicKeyInput): Promise<boolean> {
    return this.rememberKey(principalId, key);
  }

  /** The caller must hold a slot for the current epoch to change keys. */
  private requireSlot(principalId: string, keyId: string, epoch: number): void {
    const row = this.ctx.storage.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM key_slots s JOIN member_keys k ON k.key_id = s.key_id WHERE s.epoch = ? AND s.key_id = ? AND k.principal_id = ?`,
        epoch, keyId, principalId,
      )
      .one().n;
    if (row === 0) throw new ClickError("This connection has no key for this click.");
  }

  private insertSlots(epoch: number, slots: Array<{ key_id: string; wrapped: string }>): number {
    let n = 0;
    for (const slot of slots) {
      if (!KEY_ID.test(slot.key_id) || typeof slot.wrapped !== "string" || !slot.wrapped.startsWith("x1.") || slot.wrapped.length > 1000) continue;
      const known = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM member_keys WHERE key_id = ?`, slot.key_id).one().n;
      if (known === 0) continue;
      this.ctx.storage.sql.exec(`INSERT INTO key_slots (epoch, key_id, wrapped) VALUES (?, ?, ?) ON CONFLICT (epoch, key_id) DO NOTHING`, epoch, slot.key_id, slot.wrapped);
      n += 1;
    }
    return n;
  }

  /** Add slots for keys that lack one at the current epoch. The caller must already hold one. */
  async shareKeys(props: ClickProps, input: { key_id: string; epoch: number; slots: Array<{ key_id: string; wrapped: string }> }): Promise<{ shared: number }> {
    const meta = this.encMeta();
    if (input.epoch !== meta.epoch) return { shared: 0 };
    this.requireSlot(props.principalId, input.key_id, meta.epoch);
    return { shared: this.insertSlots(meta.epoch, input.slots) };
  }

  /**
   * Move to a new click key. First turn-on (epoch 0 to 1) is admin only; later rotations
   * (after a member leaves) need a slot at the current epoch. chain holds every older key
   * sealed under the new one, so history stays readable.
   */
  async newEpoch(props: ClickProps, input: {
    key_id: string;
    epoch: number;
    slots: Array<{ key_id: string; wrapped: string }>;
    chain: Array<{ epoch: number; wrapped: string }>;
    mode?: "private";
  }): Promise<{ epoch: number }> {
    const meta = this.encMeta();
    if (input.epoch !== meta.epoch + 1) throw new ClickError("This click's key changed. Try again.");
    if (meta.epoch === 0 || input.mode) this.assertAdmin(props.role);
    if (meta.epoch > 0) this.requireSlot(props.principalId, input.key_id, meta.epoch);
    if (input.chain.length > 10_000) throw new ClickError("Too many keys.");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM epoch_keys`);
      for (const entry of input.chain) {
        if (!Number.isInteger(entry.epoch) || entry.epoch < 1 || entry.epoch >= input.epoch || !entry.wrapped.startsWith("v1.")) continue;
        this.ctx.storage.sql.exec(`INSERT INTO epoch_keys (epoch, wrapped) VALUES (?, ?)`, entry.epoch, entry.wrapped);
      }
      this.ctx.storage.sql.exec(`DELETE FROM key_slots`);
      this.ctx.storage.sql.exec(`UPDATE invites SET key_wrap = NULL, key_epoch = NULL`);
      this.insertSlots(input.epoch, input.slots);
      this.ctx.storage.sql.exec(
        `UPDATE click_meta SET enc_epoch = ?, enc_rotate = 0${input.mode ? ", enc_mode = 'private'" : ""} WHERE id = 1`,
        input.epoch,
      );
    });
    return { epoch: input.epoch };
  }

  /** Admin: turn encryption of new messages on or off. Off keeps existing keys so encrypted history stays readable. */
  async setEncMode(props: ClickProps, mode: "standard" | "private"): Promise<{ mode: "standard" | "private"; epoch: number }> {
    this.assertAdmin(props.role);
    const meta = this.encMeta();
    if (mode === "private" && meta.epoch === 0) throw new ClickError("This click has no key yet.");
    this.ctx.storage.sql.exec(`UPDATE click_meta SET enc_mode = ? WHERE id = 1`, mode);
    return { mode, epoch: meta.epoch };
  }

  /** Plaintext messages left to encrypt after turning encryption on. */
  async plaintextBatch(props: ClickProps, limit: number): Promise<Array<{ id: string; text: string; created_at: number }>> {
    const meta = this.encMeta();
    if (meta.mode !== "private") return [];
    if (!this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM principals WHERE id = ? AND removed_at IS NULL`, props.principalId).one().n) return [];
    return this.ctx.storage.sql
      .exec<{ id: string; text: string; created_at: number }>(`SELECT id, text, created_at FROM events WHERE enc = 0 ORDER BY created_at LIMIT ?`, Math.min(Math.max(1, limit), 500))
      .toArray();
  }

  async replaceWithCiphertext(props: ClickProps, input: { key_id: string; epoch: number; rows: Array<{ id: string; ct: string }> }): Promise<{ replaced: number }> {
    const meta = this.encMeta();
    if (meta.mode !== "private" || input.epoch !== meta.epoch) return { replaced: 0 };
    this.requireSlot(props.principalId, input.key_id, meta.epoch);
    let replaced = 0;
    this.ctx.storage.transactionSync(() => {
      for (const row of input.rows) {
        if (typeof row.ct !== "string" || !row.ct.startsWith("v1.") || row.ct.length > MAX_CT) continue;
        replaced += this.ctx.storage.sql.exec(
          `UPDATE events SET enc = 1, key_epoch = ?, body_ct = ?, text = '' WHERE id = ? AND enc = 0`,
          meta.epoch, row.ct, row.id,
        ).rowsWritten > 0 ? 1 : 0;
      }
    });
    return { replaced };
  }

  /**
   * Admin: give up on history nobody can decrypt. Deletes every encrypted message and all
   * key material, then installs a new key for the members whose keys are known.
   */
  async startFresh(props: ClickProps, input: { epoch: number; slots: Array<{ key_id: string; wrapped: string }> }): Promise<{ deleted_messages: number; epoch: number }> {
    this.assertAdmin(props.role);
    const meta = this.encMeta();
    if (input.epoch <= meta.epoch) throw new ClickError("This click's key changed. Try again.");
    let deleted = 0;
    this.ctx.storage.transactionSync(() => {
      deleted = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE enc = 1`).one().n;
      this.ctx.storage.sql.exec(`DELETE FROM deliveries WHERE event_id IN (SELECT id FROM events WHERE enc = 1)`);
      this.ctx.storage.sql.exec(`DELETE FROM events WHERE enc = 1`);
      this.ctx.storage.sql.exec(`DELETE FROM epoch_keys`);
      this.ctx.storage.sql.exec(`DELETE FROM key_slots`);
      this.ctx.storage.sql.exec(`UPDATE invites SET key_wrap = NULL, key_epoch = NULL`);
      this.insertSlots(input.epoch, input.slots);
      this.ctx.storage.sql.exec(`UPDATE click_meta SET enc_epoch = ?, enc_rotate = 0, enc_mode = 'private' WHERE id = 1`, input.epoch);
    });
    return { deleted_messages: deleted, epoch: input.epoch };
  }

  /** Attach the click key, wrapped under the invite secret, to an invite. */
  async setInviteKey(props: ClickProps, inviteId: string, input: { key_id: string; epoch: number; wrapped: string }): Promise<void> {
    this.assertAdmin(props.role);
    const meta = this.encMeta();
    if (input.epoch !== meta.epoch || !input.wrapped.startsWith("v1.")) return;
    this.requireSlot(props.principalId, input.key_id, meta.epoch);
    this.ctx.storage.sql.exec(`UPDATE invites SET key_wrap = ?, key_epoch = ? WHERE id = ?`, input.wrapped, input.epoch, inviteId);
  }

  /** The invite's wrapped click key, if it is still for the current epoch. */
  async inviteKey(tokenHash: string): Promise<{ epoch: number; wrapped: string } | null> {
    const meta = this.encMeta();
    const row = this.ctx.storage.sql
      .exec<{ key_wrap: string | null; key_epoch: number | null }>(`SELECT key_wrap, key_epoch FROM invites WHERE token_hash = ?`, tokenHash)
      .toArray()[0];
    if (!row?.key_wrap || row.key_epoch !== meta.epoch || meta.epoch === 0) return null;
    return { epoch: row.key_epoch, wrapped: row.key_wrap };
  }

  /** A joiner proved it holds an invite carrying the current key: store its slot. */
  async shareKeysAsInvite(principalId: string, input: { epoch: number; key_id: string; wrapped: string }, tokenHash: string): Promise<boolean> {
    const meta = this.encMeta();
    const invite = this.ctx.storage.sql
      .exec<{ key_epoch: number | null }>(`SELECT key_epoch FROM invites WHERE token_hash = ? AND key_wrap IS NOT NULL`, tokenHash)
      .toArray()[0];
    if (!invite || invite.key_epoch !== meta.epoch || input.epoch !== meta.epoch) return false;
    const owner = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM member_keys WHERE key_id = ? AND principal_id = ?`, input.key_id, principalId).one().n;
    if (owner === 0) return false;
    return this.insertSlots(meta.epoch, [{ key_id: input.key_id, wrapped: input.wrapped }]) === 1;
  }

  /** After rotate_key: the old admin key's recovery copy goes; the new key is registered. */
  async replaceAdminKey(props: ClickProps, key: PublicKeyInput, slot: { epoch: number; wrapped: string } | null): Promise<void> {
    this.assertAdmin(props.role);
    const admin = this.requireMeta().admin_principal;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM key_slots WHERE key_id IN (SELECT key_id FROM member_keys WHERE kind = 'admin')`);
      this.ctx.storage.sql.exec(`DELETE FROM member_keys WHERE kind = 'admin'`);
    });
    this.rememberKey(admin, { ...key, kind: "admin" });
    if (slot && slot.epoch === this.encMeta().epoch) this.insertSlots(slot.epoch, [{ key_id: key.id, wrapped: slot.wrapped }]);
  }

  /** For whoami/list_clicks: the click's encryption state. */
  async plaintextCount(): Promise<number> {
    return this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE enc = 0`).one().n;
  }

  async encryptionInfo(): Promise<{ encryption: "standard" | "private"; key_epoch: number; plaintext_left: number }> {
    const meta = this.encMeta();
    const left = meta.mode === "private" ? this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE enc = 0`).one().n : 0;
    return { encryption: meta.mode, key_epoch: meta.epoch, plaintext_left: left };
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

function sealedOf(row: { enc: number; key_epoch: number | null; body_ct: string | null }): { sealed?: { epoch: number; ct: string } } {
  if (row.enc !== 1 || row.key_epoch == null || !row.body_ct) return {};
  return { sealed: { epoch: row.key_epoch, ct: row.body_ct } };
}
