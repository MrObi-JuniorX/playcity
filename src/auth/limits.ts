import type { AuthEnv } from "./env";

/* Limits on sending codes (ID-6, threat T9: SMS pumping). Every send is a row in otp_requests, so the limits are
   counts over those rows. AUTH_LIMITS (JSON) overrides any value; tests use it to reach the caps quickly. */
export interface Limits {
  codeTtlMs: number;            // a code lives this long
  maxAttempts: number;          // wrong guesses before a code is dead
  perNumber15m: number;         // codes to one number in 15 minutes
  perNumberDay: number;         // ... in 24 hours
  perIpHour: number;            // codes requested from one IP in an hour
  perIpDay: number;             // ... in 24 hours
  perCountryDay: Record<string, number>;   // "*" is the default for countries not listed
  globalDay: number;            // all codes in 24 hours: the spend cap
  alertAt: number;              // share of globalDay at which an alert is logged
}

export const DEFAULT_LIMITS: Limits = {
  codeTtlMs: 10 * 60_000, maxAttempts: 5,
  perNumber15m: 3, perNumberDay: 6, perIpHour: 10, perIpDay: 30,
  perCountryDay: { "*": 300, NG: 8000, GB: 1500, US: 1000 },
  globalDay: 12_000, alertAt: 0.8,
};

export function limits(env: AuthEnv): Limits {
  if (!env.AUTH_LIMITS) return DEFAULT_LIMITS;
  try {
    const o = JSON.parse(env.AUTH_LIMITS) as Partial<Limits>;
    return { ...DEFAULT_LIMITS, ...o, perCountryDay: { ...DEFAULT_LIMITS.perCountryDay, ...(o.perCountryDay || {}) } };
  } catch { return DEFAULT_LIMITS; }
}

export const countryCap = (l: Limits, iso: string) => l.perCountryDay[iso] ?? l.perCountryDay["*"];
