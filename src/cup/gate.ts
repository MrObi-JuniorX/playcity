import { DurableObject } from "cloudflare:workers";

/* CupGate: one of 32 shards that hold players' hub connections during a cup (docs/whot-cup-prd.md, section 7):
   "your table is ready", Second Chance offers, the live wallet strip. Gates stay storage-free: everything a gate
   knows lives in socket attachments, so an idle gate hibernates for free (enforced by scripts/cf-lint.sh).
   Phase 0 only declares the class; the behaviour arrives in Phase 7. */
export class CupGate extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response("The cup gate is not built yet", { status: 501 });
  }
}
