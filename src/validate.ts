import { ClickError } from "./types";

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!label) return null;
  if (label.length > 80) throw new ClickError("Label must be 80 characters or fewer.");
  return label;
}

export function requireHandle(value: string, field = "handle"): string {
  const handle = value.trim().toLowerCase();
  if (!HANDLE.test(handle)) {
    throw new ClickError(
      `${field} must be 1–32 characters of lowercase letters, digits, and hyphens, and must not start or end with a hyphen.`,
    );
  }
  return handle;
}

export function requireName(value: string | undefined, fallback: string): string {
  const name = (value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name) throw new ClickError("Name is required.");
  if (name.length > 80) throw new ClickError("Name must be 80 characters or fewer.");
  return name;
}

export function requireDescription(value: string | undefined): string {
  const description = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (description.length > 500) throw new ClickError("Description must be 500 characters or fewer.");
  return description;
}

export function requireText(value: string): string {
  const text = value.replace(/\u0000/g, "").trim();
  if (!text) throw new ClickError("Message text is required.");
  if (text.length > 8000) throw new ClickError("Message text must be 8000 characters or fewer.");
  return text;
}

function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isBlockedIp(host: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return true;
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (!host.includes(":")) return false;
  const lower = host.toLowerCase();
  if (lower === "::1") return false;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("::ffff:")) return isBlockedIp(lower.slice("::ffff:".length));
  return false;
}

/** https URLs, plus http only for loopback so local dev can receive doorbells. */
export function parseWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ClickError("Webhook URL is not a valid URL.");
  }
  if (url.username || url.password) throw new ClickError("Webhook URL must not include credentials.");
  if (url.hash) throw new ClickError("Webhook URL must not include a fragment.");
  if (raw.length > 2000) throw new ClickError("Webhook URL is too long.");
  const host = bareHost(url.hostname);
  const loopback = isLoopback(host);
  if (loopback && (url.protocol === "http:" || url.protocol === "https:")) return url;
  if (url.protocol !== "https:") throw new ClickError("Webhook URL must be https, or http on localhost.");
  if (isBlockedIp(host) || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") {
    throw new ClickError("Webhook URL must be a public https address.");
  }
  return url;
}

export function requireWebhookKey(value: string): string {
  const key = value.trim();
  if (key.length < 8 || key.length > 500) {
    throw new ClickError("Webhook key must be between 8 and 500 characters.");
  }
  return key;
}

export function clampLimit(value: number | undefined, max = 50): number {
  if (value == null) return 20;
  if (!Number.isInteger(value) || value < 1) throw new ClickError("Limit must be a positive integer.");
  return Math.min(value, max);
}

/** Optional human-readable click name. 1–60 printable characters. */
export function cleanClickName(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new ClickError("Click name must be a string.");
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  if (name.length > 60) throw new ClickError("Click name must be 60 characters or fewer.");
  if (!/[\p{L}\p{N}]/u.test(name)) throw new ClickError("Click name needs at least one letter or digit.");
  return name;
}

export function clickSlug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}
