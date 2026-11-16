import { describe, expect, it } from "vitest";
import { credFromSecret, credFromSeed, messageAad, newSeed, openText, randomBytes, sealText, unwrapWithCred, unwrapWithSecret, wrapToPub, wrapToSecret } from "../src/enc";

describe("private click crypto", () => {
  it("derives stable credential keys and round-trips slots, invites and messages", async () => {
    const seed = newSeed();
    const a = await credFromSeed(seed);
    const again = await credFromSeed(seed);
    expect(again.pub).toBe(a.pub);
    expect(again.id).toBe(a.id);
    const b = await credFromSecret("clk_example_secret");
    expect(b.pub).not.toBe(a.pub);
    const dek = randomBytes(32);
    const slot = await wrapToPub(dek, a.pub);
    expect([...await unwrapWithCred(slot, a)]).toEqual([...dek]);
    await expect(unwrapWithCred(slot, b)).rejects.toThrow();
    const inv = await wrapToSecret(dek, "clk_inv_x", "click/invite/v1");
    expect([...await unwrapWithSecret(inv, "clk_inv_x", "click/invite/v1")]).toEqual([...dek]);
    await expect(unwrapWithSecret(inv, "clk_inv_y", "click/invite/v1")).rejects.toThrow();
    const aad = messageAad("c", "e", 1);
    const ct = await sealText(dek, "hello", aad);
    expect(ct).not.toContain("hello");
    expect(await openText(dek, ct, aad)).toBe("hello");
    await expect(openText(dek, ct, messageAad("c", "other", 1))).rejects.toThrow();
  });
});
