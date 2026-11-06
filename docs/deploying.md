# Deploying playcity

Two Cloudflare Workers, each fed by its own branch:

| Branch | Worker | Database (D1) | What it's for |
|---|---|---|---|
| `main` | none | none | Where work lands. Feature branches merge here. |
| `staging` | `playcity-staging` | `playcity-staging` | Check a release before players see it; load tests (PRD Phase 10, T4) |
| `production` | `playcity` | `playcity-production` | The live site |

Each Worker has its own database and its own Durable Objects (tables, cups, gates), so nothing done on staging can touch production. The two are `env.staging` and `env.production` in `wrangler.jsonc`; the top level of that file is local development and the tests.

## Two ways to deploy

Both run the same steps (type check, cost lint, build, tests, find or create the environment's database, apply its migrations, deploy the Worker), so use whichever suits the moment.

| | From this machine (wrangler) | From GitHub (the Deploy workflow) |
|---|---|---|
| Command | `npm run deploy:staging` or `npm run deploy:production` | Merge into the `staging` or `production` branch, or run the workflow by hand (Actions, Deploy, Run workflow) |
| Signs in with | `npx wrangler login` (once) | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the GitHub environment |
| Good for | Quick deploys, the first deploy, and when GitHub isn't set up | A record of every release, and approval before production |
| Setup | One-time setup 1 | One-time setup 2 to 4, as well |

You don't have to pick one. Two rules keep them from fighting:
- **Deploy a commit you can name.** Whichever way you deploy, the Worker runs what was committed. A deploy from GitHub replaces whatever the last deploy left, so don't deploy uncommitted changes you want to keep.
- **Production deploys from the `production` branch.** `npm run deploy:production` refuses to run from any other branch, or with uncommitted changes, so the live site only ever gets what staging already ran. It also asks you to type `production` first (`--yes` skips the question).

## Shipping a release

1. Merge your work into `main` (a pull request, with the tests green).
2. Merge `main` into `staging`, then deploy staging: push the branch (GitHub deploys it, once set up) or run `npm run deploy:staging` from the `staging` branch.
3. Check staging.
4. Merge `staging` into `production`, then deploy production the same way: push the branch (GitHub waits for your approval if the production environment requires one) or run `npm run deploy:production` from the `production` branch.

Only merge into `staging` from `main`, and into `production` from `staging`.

For a quick check of work that isn't merged yet, `npm run deploy:staging` also works from any branch. It warns you when the tree has uncommitted changes. Options for both commands (add them after `--`, for example `npm run deploy:staging -- --skip-tests`):

| Option | What it does |
|---|---|
| `--skip-tests` | Skips the test suites. Type check, lint and build still run. The Worker tests can time out when the machine is busy, so this is useful then, but not for a release. |
| `--yes` | Doesn't ask for confirmation (production asks by default). |
| `--dry-run` | Prints every step and changes nothing. |

If a step fails, nothing after it runs. Fix the problem and run the same command again: finding the database and applying migrations are safe to repeat. The command puts `wrangler.jsonc` back as it was afterwards, so there's nothing to commit.

## One-time setup

**1. Sign in to Cloudflare from this machine** (what the wrangler commands need):

```bash
npx wrangler login
```

`npx wrangler whoami` shows which account you're on. That's all you need to deploy with `npm run deploy:staging`. Skip to step 4 for the Worker's own secrets.

**2. A Cloudflare API token** (GitHub deploys only). In the Cloudflare dashboard: My Profile, API Tokens, Create Token, start from the **Edit Cloudflare Workers** template, and add the permission **Account · D1 · Edit**. Note your **Account ID** (Workers & Pages, in the right-hand column).

**3. GitHub environments** (GitHub deploys only). In the repository: Settings, Environments. Create `staging` and `production`, and in each add two secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the same token can serve both). On `production`, tick **Required reviewers** and add yourself, so a production deploy waits for your approval. Until the secrets exist, pushes to these branches still run the tests and skip the deploy with a warning.

Also protect the `staging` and `production` branches (Settings, Branches: changes only through pull requests, with the **Deploy / test** check passing).

**4. The Worker's own secrets**, once per environment (`--env staging`, then `--env production`). Do the first deploy first, so the Worker exists. These secrets belong to the Worker, so they work the same however it's deployed:

```bash
openssl rand -base64 32
```

```bash
npx wrangler secret put PHONE_HMAC_KEY --env staging
```

```bash
npx wrangler secret put PHONE_ENC_KEY --env staging
```

`PHONE_HMAC_KEY` and `PHONE_ENC_KEY` each take a fresh value from the `openssl` command, different per environment. Then, the same way:

| Secret | What it is |
|---|---|
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | A Turnstile widget for the site's hostname (Cloudflare dashboard, Turnstile) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | `npm run vapid` prints a pair. Keep each environment's pair for good: a new pair stops every saved notification subscription |
| `OWNER_PLAYER_IDS` | The first console owner's player id (sign in on that environment's site, then read your id on the console's "not on the staff list" screen) |
| `CONSOLE_CODE` | Temporary: the shared code that opens `/console/` as an owner (below) |
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | Optional: TURN for players behind strict networks (walkie-talkie, Flick Football) |

Sign-in also needs an SMS provider, which isn't chosen yet (PRD section 13, question 1). Until one is added, live sign-in says it isn't open yet: the free games work, the cup pages show, and nobody can enter a cup.

**The console code.** Players can't sign in yet (`docs/usermgt.md`), so `/console/` opens with a shared code. This repository is public, so the code lives only in the secret, never in a file here. To set or change it, run the command below and type the code; changing it signs everyone out of the console. To remove it, use `npx wrangler secret delete CONSOLE_CODE --env staging`, and the passkey gate comes back.

```bash
npx wrangler secret put CONSOLE_CODE --env staging
```

Anyone with the code has full owner access, and the audit log records them all as `console-code`. Five wrong tries from one network wait 15 minutes, and 30 wrong tries overall lock the code for up to a day. To clear a lock:

```bash
npx wrangler d1 execute playcity-staging --remote --env staging --command "DELETE FROM console_code_attempts"
```

Cups that need a countersign can't be published through the code, since it counts as one person. The code stops working if `CASH_ENABLED` is `1`, and it must be gone before any cash cup.

**5. The first deploy.** For staging, run `npm run deploy:staging` (or merge `main` into `staging` once GitHub is set up). It creates the `playcity-staging` database, applies every migration, and deploys. Then set the secrets in step 4. Do the same for `production` when staging looks right. Deploying `production` replaces any Worker already called `playcity` in the account.

## When something goes wrong

- **Roll back the code:** `npx wrangler rollback --env production` returns to the previous version at once, whichever way it was deployed. Then revert the merge on the `production` branch, so the next deploy doesn't bring it back.
- **Database migrations only go forward.** A rollback doesn't undo one. Write each migration so the code before it still works (add columns and tables; don't rename or drop in the same release).
- **The database step** (`scripts/ci-d1.mjs`, used by the workflow and by `npm run deploy:*`) finds each environment's database by name and fills its id into the deploy's copy of `wrangler.jsonc`. To pin the ids instead, replace `"set-by-deploy"` with the real ids (`npx wrangler d1 list`) and commit.
