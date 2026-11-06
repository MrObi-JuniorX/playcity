# User management plan (not started)

Saved for later. Nothing here is built yet. Until it is, `/console/` opens with a temporary code (`docs/deploying.md`), and cups can't be entered on a deployed site because players can't sign in.

The migration below takes the next free number, `0009`.


## Context

Sign-in is phone-only today and can't open, because no SMS provider exists. You decided: sign up with Google or any email (a code proves the address, sent through Cloudflare Email), switch phone verification on later, keep sessions active for a month, and let players pick a nickname and an avatar from a collection.

Your answers: email comes from **playcity.ng**, the avatars are an **original SVG set**, and the month counts **from the last visit**.

Facts that shape this:
- `playcity.ng` doesn't resolve today, so live email waits for the domain. Everything is built and tested first with a test sender.
- Live sign-in has never been open, so there are no real players to migrate.

## Data: `migrations/0009_email_google.sql`

SQLite can't drop `NOT NULL`, so `players` is rebuilt (`PRAGMA defer_foreign_keys = true`, copy rows, drop, rename). Six tables reference it, so a test must prove the rebuild keeps rows and references.

- Phone columns become nullable. Multiple NULLs don't break `UNIQUE`.
- New: `email_hmac` UNIQUE, `email_enc`, `email_mask`, `google_sub` UNIQUE, `avatar_id`.
- New `CHECK (phone_hmac IS NOT NULL OR email_hmac IS NOT NULL)`.
- `avatar_shape` and `avatar_color` stay, unused, because `docs/deploying.md` says not to drop columns in the release that stops using them. Remove them in a later release.
- `otp_requests` is reused: `phone_hmac` holds the email's HMAC and `country` is `'@email'`. No renames, for the same reason.

## Server

**`src/auth/email.ts` (new), mirrors `src/auth/sms.ts`.**
- `emailSender(env)`: in live, `env.EMAIL.send({ to, from, subject, text, html })` with `EMAIL_FROM`. In dev, the existing `dev_sms_outbox`. A thrown send becomes `502 email-failed`.
- `normalizeEmail`: trim, lowercase, length and shape check.
- `canonicalEmail`: for Gmail, drop dots and `+tags` and map `googlemail.com` to `gmail.com`, so one Gmail inbox is one player. The HMAC uses this form, purpose `"email"`.

**`src/auth/routes.ts`.**
- Pull the limit checks, code issue and code check out of `start` and `verify` into shared helpers, so phone and email use one code path.
- `POST /api/auth/email/start`: Turnstile; per-address, per-IP and daily caps; same reply whether or not an account exists.
- `POST /api/auth/email/verify`: creates or finds the player, starts a session.
- Phone routes answer only when `AUTH_PHONE=1`. Off by default, on in the test config so existing tests keep their phone sign-in. This keeps the phone code ready; a link-a-number flow for existing accounts is future work.
- `config` gains `email`, `google`, `phone`. `available` means any of them works.
- `view()`: `email` is masked, `phone` is null when absent, `complete` checks `avatar_id`. `PATCH /api/me` takes `avatar: "<id>"`, and refuses `smsCheckin` without a phone.

**`src/auth/google.ts` (new). No new dependency.** Server-side code flow with PKCE:
- `GET /api/auth/google/start?next=`: state, nonce and verifier go in a 10-minute `__Host-pc_o` cookie, then redirect to Google with scopes `openid email`. Not requesting `profile` means we never get their real name or photo.
- `GET /api/auth/google/callback`: check `state`, exchange the code over TLS, check `iss`, `aud`, `exp`, `nonce` and `email_verified`.
- Find the player by `google_sub`, then by email HMAC (attach the sub), else create. A race falls back to re-select through the UNIQUE constraints. Then 302 to `/account/`, keeping a validated `next`; failures go to `/account/?error=google`.
- Secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. The button is hidden until they're set.

**`src/auth/session.ts`: a month since last visit.**
- `SESSION_MS` stays 30 days, and the existing hourly `last_seen_at` write also moves `expires_at` forward, so there are no extra writes.
- The cookie's `Max-Age` becomes 400 days (browser maximum), so the database row alone decides expiry and no response needs to re-set the cookie.
- Sign-out and sign-out-everywhere are unchanged.

**Things that assumed a phone.**
- `src/auth/limits.ts`: add an `@email` daily cap.
- SMS spend cap in `src/auth/routes.ts` and `src/push/notify.ts`: exclude `'@email'` rows, or emails would use up the SMS budget.
- `src/cup/routes.ts`: check `avatar_id`. For `phoneCountries`, use `phone_country`, falling back to `request.cf.country`.
- `src/console/routes.ts`: the staff list shows the masked email when there's no phone.
- `scripts/cf-lint.sh`: extend the no-phone-numbers-in-logs rule to email addresses.

## Avatars

- `src/auth/avatars.ts` (new) is the single source: about 24 original SVG character and animal badges, as id to SVG body.
- Add it to `npm run build`, bundled with esbuild to a gitignored `public/account/avatars.js`, the same way `public/console/cup.js` is built.
- `src/cup/share.ts` draws the avatar from it on share cards, replacing its local shapes and colours.
- Cup tables don't show account avatars today, and this doesn't add that.

## Pages

- `public/account/index.html`:
  - First screen: **Continue with Google**, or an email field with **Email me a code**. The phone form shows only if `cfg.phone`.
  - The code screen is shared and its wording follows the channel.
  - Profile: nickname (rules unchanged, 2–14 characters, not prefilled from Google), a scrollable avatar grid replacing the shape and colour pickers, and the 18+ check.
  - The account card shows the masked email.
  - Also update the meta description and error messages (`email-failed`, `bad-email`, `google`).
- `public/cup/index.html`: "Sign in with your phone" becomes "Sign in"; show the check-in text checkbox only if the player has a phone.
- `public/console/console.js`: "phone sign-in" wording becomes "playcity sign-in".

## Config and docs

- `wrangler.jsonc`: `send_email: [{ name: "EMAIL" }]` and `EMAIL_FROM` under both `env.staging` and `env.production`, since these aren't inherited. Then `npm run types`.
- `.dev.vars.example`, `src/auth/env.ts`: new settings.
- `docs/deploying.md`: replace "sign-in needs an SMS provider" with the Google and email setup.
- `docs/whot-cup-prd.md`: update ID-1, ID-2, ID-3, ID-5, ID-6, the player role, T9, T15 and the data table. Add a checked task group. Record two rules: phone verification must be on **before any cash cup**, and until then, throwaway emails can farm free coins, accepted while coins have no cash value.
- Memory: update `playcity-tournament-design.md` with the new sign-in rules.

## Tests

Only Whot, cup and account code is touched; Flick stays as it is.

- `test/worker/auth.test.ts`, new cases:
  - Email: sign-up and returning sign-in, code expiry, lockout, single use, limits, no account enumeration, Gmail aliases are one player, addresses are stored only encrypted or hashed.
  - Phone routes are off without `AUTH_PHONE`.
  - Google (stubbed `fetch`): success; bad state, nonce or audience; unverified email; same email by code and Google gives one player.
  - Sessions: a visit extends expiry; 30 days away signs out.
  - Bad avatar ids are refused.
- Migration test: rows survive the `players` rebuild.
- Update `avatar` payloads in test files and `test/worker/cupkit.ts`.
- Email-only players can enter a cup; `phoneCountries` falls back to the request's country.
- SMS cap ignores email codes.

## Verification

1. `npm test`, the type check and `npm run lint:cf`.
2. Local run: sign up by email with the dev code, pick a nickname and avatar, check the wallet, enter a cup, view the share card, screenshot at phone width.
3. On staging, once the domain and Google client exist: real Google sign-in, and real codes to Gmail, Outlook and Yahoo, checking the spam folder and delivery time. These two can't be proved locally.

## What you'll need to do

Nothing blocks the build, but going live needs:
1. Register `playcity.ng`, put it on Cloudflare, then `npx wrangler email sending enable playcity.ng`.
2. Create a Google OAuth client with the staging and production callback URLs, then set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` per environment.
3. Create the Turnstile widget (already in `docs/deploying.md`).


