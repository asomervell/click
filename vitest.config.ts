import { createHash } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const ownerKeyHash = createHash("sha256").update("click-test-owner-key").digest("hex");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          OWNER_KEY_HASH: ownerKeyHash,
          // Test-only sender: verification codes land in src/email.ts testOutbox.
          TEST_EMAIL_OUTBOX: "1",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 15_000,
  },
});
