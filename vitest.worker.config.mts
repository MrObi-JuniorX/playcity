import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Worker tests run in workerd against wrangler.jsonc. Auth runs in dev mode here: the fake SMS sender, the
// "dev-pass" Turnstile token, throwaway keys, and low limits on two test-only countries so caps are reachable.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: migrations,
        AUTH_MODE: "dev",
        SMS_PROVIDER: "fake",
        PHONE_HMAC_KEY: "dGVzdC1obWFjLWtleS10ZXN0LWhtYWMta2V5LXRlc3QtaG1hYw==",
        PHONE_ENC_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        AUTH_LIMITS: JSON.stringify({ perCountryDay: { ZA: 2, AE: 1 }, globalDay: 400 }),
        CONSOLE_CODE: "test-console-code",
        CUP_T2_FULL: process.env.CUP_T2_FULL ?? "",
        // A throwaway VAPID pair for the Web Push tests (never used anywhere else).
        VAPID_PUBLIC_KEY: "BNQzQ87CMRpZNToIOCtwDlTwTvjmAds6ZbCxMKbLaV8sAUNCEzNBEgpVteopf02X2Dq1my0Dt843j8zD539pEJo",
        VAPID_PRIVATE_KEY: "Hc9srv_fw1caTX94PBkgLgoTkoA6jNcgy82ca6DWkrw",
        VAPID_SUBJECT: "mailto:tests@example.org",
      },
    },
  })],
  test: { include: ["test/worker/**/*.test.ts"], setupFiles: ["./test/worker/apply-migrations.ts"] },
});
