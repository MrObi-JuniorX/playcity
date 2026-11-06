// Deploy an environment from this machine with wrangler (docs/deploying.md). The same steps the Deploy workflow runs
// on GitHub: checks, then the environment's database, its migrations, and the Worker.
//   npm run deploy:staging
//   npm run deploy:production
// Options: --skip-tests  skip the test suites (type check, lint and build still run)
//          --yes         don't ask for confirmation (production asks by default)
//          --dry-run     print the steps and change nothing
// Needs `npx wrangler login`, or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const [env, ...flags] = process.argv.slice(2);
const has = (f) => flags.includes(f);
if (!["staging", "production"].includes(env) || flags.some((f) => !["--skip-tests", "--yes", "--dry-run"].includes(f))) {
  console.error("usage: node scripts/deploy.mjs staging|production [--skip-tests] [--yes] [--dry-run]");
  process.exit(2);
}
const dry = has("--dry-run");
const out = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const step = (title, cmd, args) => {
  console.log(`\n==> ${title}\n    ${[cmd, ...args].join(" ")}`);
  if (!dry) execFileSync(cmd, args, { stdio: "inherit" });
};

const branch = out("git", ["branch", "--show-current"]);
const dirty = out("git", ["status", "--porcelain"]);
const commit = out("git", ["rev-parse", "--short", "HEAD"]);

// Production only ever gets what staging already ran: the `production` branch, committed, nothing left over.
if (env === "production" && !dry) {
  if (branch !== "production") { console.error(`Production deploys from the "production" branch, and this is "${branch}". Merge staging into production first (docs/deploying.md).`); process.exit(1); }
  if (dirty) { console.error("There are uncommitted changes. Commit or stash them first: production deploys exactly what's committed."); process.exit(1); }
}
if (dirty) console.warn(`Warning: uncommitted changes will be deployed too. ${env} is meant to run a commit you can name.`);
console.log(`Deploying ${env} from ${branch} @ ${commit}${dirty ? " (+ uncommitted changes)" : ""}.`);

if (env === "production" && !dry && !has("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('This updates the live site. Type "production" to continue: ');
  rl.close();
  if (answer.trim() !== "production") { console.log("Cancelled."); process.exit(1); }
}

// scripts/ci-d1.mjs writes the database id into wrangler.jsonc for the deploy. Put the file back afterwards,
// however this ends, so nothing is left to commit by accident.
const FILE = "wrangler.jsonc", original = readFileSync(FILE, "utf8");
const restore = () => { if (!dry) writeFileSync(FILE, original); };
process.on("SIGINT", () => { restore(); process.exit(130); });

try {
  step("Type check", "npx", ["tsc", "--noEmit", "-p", "."]);
  step("Cost lint", "npm", ["run", "lint:cf"]);
  step("Build", "npm", ["run", "build"]);
  if (!has("--skip-tests")) step("Tests", "npm", ["test"]);
  step(`Database (find or create playcity-${env})`, "node", ["scripts/ci-d1.mjs", env]);
  step("Database migrations", "npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote", "--env", env]);
  step("Deploy", "npx", ["wrangler", "deploy", "--env", env]);
  console.log(dry ? "\nDry run: nothing was changed." : `\nDone. ${env} is running ${commit}.`);
} catch {
  console.error(`\nStopped: a step failed, so ${env} was not fully deployed. Fix it and run the same command again.`);
  process.exitCode = 1;
} finally {
  restore();
}
