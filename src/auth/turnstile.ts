import { isDev, type AuthEnv } from "./env";

/* Turnstile check on the code request (ID-6). Live mode asks Cloudflare's siteverify and fails closed: no secret, a
   network error or a bad answer all mean no code is sent. Dev mode accepts the token "dev-pass" without a network
   call, so tests and local runs don't depend on Cloudflare. */
export async function turnstileOk(env: AuthEnv, tokenValue: unknown, ip: string): Promise<boolean> {
  if (typeof tokenValue !== "string" || !tokenValue || tokenValue.length > 2048) return false;
  if (isDev(env) && !env.TURNSTILE_SECRET) return tokenValue === "dev-pass";
  if (!env.TURNSTILE_SECRET) return false;
  try {
    const body = new FormData();
    body.append("secret", env.TURNSTILE_SECRET);
    body.append("response", tokenValue);
    if (ip) body.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    if (!r.ok) return false;
    const j = (await r.json()) as { success?: boolean; action?: string };
    return j.success === true && (!j.action || j.action === "otp");
  } catch {
    return false;
  }
}
