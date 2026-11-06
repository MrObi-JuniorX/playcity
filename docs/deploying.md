# Deploying playcity

Two Cloudflare Workers, each fed by its own branch:

| Branch | Worker | Database (D1) | What it's for |
|---|---|---|---|
| `main` | none | none | Where work lands. Feature branches merge here. |
| `staging` | `playcity-staging` | `playcity-staging` | Check a release before players see it; load tests (PRD Phase 10, T4) |
| `production` | `playcity` | `playcity-production` | The live site |

Each Worker has its own database and its own Durable Objects (tables, cups, gates), so nothing done on staging can touch production. The two are `env.staging` and `env.production` in `wrangler.jsonc`; the top level of that file is local development and the tests.

## Shipping a release

1. Merge your work into `main` (a pull request, with the tests green).
2. Open a pull request from `main` into `staging` and merge it. The **Deploy** workflow (`.github/workflows/deploy.yml`) runs every test, applies new database migrations to the staging database, and deploys `playcity-staging`.
3. Check staging.
4. Open a pull request from `staging` into `production` and merge it. The same workflow deploys `playcity`. If the production environment requires an approval (below), the deploy waits for it.

Only merge into `staging` from `main`, and into `production` from `staging`, so production only ever gets what staging already ran.

## One-time setup

**1. A Cloudflare API token.** In the Cloudflare dashboard: My Profile, API Tokens, Create Token, start from the **Edit Cloudflare Workers** template, and add the permission **Account · D1 · Edit**. Note your **Account ID** (Workers & Pages, in the right-hand column).

**2. GitHub environments.** In the repository: Settings, Environments. Create `staging` and `production`, and in each add two secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the same token can serve both). On `production`, tick **Required reviewers** and add yourself, so a production deploy waits for your approval. Until the secrets exist, pushes to these branches still run the tests and skip the deploy with a warning.

**3. Protect the branches.** Settings, Branches: protect `staging` and `production` (changes only through pull requests, with the **Deploy / test** check passing).

**4. The Worker's own secrets**, once per environment (`--env staging`, then `--env production`):

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
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | Optional: TURN for players behind strict networks (walkie-talkie, Flick Football) |

Sign-in also needs an SMS provider, which isn't chosen yet (PRD section 13, question 1). Until one is added, live sign-in says it isn't open yet: the free games work, the cup pages show, and nobody can enter a cup.

**5. The first deploy.** Merge `main` into `staging`. The workflow creates the `playcity-staging` database on its first run, applies every migration, and deploys. Do the same for `production` when staging looks right. Deploying `production` replaces any Worker already called `playcity` in the account.

## When something goes wrong

- **Roll back the code:** `npx wrangler rollback --env production` returns to the previous version at once. Then revert the merge on the `production` branch, so the next deploy doesn't bring it back.
- **Database migrations only go forward.** A rollback doesn't undo one. Write each migration so the code before it still works (add columns and tables; don't rename or drop in the same release).
- **The workflow's database step** (`scripts/ci-d1.mjs`) finds each environment's database by name and fills its id into the deploy's copy of `wrangler.jsonc`. To pin the ids instead, replace `"set-by-deploy"` with the real ids (`npx wrangler d1 list`) and commit.
