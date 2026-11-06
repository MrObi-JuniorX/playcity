// The deploy workflow's database step (docs/deploying.md). Finds the D1 database for an environment, creates it if
// it doesn't exist yet, and writes its id into this checkout's wrangler.jsonc (only in CI; nothing is committed).
//   node scripts/ci-d1.mjs staging | production
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const env = process.argv[2];
if (!["staging", "production"].includes(env)) { console.error("usage: node scripts/ci-d1.mjs staging|production"); process.exit(2); }
const name = `playcity-${env}`;
const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const find = () => JSON.parse(wrangler("d1", "list", "--json")).find(d => d.name === name);

let db = find();
if (!db) { console.log(`Creating the D1 database ${name}.`); wrangler("d1", "create", name); db = find(); }
if (!db?.uuid) { console.error(`Couldn't find or create the D1 database ${name}.`); process.exit(1); }

const file = "wrangler.jsonc", config = readFileSync(file, "utf8");
const needle = `"database_name": "${name}", "database_id": "set-by-deploy"`;
if (config.includes(needle)) writeFileSync(file, config.replace(needle, `"database_name": "${name}", "database_id": "${db.uuid}"`));
else if (!config.includes(db.uuid)) { console.error(`wrangler.jsonc names a different database for ${env}: check its database_id.`); process.exit(1); }
console.log(`${env}: D1 database ${name} (${db.uuid}).`);
