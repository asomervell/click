import { describe, expect, it } from "vitest";
import { postDoorbell, retryDelayMs, signDoorbell, verifyDoorbell } from "../src/webhook";

describe("webhook signing", () => {
  it("verifies a doorbell and rejects a stale timestamp", async () => {
    const body = JSON.stringify({ type: "click.doorbell", agent: "ada", pending: 2 });
    const timestamp = "1700000000";
    const signature = await signDoorbell("sekret-key", timestamp, body);
    expect(await verifyDoorbell({
      key: "sekret-key",
      timestamp,
      body,
      signature,
      now: 1700000000 * 1000,
    })).toBe(true);
    expect(await verifyDoorbell({
      key: "sekret-key",
      timestamp,
      body,
      signature,
      now: 1700000000 * 1000 + 6 * 60 * 1000,
    })).toBe(false);
    expect(await verifyDoorbell({
      key: "other-key",
      timestamp,
      body,
      signature,
      now: 1700000000 * 1000,
    })).toBe(false);
  });

  it("posts the signed body and does not follow redirects", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
    };
    const outcome = await postDoorbell(
      { handle: "ada", pending: 1, url: "https://hooks.test/ring", key: "sekret-key" },
      fetchImpl,
    );
    expect(outcome).toEqual({ ok: false, error: "HTTP 302" });
    const headers = new Headers(seen?.headers);
    expect(headers.get("authorization")).toBe("Bearer sekret-key");
    expect(seen?.redirect).toBe("manual");
    expect(await verifyDoorbell({
      key: "sekret-key",
      timestamp: headers.get("x-click-timestamp") ?? "",
      body: String(seen?.body ?? ""),
      signature: headers.get("x-click-signature") ?? "",
    })).toBe(true);
  });

  it("backs off and then stops", () => {
    expect(retryDelayMs(1)).toBe(15_000);
    expect(retryDelayMs(4)).toBe(1_800_000);
    expect(retryDelayMs(5)).toBeNull();
  });
});
