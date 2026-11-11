import { DurableObject } from "cloudflare:workers";
import { randomToken, sha256Hex } from "./crypto";
import { ClickError, type Role } from "./types";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WINDOW_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ResolvedCredential = {
  clickId: string;
  principalId: string;
  role: Role;
};

export function getDirectory(env: Env): DurableObjectStub<ClickDirectory> {
  return env.DIRECTORY.getByName("directory");
}

/** Maps click keys, invites, and minted tokens to a click id. Mailboxes live elsewhere. */
export class ClickDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
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
      `);
    });
  }

  async createClick(email: string): Promise<{ clickId: string; clickKey: string; adminId: string }> {
    const normalized = email.trim().toLowerCase();
    if (!EMAIL.test(normalized) || normalized.length > 200) throw new ClickError("Enter a valid contact email.");
    const now = Date.now();
    const recent = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM signup_log WHERE created_at > ?`, now - WINDOW_MS)
      .one().n;
    if (recent >= 30) throw new ClickError("Too many new clicks right now. Try again in a few minutes.");
    const byEmail = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM signup_log WHERE email = ? AND created_at > ?`, normalized, now - DAY_MS)
      .one().n;
    if (byEmail >= 5) throw new ClickError("That email already opened several clicks today.");
    const clickId = crypto.randomUUID();
    const adminId = crypto.randomUUID();
    const clickKey = randomToken("clk_");
    const keyHash = await sha256Hex(clickKey);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO clicks (id, key_hash, email, admin_principal, created_at) VALUES (?, ?, ?, ?, ?)`,
        clickId,
        keyHash,
        normalized,
        adminId,
        now,
      );
      this.ctx.storage.sql.exec(`INSERT INTO signup_log (email, created_at) VALUES (?, ?)`, normalized, now);
    });
    return { clickId, clickKey, adminId };
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
    const live = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM clicks WHERE id = ? AND revoked_at IS NULL`, token.click_id)
      .toArray()[0];
    if (!live) return null;
    return { clickId: token.click_id, principalId: token.principal_id, role: token.role };
  }

  async revokeClick(clickId: string): Promise<void> {
    const now = Date.now();
    const result = this.ctx.storage.sql.exec(
      `UPDATE clicks SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      now,
      clickId,
    );
    if (result.rowsWritten !== 1) throw new ClickError("That click was not found.");
    this.ctx.storage.sql.exec(
      `UPDATE api_tokens SET revoked_at = ? WHERE click_id = ? AND revoked_at IS NULL`,
      now,
      clickId,
    );
  }

  async clickExists(clickId: string): Promise<boolean> {
    const row = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM clicks WHERE id = ? AND revoked_at IS NULL`, clickId)
      .toArray()[0];
    return Boolean(row);
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

  async rememberInvite(tokenHash: string, clickId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO invites (token_hash, click_id, created_at) VALUES (?, ?, ?)`,
      tokenHash,
      clickId,
      Date.now(),
    );
  }

  async takeInvite(tokenHash: string): Promise<string | null> {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec<{ click_id: string }>(
        `UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING click_id`,
        now,
        tokenHash,
      )
      .toArray();
    return rows[0]?.click_id ?? null;
  }

  async revokeHash(tokenHash: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE api_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
      Date.now(),
      tokenHash,
    );
  }

  async forgetPrincipal(clickId: string, principalId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE api_tokens SET revoked_at = ? WHERE click_id = ? AND principal_id = ? AND revoked_at IS NULL`,
      Date.now(),
      clickId,
      principalId,
    );
  }
}
