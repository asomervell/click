import { DurableObject } from "cloudflare:workers";
import { randomToken, sha256Hex } from "./crypto";
import { ClickError, type Membership, type Role } from "./types";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WINDOW_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_MEMBERSHIPS = 50;
export const LOBBY = "lobby";
const LOOKING_MS = 24 * 60 * 60 * 1000;
const OFFER_MS = 14 * 24 * 60 * 60 * 1000;

export type AccountRow = {
  id: string;
  handle: string | null;
  name: string | null;
  description: string | null;
  looking_until: number | null;
  created_at: number;
};

export type ResolvedCredential = {
  clickId: string;
  principalId: string;
  role: Role;
};

export function getDirectory(env: Env): DurableObjectStub<ClickDirectory> {
  return env.DIRECTORY.getByName("directory");
}

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL.test(normalized) || normalized.length > 200) throw new ClickError("Enter a valid contact email.");
  return normalized;
}

function sixDigits(): string {
  const buffer = new Uint32Array(1);
  // Rejection sampling keeps every code equally likely.
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? 0;
    if (value < 4_294_000_000) return (value % 1_000_000).toString().padStart(6, "0");
  }
}

function codeHash(pendingId: string, code: string): Promise<string> {
  return sha256Hex(`click-verify:${pendingId}:${code.trim()}`);
}

function sameHash(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

type MembershipRow = {
  account_id: string;
  click_id: string;
  principal_id: string;
  role: Role;
  left_at: number | null;
  name: string | null;
  live: number;
};

/** Maps click keys, invites, minted tokens, and memberships to click ids. Mailboxes live elsewhere. */
export class ClickDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS clicks (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        admin_principal TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS api_tokens (
        token_hash TEXT PRIMARY KEY,
        click_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        role TEXT NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS invites (
        token_hash TEXT PRIMARY KEY,
        click_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS signup_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        account_id TEXT NOT NULL,
        click_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        left_at INTEGER,
        PRIMARY KEY (account_id, click_id)
      );
      CREATE INDEX IF NOT EXISTS memberships_principal ON memberships (click_id, principal_id);
      CREATE TABLE IF NOT EXISTS pending_clicks (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        code_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        account_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS verify_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        ip_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS verify_log_email ON verify_log (email, created_at);
      CREATE INDEX IF NOT EXISTS verify_log_ip ON verify_log (ip_hash, created_at);
    `);
    // v2 columns on tables that already exist in production.
    this.addColumn("clicks", "name", "TEXT");
    this.addColumn("clicks", "email_verified_at", "INTEGER");
    this.addColumn("invites", "expires_at", "INTEGER");
    this.addColumn("invites", "revoked_at", "INTEGER");
    this.addColumn("verify_log", "pending_id", "TEXT");
    this.addColumn("invites", "max_uses", "INTEGER");
    this.addColumn("invites", "uses", "INTEGER NOT NULL DEFAULT 0");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        handle TEXT UNIQUE,
        name TEXT,
        description TEXT,
        looking_until INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS join_offers (
        click_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (click_id, account_id)
      );
      CREATE INDEX IF NOT EXISTS join_offers_account ON join_offers (account_id);
      CREATE TABLE IF NOT EXISTS handle_holds (
        handle TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        until INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handle_renames (
        account_id TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS account_log_ip ON account_log (ip_hash, created_at);
    `);
  }

  /** A standalone agent identity, in no click yet. Rate limited per network. */
  async createAccount(ipHash: string): Promise<{ accountId: string }> {
    const now = Date.now();
    const recent = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM account_log WHERE ip_hash = ? AND created_at > ?`, ipHash, now - HOUR_MS)
      .one().n;
    if (recent >= 30) throw new ClickError("Too many new agents from this network. Try again in an hour.");
    const accountId = `acct_${crypto.randomUUID()}`;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`INSERT INTO account_log (ip_hash, created_at) VALUES (?, ?)`, ipHash, now);
      this.ctx.storage.sql.exec(`DELETE FROM account_log WHERE created_at < ?`, now - 2 * HOUR_MS);
      this.ctx.storage.sql.exec(`INSERT INTO accounts (id, created_at) VALUES (?, ?)`, accountId, now);
    });
    return { accountId };
  }

  async account(accountId: string): Promise<AccountRow | null> {
    return this.ctx.storage.sql.exec<AccountRow>(`SELECT * FROM accounts WHERE id = ?`, accountId).toArray()[0] ?? null;
  }

  async accountByHandle(handle: string): Promise<AccountRow | null> {
    return this.ctx.storage.sql.exec<AccountRow>(`SELECT * FROM accounts WHERE handle = ?`, handle).toArray()[0] ?? null;
  }

  private globalHandleTaken(handle: string, selfId: string): boolean {
    const owner = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM accounts WHERE handle = ?`, handle).toArray()[0];
    if (owner && owner.id !== selfId) return true;
    const hold = this.ctx.storage.sql
      .exec<{ account_id: string }>(`SELECT account_id FROM handle_holds WHERE handle = ? AND until > ?`, handle, Date.now())
      .toArray()[0];
    return Boolean(hold && hold.account_id !== selfId);
  }

  /** The plain name if it is free, else name-2 ... name-9, else name plus two random characters. */
  private freeHandle(base: string, selfId: string): string {
    const trimmed = base.slice(0, 29).replace(/-+$/, "") || "agent";
    if (!this.globalHandleTaken(trimmed, selfId)) return trimmed;
    for (let n = 2; n <= 9; n++) {
      const candidate = `${trimmed}-${n}`;
      if (!this.globalHandleTaken(candidate, selfId)) return candidate;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const suffix = [...crypto.getRandomValues(new Uint8Array(2))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
      const candidate = `${trimmed}-${suffix}`;
      if (!this.globalHandleTaken(candidate, selfId)) return candidate;
    }
    throw new ClickError("Could not find a free handle. Try another name.");
  }

  /** Claim a global handle: the plain name the agent chose, with a short suffix only if it is taken. */
  async claimHandle(accountId: string, base: string, profile: { name: string | null; description: string | null }): Promise<AccountRow & { requested: string }> {
    const existing = await this.account(accountId);
    if (!existing) throw new ClickError("This connection has no Click identity.");
    if (existing.handle) {
      this.ctx.storage.sql.exec(`UPDATE accounts SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?`, profile.name, profile.description, accountId);
      return { ...(await this.account(accountId))!, requested: base };
    }
    const handle = this.freeHandle(base, accountId);
    this.ctx.storage.sql.exec(`UPDATE accounts SET handle = ?, name = ?, description = ? WHERE id = ?`, handle, profile.name, profile.description, accountId);
    return { ...(await this.account(accountId))!, requested: base };
  }

  /** Can this account take this exact global handle? */
  async globalHandleFree(accountId: string, handle: string): Promise<boolean> {
    return !this.globalHandleTaken(handle, accountId);
  }

  /** Rename a global handle: 3 a day, and the old one is held for this account for 7 days. */
  async renameAccount(accountId: string, handle: string): Promise<{ old_handle: string | null; handle: string }> {
    const account = await this.account(accountId);
    if (!account) throw new ClickError("This connection has no Click identity.");
    if (account.handle === handle) return { old_handle: handle, handle };
    if (this.globalHandleTaken(handle, accountId)) throw new ClickError(`The handle ${handle} is taken. Pick another.`);
    const now = Date.now();
    const recent = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM handle_renames WHERE account_id = ? AND at > ?`, accountId, now - 24 * HOUR_MS)
      .one().n;
    if (recent >= 3) throw new ClickError("Too many renames: at most 3 a day. Try again tomorrow.");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`UPDATE accounts SET handle = ?, name = CASE WHEN name IS NULL OR name = ? THEN ? ELSE name END WHERE id = ?`, handle, account.handle, handle, accountId);
      this.ctx.storage.sql.exec(`DELETE FROM handle_holds WHERE handle = ?`, handle);
      if (account.handle) {
        this.ctx.storage.sql.exec(
          `INSERT INTO handle_holds (handle, account_id, until) VALUES (?, ?, ?) ON CONFLICT (handle) DO UPDATE SET account_id = excluded.account_id, until = excluded.until`,
          account.handle, accountId, now + 7 * 24 * HOUR_MS,
        );
      }
      this.ctx.storage.sql.exec(`INSERT INTO handle_renames (account_id, at) VALUES (?, ?)`, accountId, now);
    });
    return { old_handle: account.handle, handle };
  }

  /** Live clicks with this exact name (case-insensitive), for request_join by name. */
  async clicksNamed(name: string): Promise<Array<{ id: string; name: string | null }>> {
    return this.ctx.storage.sql
      .exec<{ id: string; name: string | null }>(`SELECT id, name FROM clicks WHERE revoked_at IS NULL AND lower(name) = lower(?) LIMIT 5`, name.trim())
      .toArray();
  }

  /** Delete a standalone agent identity that is in no live click: tokens, offers, and holds. */
  async purgeAccount(accountId: string): Promise<{ deleted: boolean; handle: string | null }> {
    const account = await this.account(accountId);
    if (!account) return { deleted: false, handle: null };
    if ((await this.liveMembershipCount(accountId)) > 0) throw new ClickError("Leave every click first.");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM api_tokens WHERE principal_id = ? AND click_id = 'lobby'`, accountId);
      this.ctx.storage.sql.exec(`DELETE FROM join_offers WHERE account_id = ?`, accountId);
      this.ctx.storage.sql.exec(`DELETE FROM handle_holds WHERE account_id = ?`, accountId);
      this.ctx.storage.sql.exec(`DELETE FROM handle_renames WHERE account_id = ?`, accountId);
      this.ctx.storage.sql.exec(`DELETE FROM memberships WHERE account_id = ?`, accountId);
      this.ctx.storage.sql.exec(`DELETE FROM accounts WHERE id = ?`, accountId);
    });
    return { deleted: true, handle: account.handle };
  }

  /** Operator view of standalone agents: handle and live click count only. */
  async allAccounts(): Promise<Array<{ id: string; handle: string | null; created_at: number; clicks: number }>> {
    const rows = this.ctx.storage.sql.exec<{ id: string; handle: string | null; created_at: number }>(`SELECT id, handle, created_at FROM accounts ORDER BY created_at`).toArray();
    return Promise.all(rows.map(async (row) => ({ ...row, clicks: await this.liveMembershipCount(row.id) })));
  }

  async setLooking(accountId: string, open: boolean): Promise<number | null> {
    const until = open ? Date.now() + LOOKING_MS : null;
    this.ctx.storage.sql.exec(`UPDATE accounts SET looking_until = ? WHERE id = ?`, until, accountId);
    return until;
  }

  /** Pending adds (admin to agent) and requests (agent to admin). */
  async offerJoin(clickId: string, accountId: string, kind: "add" | "request"): Promise<void> {
    const open = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM join_offers WHERE ${kind === "add" ? "account_id" : "click_id"} = ?`, kind === "add" ? accountId : clickId)
      .one().n;
    if (open >= 50) throw new ClickError(kind === "add" ? "That agent has too many pending adds." : "This click has too many pending requests.");
    this.ctx.storage.sql.exec(
      `INSERT INTO join_offers (click_id, account_id, kind, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (click_id, account_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at`,
      clickId, accountId, kind, Date.now(),
    );
  }

  async joinOffer(clickId: string, accountId: string): Promise<{ kind: "add" | "request"; created_at: number } | null> {
    return this.ctx.storage.sql
      .exec<{ kind: "add" | "request"; created_at: number }>(`SELECT kind, created_at FROM join_offers WHERE click_id = ? AND account_id = ? AND created_at > ?`, clickId, accountId, Date.now() - OFFER_MS)
      .toArray()[0] ?? null;
  }

  async clearOffer(clickId: string, accountId: string): Promise<boolean> {
    return this.ctx.storage.sql.exec(`DELETE FROM join_offers WHERE click_id = ? AND account_id = ?`, clickId, accountId).rowsWritten > 0;
  }

  async offersForAccount(accountId: string): Promise<Array<{ click_id: string; click_name: string | null; kind: string; created_at: number }>> {
    return this.ctx.storage.sql
      .exec<{ click_id: string; click_name: string | null; kind: string; created_at: number }>(
        `SELECT o.click_id, c.name AS click_name, o.kind, o.created_at FROM join_offers o JOIN clicks c ON c.id = o.click_id AND c.revoked_at IS NULL
         WHERE o.account_id = ? AND o.created_at > ? ORDER BY o.created_at DESC`,
        accountId, Date.now() - OFFER_MS,
      )
      .toArray();
  }

  async offersForClick(clickId: string): Promise<Array<{ handle: string | null; name: string | null; description: string | null; kind: string; created_at: number }>> {
    return this.ctx.storage.sql
      .exec<{ handle: string | null; name: string | null; description: string | null; kind: string; created_at: number }>(
        `SELECT a.handle, a.name, a.description, o.kind, o.created_at FROM join_offers o JOIN accounts a ON a.id = o.account_id
         WHERE o.click_id = ? AND o.created_at > ? ORDER BY o.created_at DESC`,
        clickId, Date.now() - OFFER_MS,
      )
      .toArray();
  }

  async isMember(accountId: string, clickId: string): Promise<boolean> {
    return this.membershipRows(accountId).some((row) => row.click_id === clickId && row.left_at == null && row.live === 1);
  }

  async liveMembershipCount(accountId: string): Promise<number> {
    return this.membershipRows(accountId).filter((row) => row.left_at == null && row.live === 1).length;
  }

  private addColumn(table: string, column: string, type: string): void {
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
      .toArray()
      .map((row) => row.name);
    if (!columns.includes(column)) this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private checkCreateLimits(email: string, now: number): void {
    const recent = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM signup_log WHERE created_at > ?`, now - WINDOW_MS)
      .one().n;
    if (recent >= 30) throw new ClickError("Too many new clicks right now. Try again in a few minutes.");
    const byEmail = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM signup_log WHERE email = ? AND created_at > ?`, email, now - DAY_MS)
      .one().n;
    if (byEmail >= 5) throw new ClickError("That email already opened several clicks today. Try again in a few hours.");
  }

  private async insertClick(email: string, name: string | null, verifiedAt: number | null): Promise<{ clickId: string; clickKey: string; adminId: string }> {
    const now = Date.now();
    const clickId = crypto.randomUUID();
    const adminId = crypto.randomUUID();
    const clickKey = randomToken("clk_");
    const keyHash = await sha256Hex(clickKey);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO clicks (id, key_hash, email, admin_principal, created_at, name, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        clickId,
        keyHash,
        email,
        adminId,
        now,
        name,
        verifiedAt,
      );
      this.ctx.storage.sql.exec(`INSERT INTO signup_log (email, created_at) VALUES (?, ?)`, email, now);
      this.ctx.storage.sql.exec(
        `INSERT INTO memberships (account_id, click_id, principal_id, role, created_at) VALUES (?, ?, ?, 'admin', ?)
         ON CONFLICT (account_id, click_id) DO NOTHING`,
        adminId,
        clickId,
        adminId,
        now,
      );
    });
    return { clickId, clickKey, adminId };
  }

  /** Unverified create. Only reachable while ALLOW_UNVERIFIED_SIGNUP is on and no sender is live. */
  async createClick(email: string, name: string | null = null): Promise<{ clickId: string; clickKey: string; adminId: string }> {
    const normalized = normalizeEmail(email);
    this.checkCreateLimits(normalized, Date.now());
    return this.insertClick(normalized, name, null);
  }

  /** Step one of a verified create. Returns the plaintext code once so the worker can mail it. */
  async startSignup(input: { email: string; name: string | null; ipHash: string; accountId: string | null }): Promise<{
    pendingId: string;
    code: string;
    expiresAt: number;
    email: string;
  }> {
    const email = normalizeEmail(input.email);
    const now = Date.now();
    this.checkCreateLimits(email, now);
    const count = (where: string, ...args: unknown[]) =>
      this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM verify_log WHERE ${where}`, ...args).one().n;
    if (count("created_at > ?", now - WINDOW_MS) >= 60) {
      throw new ClickError("Too many verification emails right now. Try again in a few minutes.");
    }
    if (count("email = ? AND created_at > ?", email, now - CODE_TTL_MS) >= 3) {
      throw new ClickError("Too many codes sent to that email. Wait 15 minutes and try again.");
    }
    if (count("email = ? AND created_at > ?", email, now - DAY_MS) >= 10) {
      throw new ClickError("Too many codes sent to that email today. Try again tomorrow.");
    }
    if (count("ip_hash = ? AND created_at > ?", input.ipHash, now - HOUR_MS) >= 10) {
      throw new ClickError("Too many verification emails from this network. Try again in an hour.");
    }
    const pendingId = crypto.randomUUID();
    const code = sixDigits();
    const expiresAt = now + CODE_TTL_MS;
    const hash = await codeHash(pendingId, code);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO pending_clicks (id, email, name, code_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        pendingId,
        email,
        input.name,
        hash,
        input.accountId,
        now,
        expiresAt,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO verify_log (email, ip_hash, created_at, pending_id) VALUES (?, ?, ?, ?)`,
        email,
        input.ipHash,
        now,
        pendingId,
      );
      this.ctx.storage.sql.exec(`DELETE FROM pending_clicks WHERE expires_at < ?`, now - DAY_MS);
      this.ctx.storage.sql.exec(`DELETE FROM verify_log WHERE created_at < ?`, now - 2 * DAY_MS);
    });
    return { pendingId, code, expiresAt, email };
  }

  /** The email could not be sent: drop the attempt so it does not count toward the send limits. */
  async cancelSignup(pendingId: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM pending_clicks WHERE id = ? AND used_at IS NULL`, pendingId);
      this.ctx.storage.sql.exec(`DELETE FROM verify_log WHERE pending_id = ?`, pendingId);
    });
  }

  /** Step two. A correct, unexpired code creates the click exactly once. */
  async verifySignup(pendingId: string, code: string): Promise<{
    clickId: string;
    clickKey: string;
    adminId: string;
    email: string;
    name: string | null;
    accountId: string | null;
  }> {
    const now = Date.now();
    const pending = this.ctx.storage.sql
      .exec<{ id: string; email: string; name: string | null; code_hash: string; attempts: number; account_id: string | null; expires_at: number; used_at: number | null }>(
        `SELECT id, email, name, code_hash, attempts, account_id, expires_at, used_at FROM pending_clicks WHERE id = ?`,
        pendingId.trim(),
      )
      .toArray()[0];
    if (!pending || pending.used_at != null) throw new ClickError("That verification was not found. Start again.");
    if (pending.expires_at < now) throw new ClickError("That code expired. Start again to get a new one.");
    if (pending.attempts >= MAX_CODE_ATTEMPTS) throw new ClickError("Too many wrong codes. Start again to get a new one.");
    const presented = await codeHash(pending.id, code);
    if (!/^\d{6}$/.test(code.trim()) || !sameHash(presented, pending.code_hash)) {
      this.ctx.storage.sql.exec(`UPDATE pending_clicks SET attempts = attempts + 1 WHERE id = ?`, pending.id);
      const left = MAX_CODE_ATTEMPTS - pending.attempts - 1;
      throw new ClickError(left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Start again to get a new one.");
    }
    const claimed = this.ctx.storage.sql.exec(
      `UPDATE pending_clicks SET used_at = ? WHERE id = ? AND used_at IS NULL`,
      now,
      pending.id,
    );
    if (claimed.rowsWritten !== 1) throw new ClickError("That verification was already used.");
    this.checkCreateLimits(pending.email, now);
    const created = await this.insertClick(pending.email, pending.name, now);
    if (pending.account_id && pending.account_id !== created.adminId) {
      this.insertMembership(pending.account_id, created.clickId, created.adminId, "admin");
    }
    return { ...created, email: pending.email, name: pending.name, accountId: pending.account_id };
  }

  async resolveKeyHash(keyHash: string): Promise<ResolvedCredential | null> {
    const click = this.ctx.storage.sql
      .exec<{ id: string; admin_principal: string }>(
        `SELECT id, admin_principal FROM clicks WHERE key_hash = ? AND revoked_at IS NULL`,
        keyHash,
      )
      .toArray()[0];
    if (click) return { clickId: click.id, principalId: click.admin_principal, role: "admin" };
    const token = this.ctx.storage.sql
      .exec<{ click_id: string; principal_id: string; role: Role }>(
        `SELECT click_id, principal_id, role FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL`,
        keyHash,
      )
      .toArray()[0];
    if (!token) return null;
    // A token whose home click is gone still works if it holds memberships elsewhere.
    return { clickId: token.click_id, principalId: token.principal_id, role: token.role };
  }

  /**
   * Every live click this identity belongs to. The account id is the home
   * principal id, so legacy tokens and OAuth grants need no rewrite: their home
   * membership is recorded the first time they are seen.
   */
  async memberships(home: ResolvedCredential): Promise<Membership[]> {
    const accountId = home.principalId;
    let rows = this.membershipRows(accountId);
    if (home.clickId !== LOBBY && !rows.some((row) => row.click_id === home.clickId)) {
      this.insertMembership(accountId, home.clickId, home.principalId, home.role);
      rows = this.membershipRows(accountId);
    }
    return rows
      .filter((row) => row.left_at == null && row.live === 1)
      .map((row) => ({
        accountId,
        clickId: row.click_id,
        principalId: row.principal_id,
        role: row.click_id === home.clickId ? home.role : row.role,
        name: row.name,
        home: row.click_id === home.clickId,
      }));
  }

  private membershipRows(accountId: string): MembershipRow[] {
    return this.ctx.storage.sql
      .exec<MembershipRow>(
        `SELECT m.account_id, m.click_id, m.principal_id, m.role, m.left_at, c.name,
                CASE WHEN c.id IS NOT NULL AND c.revoked_at IS NULL THEN 1 ELSE 0 END AS live
         FROM memberships m LEFT JOIN clicks c ON c.id = m.click_id
         WHERE m.account_id = ?
         ORDER BY m.created_at`,
        accountId,
      )
      .toArray();
  }

  private insertMembership(accountId: string, clickId: string, principalId: string, role: Role): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO memberships (account_id, click_id, principal_id, role, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, click_id) DO NOTHING`,
      accountId,
      clickId,
      principalId,
      role,
      Date.now(),
    );
  }

  /**
   * Take one use of an invite for an account that is not yet in its click. Invites are
   * reusable up to max_uses (older rows without max_uses are single use). Returns the click id.
   */
  async takeInvite(tokenHash: string, accountId: string | null = null): Promise<string | null> {
    const now = Date.now();
    const invite = this.ctx.storage.sql
      .exec<{ click_id: string; used_at: number | null; expires_at: number | null; revoked_at: number | null; uses: number; max_uses: number | null }>(
        `SELECT click_id, used_at, expires_at, revoked_at, uses, max_uses FROM invites WHERE token_hash = ?`,
        tokenHash,
      )
      .toArray()[0];
    if (!invite || invite.revoked_at != null) return null;
    if (invite.used_at != null || invite.uses >= (invite.max_uses ?? 1)) {
      throw new ClickError("That invite has no uses left. Ask the admin to make a new one.");
    }
    if (invite.expires_at != null && invite.expires_at <= now) throw new ClickError("That invite expired. Ask the admin for a new one.");
    if (!(await this.clickExists(invite.click_id))) return null;
    if (accountId) {
      const existing = this.membershipRows(accountId).find((row) => row.click_id === invite.click_id && row.left_at == null);
      if (existing) throw new ClickError("You are already in that click. The invite was not used.");
      const active = this.membershipRows(accountId).filter((row) => row.left_at == null && row.live === 1).length;
      if (active >= MAX_MEMBERSHIPS) throw new ClickError(`One identity can be in at most ${MAX_MEMBERSHIPS} clicks.`);
    }
    const rows = this.ctx.storage.sql
      .exec<{ click_id: string }>(
        `UPDATE invites SET uses = uses + 1, used_at = CASE WHEN uses + 1 >= COALESCE(max_uses, 1) THEN ? ELSE NULL END
         WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND uses < COALESCE(max_uses, 1) RETURNING click_id`,
        now,
        tokenHash,
      )
      .toArray();
    return rows[0]?.click_id ?? null;
  }

  /** Record a membership won through an invite. A prior left row is replaced. */
  async addMembership(input: { accountId: string; clickId: string; principalId: string; role: Role }): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO memberships (account_id, click_id, principal_id, role, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, click_id) DO UPDATE SET principal_id = excluded.principal_id, role = excluded.role,
         created_at = excluded.created_at, left_at = NULL`,
      input.accountId,
      input.clickId,
      input.principalId,
      input.role,
      Date.now(),
    );
  }

  async revokeClick(clickId: string): Promise<void> {
    const now = Date.now();
    const result = this.ctx.storage.sql.exec(
      `UPDATE clicks SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      now,
      clickId,
    );
    if (result.rowsWritten !== 1) throw new ClickError("That click was not found.");
    const tokens = this.ctx.storage.sql
      .exec<{ token_hash: string; principal_id: string }>(
        `SELECT token_hash, principal_id FROM api_tokens WHERE click_id = ? AND revoked_at IS NULL`,
        clickId,
      )
      .toArray();
    for (const token of tokens) {
      if (this.hasOtherLiveMembership(token.principal_id, clickId)) continue;
      this.ctx.storage.sql.exec(`UPDATE api_tokens SET revoked_at = ? WHERE token_hash = ?`, now, token.token_hash);
    }
  }

  /**
   * Remove every Directory row for a click. Returns the identities homed there that
   * have no live membership anywhere else, so their OAuth grants can be revoked.
   */
  async purgeClick(clickId: string, principals: string[]): Promise<string[]> {
    const homed = new Set(principals);
    const admin = this.ctx.storage.sql
      .exec<{ admin_principal: string }>(`SELECT admin_principal FROM clicks WHERE id = ?`, clickId)
      .toArray()[0]?.admin_principal;
    if (admin) homed.add(admin);
    for (const row of this.ctx.storage.sql
      .exec<{ principal_id: string }>(`SELECT DISTINCT principal_id FROM api_tokens WHERE click_id = ?`, clickId)
      .toArray()) homed.add(row.principal_id);
    const orphans = [...homed].filter((id) => !this.hasOtherLiveMembership(id, clickId));
    this.ctx.storage.transactionSync(() => {
      // A token homed here stays when its identity still lives in another click.
      for (const id of orphans) this.ctx.storage.sql.exec(`DELETE FROM api_tokens WHERE click_id = ? AND principal_id = ?`, clickId, id);
      this.ctx.storage.sql.exec(`DELETE FROM invites WHERE click_id = ?`, clickId);
      this.ctx.storage.sql.exec(`DELETE FROM join_offers WHERE click_id = ?`, clickId);
      this.ctx.storage.sql.exec(`DELETE FROM memberships WHERE click_id = ?`, clickId);
      this.ctx.storage.sql.exec(`DELETE FROM clicks WHERE id = ?`, clickId);
    });
    return orphans;
  }

  /** Operator view: every click id the Directory knows, live or revoked. No keys. */
  async allClicks(): Promise<Array<{ id: string; name: string | null; created_at: number; revoked_at: number | null }>> {
    return this.ctx.storage.sql
      .exec<{ id: string; name: string | null; created_at: number; revoked_at: number | null }>(
        `SELECT id, name, created_at, revoked_at FROM clicks ORDER BY created_at`,
      )
      .toArray();
  }

  async clickExists(clickId: string): Promise<boolean> {
    const row = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM clicks WHERE id = ? AND revoked_at IS NULL`, clickId)
      .toArray()[0];
    return Boolean(row);
  }

  async clickName(clickId: string): Promise<string | null> {
    return this.ctx.storage.sql
      .exec<{ name: string | null }>(`SELECT name FROM clicks WHERE id = ?`, clickId)
      .toArray()[0]?.name ?? null;
  }

  async renameClick(clickId: string, name: string | null): Promise<void> {
    const result = this.ctx.storage.sql.exec(`UPDATE clicks SET name = ? WHERE id = ? AND revoked_at IS NULL`, name, clickId);
    if (result.rowsWritten !== 1) throw new ClickError("That click was not found.");
  }

  async replaceKey(clickId: string, previousHash: string, nextHash: string): Promise<void> {
    const result = this.ctx.storage.sql.exec(
      `UPDATE clicks SET key_hash = ? WHERE id = ? AND key_hash = ? AND revoked_at IS NULL`,
      nextHash,
      clickId,
      previousHash,
    );
    if (result.rowsWritten !== 1) throw new ClickError("The click key could not be rotated.");
  }

  async rememberToken(input: { tokenHash: string; clickId: string; principalId: string; role: Role }): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO api_tokens (token_hash, click_id, principal_id, role) VALUES (?, ?, ?, ?)`,
      input.tokenHash,
      input.clickId,
      input.principalId,
      input.role,
    );
  }

  async rememberInvite(tokenHash: string, clickId: string, expiresAt: number | null = null, maxUses = 1): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO invites (token_hash, click_id, created_at, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, ?, 0)`,
      tokenHash,
      clickId,
      Date.now(),
      expiresAt,
      maxUses,
    );
  }

  async revokeInvite(tokenHash: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE invites SET revoked_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL`,
      Date.now(),
      tokenHash,
    );
  }

  async revokeHash(tokenHash: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE api_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
      Date.now(),
      tokenHash,
    );
  }

  /**
   * A principal left or was removed from one click. Its membership there ends,
   * unless it is the click's own admin. A token homed in that click is revoked
   * only when it has no other live membership.
   */
  async forgetPrincipal(clickId: string, principalId: string): Promise<void> {
    const now = Date.now();
    const admin = this.ctx.storage.sql
      .exec<{ admin_principal: string }>(`SELECT admin_principal FROM clicks WHERE id = ?`, clickId)
      .toArray()[0]?.admin_principal;
    if (admin !== principalId) {
      this.ctx.storage.sql.exec(
        `UPDATE memberships SET left_at = ? WHERE click_id = ? AND principal_id = ? AND left_at IS NULL`,
        now,
        clickId,
        principalId,
      );
      // A home membership that was never recorded is recorded as left, so it cannot reappear.
      this.ctx.storage.sql.exec(
        `INSERT INTO memberships (account_id, click_id, principal_id, role, created_at, left_at) VALUES (?, ?, ?, 'member', ?, ?)
         ON CONFLICT (account_id, click_id) DO NOTHING`,
        principalId,
        clickId,
        principalId,
        now,
        now,
      );
    }
    if (this.hasOtherLiveMembership(principalId, clickId)) return;
    this.ctx.storage.sql.exec(
      `UPDATE api_tokens SET revoked_at = ? WHERE click_id = ? AND principal_id = ? AND revoked_at IS NULL`,
      now,
      clickId,
      principalId,
    );
  }

  private hasOtherLiveMembership(accountId: string, clickId: string): boolean {
    return this.membershipRows(accountId).some((row) => row.click_id !== clickId && row.left_at == null && row.live === 1);
  }
}
