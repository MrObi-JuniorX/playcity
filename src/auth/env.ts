/* Settings and secrets the auth code reads. Secrets come from `wrangler secret put` (live) or .dev.vars (local).

   AUTH_MODE        "live" (default) or "dev". Dev allows the fake SMS sender and the dev Turnstile tokens; it must
                    never be set in production. Live refuses to sign anyone in without a real sender and Turnstile.
   PHONE_HMAC_KEY   base64, 32+ bytes: finds a player by number, hashes IPs and codes.
   PHONE_ENC_KEY    base64, exactly 32 bytes: AES-256-GCM for the stored number.
   TURNSTILE_SITE_KEY / TURNSTILE_SECRET   the Turnstile widget (ID-6).
   SMS_PROVIDER     "fake" (dev only) or a real provider once chosen (PRD section 13, question 1).
   AUTH_COUNTRIES   comma-separated ISO codes allowed to sign in. Default: the launch list in phone.ts.
   AUTH_LIMITS      optional JSON overriding any limit in limits.ts (tests use it). */
export type AuthEnv = Env & {
  AUTH_MODE?: string;
  PHONE_HMAC_KEY?: string;
  PHONE_ENC_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  SMS_PROVIDER?: string;
  AUTH_COUNTRIES?: string;
  AUTH_LIMITS?: string;
};

export const isDev = (env: AuthEnv) => env.AUTH_MODE === "dev";
