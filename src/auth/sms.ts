import { isDev, type AuthEnv } from "./env";

/* Sending sign-in codes (PRD Phase 1). Every sender sits behind this interface, so the provider can change without
   touching sign-in. The real provider is still to be chosen (PRD section 13, question 1); until one is added here,
   live mode has no sender and sign-in answers "not available" rather than pretending to send. */
export interface SmsSender {
  name: string;
  send(e164: string, body: string, phoneHmac: string): Promise<boolean>;
}

/* Dev and tests only: messages go to the dev_sms_outbox table, where the local sign-in page and the tests read them. */
function fakeSender(env: AuthEnv): SmsSender {
  return {
    name: "fake",
    async send(_e164, body, phoneHmac) {
      await env.DB.prepare("INSERT INTO dev_sms_outbox (phone_hmac, body, created_at) VALUES (?, ?, ?)").bind(phoneHmac, body, Date.now()).run();
      return true;
    },
  };
}

export function smsSender(env: AuthEnv): SmsSender | null {
  if (env.SMS_PROVIDER === "fake") return isDev(env) ? fakeSender(env) : null;   // never in live mode
  return null;
}

export const codeMessage = (code: string) => `${code} is your playcity code. It expires in 10 minutes. Never share it with anyone.`;
