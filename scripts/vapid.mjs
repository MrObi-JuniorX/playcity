// A VAPID key pair for Web Push (docs/whot-cup-prd.md PX-4). Run once per environment, then store both as secrets:
//   npm run vapid
//   wrangler secret put VAPID_PUBLIC_KEY ; wrangler secret put VAPID_PRIVATE_KEY ; wrangler secret put VAPID_SUBJECT
// Keep the pair for good: browsers subscribed with the public key, and a new pair makes every subscription stale.
import { createECDH } from "node:crypto";
const k = createECDH("prime256v1");
k.generateKeys();
console.log(`VAPID_PUBLIC_KEY=${k.getPublicKey().toString("base64url")}`);
console.log(`VAPID_PRIVATE_KEY=${k.getPrivateKey().toString("base64url")}`);
console.log("VAPID_SUBJECT=mailto:<an address push services can reach you at>");
