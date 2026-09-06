# Amex Platinum benefit tracker: implementation plan

Status: draft for approval. No application code exists yet.

V1 scope is deliberately narrow: one individual user, one U.S. Consumer Amex Platinum
card, Plaid Sandbox, Next.js + TypeScript, Supabase, Vercel.

A note before anything else. This document does not contain a single Amex benefit
dollar amount, and that is on purpose. Amex has reworked the Platinum credit lineup
more than once, and a plan that bakes in stale numbers produces a product that lies to
people. The benefit rules get authored from the current terms during M2, reviewed by a
human, and versioned in git. Section 17 covers how.

---

## 1. Product architecture

### The core idea

Everything hangs off one rule: benefit status is *derived*, never *set*. We store
evidence (transactions we saw, credits we saw, things the user told us) and we compute
status from that evidence with a pure function. Nothing in the codebase is allowed to
write "this benefit is used" as a fact.

This falls out of the hardest requirement in the brief: a purchase is not proof of
anything. Refunds happen, credits get clawed back, enrollment gates block credits
silently, and our connection to the bank goes stale without telling us. If status were
a mutable column, every one of those cases would be a bug where the app confidently
shows the wrong thing. As a recompute, they are all the same code path.

### Layers

```
app/                      Next.js App Router
  (marketing)/            public pages
  (app)/                  authenticated UI, React Server Components for reads
  api/
    plaid/link-token      POST, creates a Link token
    plaid/exchange        POST, public_token -> access_token, server only
    plaid/webhook         POST, Plaid-signed, verified before anything else
    cron/*                Vercel Cron targets, CRON_SECRET gated
lib/
  domain/                 pure TypeScript, no I/O, no Date.now(), fully unit tested
    periods.ts            cadence -> [start, end)
    normalize.ts          merchant string cleanup
    match.ts              transaction -> candidate benefits
    score.ts              features -> confidence
    reconcile.ts          purchases <-> statement credits
    state.ts              evidence set -> lifecycle status
  server/                 I/O, server-only import boundary
    plaid/token-vault.ts  the ONLY module that decrypts an access token
    plaid/client.ts       Plaid SDK wrapper, takes an item id, never a raw token
    db/                   Supabase service-role client, always user-scoped
    ai/                   sanitized DTO in, advisory text out, no writes
benefits/                 versioned rule source of truth, YAML, reviewed in git
```

The `lib/domain` directory is the product. It has no dependencies, no network, no
clock. Everything else is plumbing that can be rewritten.

### Runtime

- Reads render server-side. The browser never receives a Plaid token, an item id that
  maps to one, or raw transaction rows for accounts other than the tracked card.
- Writes go through Server Actions or route handlers, both of which re-derive the user
  from the Supabase session cookie. No user id ever arrives from the client.
- Background work runs on Vercel Cron hitting protected route handlers. Vercel Cron is
  at-least-once and its scheduling is approximate, so every job is idempotent and
  every job is safe to run twice in the same minute.

### Jobs

| Job | Cadence | Does |
|---|---|---|
| `sync-transactions` | hourly + on webhook | pull `/transactions/sync`, recompute affected periods |
| `roll-periods` | daily 03:00 ET | open new benefit periods, close expired ones |
| `scan-reminders` | daily 08:00 ET | queue one digest per user who needs one |
| `check-connections` | every 6h | staleness + `/item/get` health, degrade confidence if blind |
| `apply-retention` | daily 04:00 ET | drop raw descriptors and transactions past their window |

### About the attached design reference

The dashboard mock (soft pastel cards, dense stat tiles, small labels) reads well and I
like the card structure for grouping benefits. But the palette and type sizes in that
mock will fail section 18. Pale yellow on cream and 11px uppercase labels are not
usable for the target audience. Take the layout and the calm density; rebuild the
palette against a 7:1 contrast floor and an 18px body minimum.

---

## 2. Database schema

Postgres via Supabase. Money is always `integer` cents. There are no floats in this
schema. Dates that represent a benefit calendar are `date` in America/New_York;
timestamps are `timestamptz`.

### Enums

```sql
create type benefit_cadence as enum
  ('monthly','quarterly','semiannual','calendar_year','cardmember_year','one_time');

create type benefit_status as enum
  ('not_configured','ready','purchase_detected','likely_eligible',
   'credit_pending','credit_confirmed','expired_unused');

create type confidence_level as enum ('confirmed','likely','possible','unknown');

create type evidence_kind as enum
  ('purchase','statement_credit','refund','credit_reversal',
   'user_attestation','user_rejection');

create type item_health as enum
  ('healthy','degraded','auth_required','consent_expired','revoked','disconnected');

create type enrollment_state as enum ('unknown','not_enrolled','enrolled','not_required');
```

### Identity and connection

```sql
profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  timezone text not null default 'America/New_York',
  card_anniversary_month smallint,          -- 1..12, month only. See decision 2.
  notifications_paused boolean not null default false,
  created_at timestamptz not null default now()
)

plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  plaid_item_id text not null unique,
  institution_id text,
  institution_name text,
  sync_cursor text,
  health item_health not null default 'healthy',
  last_successful_sync_at timestamptz,
  consecutive_failures int not null default 0,
  last_error_code text,
  created_at timestamptz not null default now()
)

-- Separate table on purpose. Zero RLS policies, all grants revoked from
-- anon and authenticated. Only the service role touches it, and only via
-- lib/server/plaid/token-vault.ts.
plaid_item_secrets (
  plaid_item_id uuid primary key references plaid_items on delete cascade,
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  wrapped_dek bytea not null,
  key_version smallint not null,
  rotated_at timestamptz not null default now()
)

accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  plaid_item_id uuid not null references plaid_items on delete cascade,
  plaid_account_id text not null unique,
  name text,
  official_name text,
  mask text,                  -- last 4 only, and only because Plaid returns it
  type text, subtype text,
  card_product_key text,      -- 'amex_platinum_consumer_us' in V1
  is_tracked boolean not null default false
)
```

`mask` is the closest thing to a card number anywhere in this system. Full PAN, CVV,
Amex credentials, and SSN are not columns anywhere, and no code path can produce them
because we never request the Plaid products that return them (section 13).

### Transactions

```sql
transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  account_id uuid not null references accounts on delete cascade,
  plaid_transaction_id text not null unique,
  amount_cents integer not null,         -- signed: positive = charge, negative = credit
  iso_currency_code text not null default 'USD',
  posted_date date,
  authorized_date date,
  is_pending boolean not null default false,
  pending_plaid_transaction_id text,
  superseded_by uuid references transactions,
  merchant_name text,
  normalized_merchant text,
  descriptor text,                        -- dropped by retention after 90 days
  descriptor_dropped_at timestamptz,
  pfc_primary text, pfc_detailed text,    -- Plaid personal finance category
  payment_channel text,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
create index on transactions (user_id, account_id, posted_date desc);
create index on transactions (normalized_merchant) where removed_at is null;
```

That is the complete field list. Plaid returns location objects, counterparty
addresses, website, and account owner data. We map an explicit allowlist and drop the
rest at the ingest boundary, before it touches the database.

### Benefits

```sql
-- Human-facing catalog. Versioned, never mutated in place.
benefit_definitions (
  id uuid primary key default gen_random_uuid(),
  key text not null,                       -- stable slug, e.g. 'rideshare_monthly'
  card_product_key text not null,
  version int not null,
  supersedes_id uuid references benefit_definitions,
  display_name text not null,
  plain_summary text not null,             -- our words, not Amex's terms text
  terms_url text not null,
  terms_verified_on date not null,
  cadence benefit_cadence not null,
  allowance_cents integer not null,
  requires_enrollment boolean not null default false,
  enrollment_url text,
  effective_from date not null,
  effective_to date,
  unique (key, version)
)

-- Machine-facing matching config. Separate lifecycle from the catalog because
-- we fix matching bugs far more often than Amex changes terms.
benefit_rules (
  id uuid primary key default gen_random_uuid(),
  benefit_definition_id uuid not null references benefit_definitions,
  version int not null,
  release_id uuid not null references rule_releases,
  match_config jsonb not null,
  credit_config jsonb not null,
  effective_from date not null,
  effective_to date
)

rule_releases (
  id uuid primary key default gen_random_uuid(),
  semver text not null unique,
  git_sha text not null,
  checksum text not null,
  released_at timestamptz not null default now()
)

merchant_patterns (
  id uuid primary key default gen_random_uuid(),
  benefit_rule_id uuid not null references benefit_rules on delete cascade,
  kind text not null,                      -- exact | prefix | regex | pfc | descriptor
  pattern text not null,
  weight numeric(3,2) not null default 0.5
)
```

### Per-user benefit state

```sql
user_benefits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  benefit_definition_id uuid not null references benefit_definitions,
  enrollment enrollment_state not null default 'unknown',
  enrollment_confirmed_at timestamptz,
  muted boolean not null default false,
  unique (user_id, benefit_definition_id)
)

benefit_periods (
  id uuid primary key default gen_random_uuid(),
  user_benefit_id uuid not null references user_benefits on delete cascade,
  benefit_rule_id uuid not null references benefit_rules,   -- pinned at creation
  period_start date not null,
  period_end date not null,                                 -- exclusive
  settles_through date not null,                            -- period_end + grace
  allowance_cents integer not null,
  consumed_cents integer not null default 0,
  status benefit_status not null default 'ready',
  confidence confidence_level not null default 'unknown',
  recomputed_at timestamptz,
  unique (user_benefit_id, period_start)
)

-- Append-only. This is the audit trail that makes every status explainable.
benefit_evidence (
  id uuid primary key default gen_random_uuid(),
  benefit_period_id uuid not null references benefit_periods on delete cascade,
  transaction_id uuid references transactions,      -- null for user attestations
  kind evidence_kind not null,
  amount_cents integer not null,
  score numeric(4,3),
  features jsonb not null default '{}',             -- why we scored it that way
  invalidated_at timestamptz,
  invalidated_reason text,
  created_at timestamptz not null default now()
)

reconciliation_links (
  id uuid primary key default gen_random_uuid(),
  purchase_evidence_id uuid not null references benefit_evidence on delete cascade,
  credit_evidence_id uuid not null references benefit_evidence on delete cascade,
  matched_cents integer not null,
  method text not null,                             -- exact | tolerance | subset | manual
  unique (purchase_evidence_id, credit_evidence_id)
)
```

Evidence is never deleted, only invalidated. When Plaid removes a transaction we set
`invalidated_at` and recompute. The history of what we believed and why survives, which
matters the first time a user says "it told me I used this and I didn't".

### Operational

```sql
reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  benefit_period_id uuid references benefit_periods on delete cascade,
  kind text not null,
  dedupe_key text not null unique,
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  status text not null default 'queued'
)

sync_runs (
  id uuid primary key default gen_random_uuid(),
  plaid_item_id uuid not null references plaid_items on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  added int default 0, modified int default 0, removed int default 0,
  status text, error_code text
)

audit_log (
  id bigserial primary key,
  user_id uuid,
  action text not null,
  subject_type text, subject_id uuid,
  metadata jsonb not null default '{}',   -- ids and counts only, never values
  created_at timestamptz not null default now()
)

deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  state text not null default 'pending'
)
```

---

## 3. Plaid connection flow

### Happy path

1. User signs in with Supabase Auth. Session cookie is httpOnly, secure, SameSite=Lax.
2. Browser calls `POST /api/plaid/link-token`. The server builds the token with
   `user.client_user_id` set to a per-user opaque id (an HMAC of the Supabase user id,
   not the id itself and never the email), `products: ['transactions']`,
   `country_codes: ['US']`, `language: 'en'`, a webhook URL, and an allowlisted
   `redirect_uri`. Response contains the link token and nothing else.
3. Plaid Link opens in the browser (`react-plaid-link`). On success it hands back a
   `public_token` plus institution and account metadata.
4. Browser POSTs the `public_token` to `/api/plaid/exchange`. The server exchanges it
   for the permanent `access_token` and `item_id`, encrypts the token, writes
   `plaid_items` + `plaid_item_secrets`, and returns only the item row id and a list of
   accounts (name, mask, subtype). The public token is single-use and short-lived, so
   it touching the browser is fine. The access token never does.
5. Server calls `/accounts/get` and stores accounts. The user picks which one is the
   Platinum card. V1 accepts exactly one, and the picker only offers accounts with
   `type = 'credit'`. Everything else is filtered out server-side.
6. Server enqueues an initial `/transactions/sync` backfill and shows a progress state.
   Backfill takes seconds in sandbox and can take minutes in production, so the UI
   needs a real "we are still fetching your history" state, not a spinner.

### Repair path (update mode)

When an item goes to `auth_required`, the server creates a link token with the existing
`access_token` set. Link opens in update mode, the user re-authenticates, and the same
access token becomes valid again. No new exchange, no new item row.

### Sandbox specifics

Default sandbox transactions will not contain Amex-shaped statement credits, so the
matching and reconciliation engines would have nothing to work on. Use
`/sandbox/public_token/create` with `options.override_username = 'user_custom'` and a
custom user JSON fixture that we author: purchases at the target merchants, statement
credits with realistic descriptors, a partial credit, a merchant refund, a credit
reversal, and a pending-to-posted transition. That fixture set is a first-class
deliverable, not test scaffolding. In sandbox the institution choice is cosmetic; the
custom user JSON determines the data.

Use `/sandbox/item/fire_webhook` to exercise the webhook handler, and
`/sandbox/item/reset_login` to exercise the repair path.

---

## 4. Transaction ingestion

### Mechanism

`/transactions/sync` only. Never `/transactions/get`. The cursor lives on
`plaid_items.sync_cursor` and is only advanced after the batch it describes is durably
committed. If a batch write fails, the cursor stays put and the next run redoes it,
which is safe because every write is an upsert.

Loop while `has_more`. Each page gives `added`, `modified`, `removed`.

### Handling each kind

- `added` / `modified`: upsert on `plaid_transaction_id`. Map through the field
  allowlist. Recompute any benefit period whose window contains the transaction date.
- `removed`: set `removed_at`, invalidate any evidence pointing at it, recompute.
  Never hard-delete, because a removed transaction that reappears is a real Plaid
  behavior and we want the history.
- Pending to posted: the posted transaction carries `pending_transaction_id`. Set
  `superseded_by` on the pending row and treat only the posted row as live evidence.
  Amounts routinely change between pending and posted (tips, holds), which is why we do
  not promote confidence on pending data.

### Sign convention

Plaid returns positive amounts for charges on a credit card and negative for payments
and credits. We keep that convention and store signed cents. The normalizer asserts it
on ingest, because a sign flip would silently turn every purchase into a credit and
mark every benefit confirmed. That assertion is worth its cost.

### Triggers

- Webhook `SYNC_UPDATES_AVAILABLE` fires a sync. Verified first (section 12).
- Hourly cron as a fallback, because webhooks get dropped and a missed webhook means a
  user sees stale data with no indication anything is wrong.
- Manual "refresh now" button, rate limited to once per five minutes per item.

### Scope filter

Only transactions on the tracked card account are retained. Transactions on other
accounts inside the same item are dropped at the ingest boundary and never written.
This is a data minimization control, not a performance one (section 13).

---

## 5. Benefit matching

For each live transaction on the tracked card:

**Step 1, gate.** Positive amount (charges only), not superseded, not removed, and the
posted date falls inside an open benefit period. Fail any of these and we stop.

**Step 2, normalize.** Uppercase, strip punctuation and diacritics, collapse
whitespace, strip trailing store and location numbers (`#1234`, ` 0042`), strip
aggregator prefixes (`SQ *`, `TST*`, `PY *`, `PAYPAL *`, `AMZN MKTP`), strip trailing
state and city tokens. The output is `normalized_merchant`, stored so rule changes can
be replayed without re-parsing.

**Step 3, generate candidates.** Match against `merchant_patterns` in precedence order:
exact merchant, descriptor prefix, regex, Plaid personal finance category. Category-only
matches are candidates but weak ones, and category alone can never carry a benefit past
`possible`.

**Step 4, apply amount and shape predicates.** A monthly subscription benefit whose
allowance is a fixed amount expects a charge at or near that amount on a roughly monthly
rhythm. A capped spend benefit expects anything up to the cap. These predicates live in
`match_config` per rule, not in code.

**Step 5, score.** Section 7.

**Step 6, emit evidence.** Write `benefit_evidence(kind='purchase')` with the score and
the full feature vector that produced it. Recompute the period.

### Ambiguity

One transaction can be a candidate for more than one benefit. Rules declare
`exclusive_group` keys; within a group we keep every candidate but the recompute
allocates the transaction to at most one, and the UI surfaces a one-tap disambiguation
("was this ride or was this food delivery?"). We do not guess and we do not double-count.
A wrong guess here is worse than a question, because a wrong guess quietly inflates
progress on a benefit the user then loses.

### The enrollment gate

Several Platinum credits pay out only if the cardholder enrolled first, and enrollment
is invisible to Plaid. If `user_benefits.enrollment` is `not_enrolled` or `unknown` for
a benefit that requires it, the benefit sits at `not_configured` and matching produces
evidence but no status promotion. The UI's job there is not a progress bar, it is a
button that says "enroll on amex.com" with the deep link.

### The rule that governs all of this

A detected purchase never produces `credit_confirmed`. The ceiling for purchase-only
evidence is `likely_eligible`. There is a unit test asserting this and it is not allowed
to be deleted.

---

## 6. Statement-credit reconciliation

Statement credits show up as negative-amount transactions on the same card, usually with
a descriptor that names the benefit or says something generic about a credit, and
usually days to weeks after the purchase.

### Classification

A negative transaction is one of three things and we must tell them apart:

| | Merchant | Amount | Descriptor |
|---|---|---|---|
| Statement credit | often the issuer or the benefit brand | matches the benefit allowance or the purchase | credit-ish tokens |
| Merchant refund | same as the original purchase | matches the original purchase exactly | merchant name |
| Payment | none | large, round-ish | payment tokens |

Rule order: payment tokens first (drop), then merchant refund (same normalized merchant
as an unreconciled purchase and the same amount to the cent, and it is a refund), then
statement credit. Getting this order wrong means a refund reads as a credit and the app
tells someone they used a benefit they actually undid.

### Matching

Within a benefit period plus its settling window:

1. Exact amount match against unreconciled purchase evidence. Greedy, oldest first.
2. Tolerance match (within a few cents, for rounding and partial captures).
3. Subset-sum: one credit covering several small purchases, bounded to a small number of
   purchases so it stays fast and stays explainable.
4. Anything left over is an unlinked credit.

Deterministic tie-breaks (date, then amount, then transaction id) so the same inputs
always produce the same links. Non-determinism here would make the UI flicker between
explanations across recomputes.

### Unlinked credits

If a credit arrives and we cannot tie it to a purchase we saw, we still count the
dollars against the allowance. We confirm *consumption*, and separately mark the
*explanation* as low confidence. This distinction matters: the money is real evidence,
our story about which purchase caused it is a guess.

### Partial consumption

Allowance and consumption are independent integers. A benefit can be partly consumed,
and the UI says "you have $X of $Y left" rather than a binary used/unused. That is the
whole product in a lot of cases.

### Status transitions

- Credit-shaped negative transaction, still pending: `credit_pending`.
- Posted and reconciled: `credit_confirmed`, confidence `confirmed`.
- Period ended, settling window elapsed, nothing consumed: `expired_unused`.

---

## 7. Confidence scoring

Weighted linear score, no machine learning, fully auditable. Every score is stored with
the feature vector that produced it so the UI can render "here is why we think this".

### Features and weights (starting values, to be calibrated)

| Feature | Weight |
|---|---|
| Exact merchant match | +0.50 |
| Descriptor prefix match | +0.35 |
| Regex match | +0.30 |
| Category-only match | +0.10 |
| Amount fits the benefit shape | +0.15 |
| Transaction posted, not pending | +0.10 |
| Enrollment confirmed | +0.10 |
| Linked statement credit, pending | +0.30 |
| Linked statement credit, posted | +0.50 |
| Connection stale beyond threshold | -0.20 |
| Prior user rejection on this merchant | -0.40 |

### Buckets

- `confirmed`: a posted, reconciled statement credit exists. Score alone cannot get here.
- `likely`: score >= 0.60.
- `possible`: score >= 0.35.
- `unknown`: below 0.35, or the connection is unhealthy, or we have no signal.

### Hard rules that override the score

1. Posted reconciled credit implies `confirmed`, always.
2. User attestation ("I used this") implies at most `likely`, labeled in the UI as
   self-reported, never rendered as if we verified it.
3. User rejection ("this was not the benefit") implies `unknown` and suppresses that
   merchant for that benefit going forward.
4. Purchase-only evidence caps at `likely`, no matter how many features fire.
5. Item health not `healthy` freezes upward promotion entirely. If we are blind, we do
   not get more confident.

### Calibration

Hand-label the sandbox fixture corpus, run the scorer against it in CI, and track
precision on `confirmed` and `likely` separately. The metric that matters is false
`confirmed` rate, and the target is zero. Recall can be mediocre in V1; telling someone
"we are not sure" is a fine outcome. Telling them "you used it" when they did not is the
failure that loses the user.

---

## 8. Refund and reversal handling

Every one of these is the same operation: mutate evidence, then recompute the period
from scratch. The recompute is pure, idempotent, and order-independent, which is what
makes this section short.

| Event | Handling |
|---|---|
| Plaid `removed` | soft-delete transaction, invalidate its evidence, recompute |
| Pending amount changed on posting | supersede pending, re-evaluate posted, recompute |
| Merchant refund | new evidence `kind='refund'`, decrements consumed for the linked purchase, status can walk backwards |
| Credit reversal (Amex claws back a credit) | positive transaction with reversal descriptor, `kind='credit_reversal'`, unlinks the reconciliation, decrements consumed |
| Duplicate transaction from Plaid | upsert on `plaid_transaction_id` makes this a no-op |
| Late credit after period end | reconciles into the period if within `settles_through` |
| Late credit after settling window | recorded as unlinked, surfaced in the UI, does not resurrect a closed period |

Status walking backwards is a supported, tested transition, not an error state. The UI
handles it with an explicit note ("this credit was reversed on September 12") rather
than silently changing a number, because a number that changes without explanation is
how people lose trust in a financial tool.

---

## 9. Benefit expiration and reset logic

### Period generation

Pure function: `(cadence, anchor, timezone, asOf) -> { start, end, settlesThrough }`.
No I/O, no ambient clock. Half the bugs in a system like this are date bugs, and they
are only findable if dates are a value you can pass in.

- `monthly`: calendar month in America/New_York.
- `quarterly`: calendar quarter.
- `semiannual`: Jan 1 to Jun 30, Jul 1 to Dec 31.
- `calendar_year`: Jan 1 to Dec 31.
- `cardmember_year`: anniversary month to anniversary month. Requires the card
  anniversary, which Plaid does not give us. See decision 2.
- `one_time`: opens once, never resets.

### Settling window

`settles_through = period_end + grace`, default 45 days. Between `period_end` and
`settles_through` the period is closed for new purchases but still open for incoming
credits. A December purchase whose credit posts in January belongs to December, and
without this window it would either be lost or misattributed to January.

### Rollover job

Nightly. For every active `user_benefit`, ensure the current period exists and open the
next one when the boundary passes. Pin `benefit_rule_id` at creation so a rule change
never retroactively rewrites a closed period. Mark periods past `settles_through` with
zero consumption as `expired_unused`, which is what feeds the "you lost $X last year"
retrospective. That number, honestly computed, is probably the most motivating thing
this product can show someone.

### Edge cases

- Rule version changes mid-period: the open period keeps its pinned rule. The new
  version applies from the next period.
- User enrolls mid-period: the current period unlocks immediately, prorated only if the
  benefit terms prorate, which most do not.
- Unused allowance never rolls over. If Amex ever ships one that does, that becomes a
  cadence variant, not a special case in the recompute.

---

## 10. Reminder system

Email only in V1. Push and SMS are post-MVP.

### Schedule

Per-cadence defaults, overridable per definition:

- Monthly: day 20 and day 27 if the benefit is unconsumed.
- Quarterly: 21 days and 7 days before period end.
- Annual: 60, 30, and 7 days before period end.
- One reminder when a period expires unused, framed as a retrospective, not a scold.

### Rules

- One digest email per user per day, maximum. Never one email per benefit. A user with
  twelve tracked benefits should never get twelve emails, and that is the single most
  likely way to make someone unsubscribe.
- Delivery at 9am in the user's timezone. No sends between 9pm and 8am.
- `dedupe_key` on `(user_id, benefit_period_id, kind)` with a unique index. Cron is
  at-least-once, so idempotency is enforced by the database, not by hoping.
- Suppressed when confidence is `confirmed`, the benefit is muted, notifications are
  paused globally, or the connection is unhealthy. That last one matters: emailing "you
  have not used this" while we cannot see the account is telling someone something we
  do not know.

### Copy rules

Never assert usage. "We have not seen a credit for this yet" is true; "you have not used
this" is a claim we cannot support. Every email includes the confidence state in plain
words, a one-click mute for that benefit, and an unsubscribe. No urgency manipulation,
no countdown timers, no red badges. The deadline is real, and stating it plainly is
enough.

---

## 11. Connection-health monitoring

### States

`healthy` -> `degraded` (no successful sync in 36h) -> `auth_required`
(`ITEM_LOGIN_REQUIRED`) / `consent_expired` (`PENDING_EXPIRATION`, mostly a non-US
concern but handled) / `revoked` (`USER_PERMISSION_REVOKED`) -> `disconnected` (user
action or `/item/remove`).

### Detection

- Webhooks: `ERROR`, `PENDING_EXPIRATION`, `USER_PERMISSION_REVOKED`,
  `NEW_ACCOUNTS_AVAILABLE`.
- Staleness check every 6 hours against `last_successful_sync_at`.
- `/item/get` for authoritative status when we suspect a problem.
- `consecutive_failures` with exponential backoff and jitter, circuit-breaking after
  five failures so we stop hammering Plaid and start telling the user instead.

### The honesty requirement

This is the part most apps get wrong. When the connection is stale, the confidence
system must degrade, because "no purchase detected" and "we cannot see your account"
look identical in the UI and mean opposite things. Concretely:

- Item not `healthy` freezes all upward confidence promotion.
- Every benefit card shows a "data may be incomplete since September 2" note.
- Reminders are suppressed.
- The banner states the consequence in plain language, not an error code, with a
  Reconnect button that runs Link update mode.

---

## 12. Security and privacy threat model

### Assets, ranked

1. Plaid access tokens (a stolen token reads the user's full transaction history).
2. Transaction history (highly revealing personal data).
3. Session cookies.
4. Email address.

### Threats and controls

| Threat | Control |
|---|---|
| Token leaks through logs or an error object | single decryption module; redacting logger with an explicit allowlist; a CI test that greps build output and log fixtures for token-shaped strings; tokens excluded from every error path by type |
| Token leaks to the browser | token type only exists in `server-only` modules; `import 'server-only'` at the top of the vault; a CI check that scans the client bundle for the env var name and the token prefix |
| Token sent to an AI model | the AI layer's input type is a sanitized DTO with no token field and no transaction descriptors. This is a compile-time guarantee, not a code review convention |
| Database dump | tokens are encrypted with a key held in Vercel, not in the database. A Postgres dump alone is not enough to impersonate the user at Plaid |
| Spoofed or replayed webhook | verify the `plaid-verification` JWT (ES256) against the key from `/webhook_verification_key/get`, check `iat` within 5 minutes, and compare the `request_body_sha256` claim against a SHA-256 of the raw request body. Reject before parsing anything |
| Cross-tenant data leak | RLS deny-by-default on every table; service-role queries always carry an explicit `user_id` predicate; a test suite that authenticates as user A and asserts zero rows of user B across every table |
| Session hijack | httpOnly, secure, SameSite=Lax cookies; short-lived JWTs with refresh rotation; re-auth required before disconnect or delete |
| Open redirect / SSRF via OAuth redirect | `redirect_uri` allowlisted server-side against an exact-match list |
| Prompt injection via merchant names | merchant strings are attacker-controlled (anyone can name a business anything). They are sanitized before reaching the AI layer, and AI output can never trigger a write. It renders as advisory text, full stop |
| Cron endpoint abuse | `CRON_SECRET` bearer check, constant-time compare, no side effects on failure |
| Supply chain | pinned lockfile, `npm audit` and gitleaks in CI, no runtime remote code execution |
| Insider access | no admin UI over user transactions in V1. If someone needs to debug, they get ids and counts from `audit_log`, not values |

### Never collected, restated

Full card number, CVV, Amex username or password, SSN, home or billing address. The
control that guarantees this is not a policy document, it is product scope: we request
only the Plaid `transactions` product. We never request `identity` (names, addresses,
phones), `auth` (account and routing numbers), or `liabilities`. Those fields never
arrive, so they cannot be stored.

### V1 non-goals

No multi-user accounts, no sharing, no raw transaction export, no third-party analytics
carrying user data.

---

## 13. Data minimization

Practices, in descending order of how much they actually protect people:

1. **Product scope.** Only `transactions`. This eliminates whole categories of sensitive
   data at the source.
2. **Account scope.** Only the tracked card. Other accounts inside the same Plaid item
   are dropped at the ingest boundary and never written to disk.
3. **Field allowlist.** An explicit mapper. Plaid's response shape can grow; our schema
   cannot grow by accident. Location, counterparty addresses, and account owner are
   dropped.
4. **Descriptor retention.** Raw `descriptor` is dropped after 90 days once the period
   it belongs to has settled. `normalized_merchant` survives so rules can be replayed.
5. **Transaction retention.** Rolling 13 months, which covers every annual benefit plus
   a comparison year. Older rows are deleted; the derived `benefit_evidence` amounts and
   the period aggregates survive. History of what you got stays. The itemized record of
   where you shopped does not.
6. **Logs.** Structured, redacting, allowlist-based. Ids and counts, never values. Log
   retention capped at 30 days.
7. **Analytics.** Pageview-level only, no user-identified events, no transaction data.

The retention job runs daily and is idempotent. It is also the job most likely to have a
bug that deletes something it should not, so it runs against a dry-run assertion in
staging first and logs a count before every destructive statement.

---

## 14. Supabase Row Level Security

### Baseline

RLS enabled on every table in `public`. No exceptions, including reference tables.
Default deny: if no policy matches, nothing is returned.

Be precise about one thing: the `service_role` key bypasses RLS entirely, by design. RLS
protects the `anon` and `authenticated` paths. The service role is a separate privileged
path whose safety comes from code review and explicit `user_id` predicates, not from the
database. Any plan that treats RLS as protection against a server-side bug is wrong.

### Policy shapes

```sql
alter table transactions enable row level security;

create policy "own rows readable"
  on transactions for select to authenticated
  using (user_id = (select auth.uid()));
-- No insert/update/delete policies. Only the service role writes transactions.
```

`(select auth.uid())` rather than bare `auth.uid()` so the planner treats it as a scalar
and the `user_id` index gets used. Every table with a `user_id` gets an index on it.

| Table | authenticated can |
|---|---|
| `profiles` | select, update own row (limited columns) |
| `plaid_items` | select own (never the secrets table) |
| `plaid_item_secrets` | nothing. All grants revoked from anon and authenticated |
| `accounts`, `transactions`, `benefit_periods`, `benefit_evidence` | select own only |
| `user_benefits` | select own, update own (enrollment, muted) |
| `reminders` | select own, update own (mute) |
| `benefit_definitions`, `benefit_rules`, `merchant_patterns`, `rule_releases` | select all, no writes |
| `audit_log`, `sync_runs`, `deletion_requests` | nothing |

### Verification

A test suite that runs as user A, as user B, and as anon, asserting exactly which rows
each can see across every table. It runs in CI on every PR, and adding a table without
adding it to that suite fails the build. RLS that is not tested is RLS that is not
there.

---

## 15. Plaid access-token security

### At rest

Envelope encryption. A random 256-bit data key per item encrypts the token with
AES-256-GCM; the data key is wrapped by a key encryption key held in Vercel env
(`TOKEN_ENCRYPTION_KEY`, 32 bytes, base64). We store ciphertext, IV, auth tag, wrapped
DEK, and a key version.

The alternative is Supabase Vault (pgsodium), which keeps key material with the database
provider. I recommend app-layer envelope encryption instead, specifically because it
splits the blast radius: a Supabase compromise yields ciphertext, and a Vercel env
compromise yields a key with no data. Vault collapses those two into one. This is
decision 1.

### In memory and in transit

- `lib/server/plaid/token-vault.ts` is the only module that calls `decrypt`. Enforced
  with an ESLint `no-restricted-imports` boundary and a CI check.
- `lib/server/plaid/client.ts` takes a `plaid_item_id`, resolves the token internally,
  and returns Plaid responses. No function outside the vault ever has a token in a
  variable that outlives a single call.
- The token type is branded and declared in a `server-only` module, so importing it into
  anything reachable from a `'use client'` file is a build error.

### Never appears in

- Browser JS: enforced by `server-only` plus a build-output scan in CI.
- Logs: the logger redacts by key name and by value shape (Plaid tokens have recognizable
  prefixes), plus a test that runs a full sync with a capturing logger and asserts the
  captured output contains no token.
- AI prompts: the AI layer accepts one sanitized DTO type. It has no token field. There
  is no code path from a token to that type.
- Error responses: route handlers return coded errors, never raw exception messages.

### Rotation

- Token rotation: `/item/access_token/invalidate` issues a new token without user
  re-auth. Runbook plus an optional quarterly cron.
- Key rotation: `key_version` supports dual-read. Rotate by adding version N+1,
  re-wrapping every DEK in a background job, then removing version N.

---

## 16. Account disconnect and data deletion

Two separate actions, and conflating them is a dark pattern.

### Disconnect bank

Stops syncing, keeps history. Calls `/item/remove` (which invalidates the access token at
Plaid), deletes the row in `plaid_item_secrets`, sets the item to `disconnected`.
Existing benefit history stays visible and read-only. The UI is explicit that no new
transactions will arrive.

### Delete everything

1. Re-authenticate.
2. Confirm by typing a phrase. No pre-checked boxes, no "are you sure?" with a
   pre-selected Cancel.
3. Write a `deletion_request`, invalidate all sessions, stop all jobs for the user.
4. Call `/item/remove` for every item.
5. Hard delete: cascade from `profiles`, then delete the `auth.users` row. Runs within
   24 hours, and immediately in practice.
6. Email confirmation, sent before the address is removed.
7. Write an `audit_log` row containing a hashed user id and timestamps, no PII.

No 30-day grace period by default. A grace period keeps the data alive, which
contradicts the promise the button makes. If someone wants an undo, the honest version
is an export before deleting, not a hidden retention window.

Backups get stated truthfully in the privacy copy: live data is gone immediately,
encrypted backups roll off on their own schedule. Claiming instant erasure from backups
would be a lie, and people notice.

---

## 17. Versioned Amex benefit rules

### Source of truth is git

Rules live in `benefits/*.yaml`, reviewed as code, released with a semver manifest, and
seeded into the database by migration. The database is a cache. This gets us diffs,
review, blame, and rollback, none of which a rules-in-a-table-edited-by-hand approach
provides.

```yaml
key: rideshare_monthly
card_product_key: amex_platinum_consumer_us
version: 3
display_name: Monthly rideshare credit
plain_summary: >
  A monthly credit that applies to rides with the covered rideshare service.
  Amount and covered services come from the current card terms.
terms_url: https://www.americanexpress.com/...
terms_verified_on: 2026-09-06
cadence: monthly
allowance_cents: 0        # AUTHORED FROM CURRENT TERMS AT M2. Not guessed.
requires_enrollment: false
match:
  exclusive_group: rideshare
  patterns:
    - { kind: exact,  pattern: "UBER",       weight: 0.50 }
    - { kind: prefix, pattern: "UBER TRIP",  weight: 0.50 }
    - { kind: pfc,    pattern: "TRANSPORTATION_TAXIS_AND_RIDE_SHARES", weight: 0.10 }
credit:
  descriptor_tokens: ["UBER CASH", "STATEMENT CREDIT"]
  max_lag_days: 60
```

### Immutability

A released rule is never edited in place. Changes create a new version with an
`effective_from` date and set `effective_to` on the predecessor. `benefit_periods` pin
`benefit_rule_id` at creation, so a closed period is always explainable under the rules
that were live when it ran.

New versions apply to periods starting on or after their effective date. Retroactive
recomputation of closed periods happens only through an explicit command that prints a
dry-run diff first.

### Staleness

`terms_verified_on` is required. An ops view flags any definition unverified for more
than 180 days. Amex changes these terms without warning and a benefit tracker running on
last year's rules is worse than no tracker, because it is confidently wrong.

We ship a short factual summary and a link, not Amex's terms text. Their terms are their
copy. The app also carries a clear "not affiliated with or endorsed by American Express"
disclaimer.

### Product keys

"Platinum" covers consumer, business, and several legacy variants with genuinely
different benefits. Every definition is scoped to a `card_product_key`. V1 supports
`amex_platinum_consumer_us` and refuses to guess for anything else, showing an
unsupported-card message instead of approximating.

---

## 18. Accessibility for users age 70+

WCAG 2.2 AA is the floor, not the goal. Specifics that actually matter for this
audience:

### Type and color

- Body text 18px minimum, 20px preferred. Nothing below 16px anywhere, legal footers
  included. All sizing in `rem`, and the layout survives 200% browser zoom with no
  horizontal scrolling.
- Contrast 7:1 for body text (AAA), 4.5:1 minimum for everything else including
  placeholders, disabled states, and chart labels.
- Never encode meaning in color alone. Confidence states get a word, not just a hue.

### Targets and interaction

- 48x48px minimum touch targets, 12px apart.
- No hover-only affordances. No icon-only buttons; every icon has a visible text label.
- One primary action per screen.
- Nothing disappears on a timer. No toasts, no auto-advancing carousels, no session
  timeout that dumps unsaved state.
- `prefers-reduced-motion` respected. No parallax, no decorative animation.

### Language

- "You have $15 left to spend on rides this month, and it expires September 30."
  Not "Rideshare: $15 remaining allowance, expires 9/30."
- Dates written out. Currency written in full. No jargon, no abbreviations, no acronyms
  without expansion on first use.
- Error messages say what happened and what to do next. A code alone is never shown.

### Keyboard and screen reader

- Full keyboard operability, logical tab order, 3px high-contrast focus ring, skip link.
- Semantic landmarks and headings. `aria-live="polite"` for async status changes. Form
  errors tied to inputs with `aria-describedby`. Native HTML wherever it exists,
  because native elements come with correct semantics for free.

### The Plaid Link problem

Link is a third-party iframe and we do not control its accessibility. Test it with
VoiceOver and NVDA early, because if it is unusable the whole product is unusable for
part of the audience. Build a "having trouble connecting?" path with printable
step-by-step instructions and a way to get help from a family member.

### No dark patterns

Disconnect and delete are as easy to find as connect. No confirmshaming copy, no
pre-checked marketing consent, no reminder emails engineered around urgency.

### Testing

`axe-core` in CI on every route, manual VoiceOver and NVDA passes, and one moderated
session with an actual user over 70 before launch. The automated tools catch maybe 30%
of real problems; the session catches the ones that matter.

---

## 19. Testing strategy

### Unit tests (the bulk of the value)

Everything in `lib/domain` is pure and tested exhaustively: period generation across
year boundaries, leap years, and DST; merchant normalization against a corpus of real
descriptor shapes; scoring; reconciliation; the state machine.

Property-based tests with `fast-check` for the invariants that must never break:

- `consumed_cents` never exceeds `allowance_cents`.
- Recompute is idempotent: `f(f(x)) == f(x)`.
- Recompute is order-independent: shuffling the evidence input gives the same output.
- Purchase-only evidence never yields `credit_confirmed`, for any input.
- Applying a refund then recomputing gives the same result as recomputing without the
  refunded purchase.

### Golden fixtures

A corpus of synthetic transaction sets per benefit with hand-labeled expected outcomes.
This is the most valuable test asset in the project. Every bug found in production or
sandbox becomes a new fixture, permanently.

### Integration

Against Plaid Sandbox with the custom user JSON: full `/transactions/sync` loop with
pagination, webhook delivery via `/sandbox/item/fire_webhook`, the repair path via
`/sandbox/item/reset_login`. Runs nightly rather than per-PR, because Plaid rate limits
and a flaky third party should not block merges.

### Database

RLS policy tests as described in section 14. Migration tests that run up and down.

### End to end

Playwright: connect, select card, view benefits, disambiguate a transaction, mute a
reminder, disconnect, delete. Plus `axe` assertions on every route in the same run.

### Security

- No token in the client bundle (grep the build output).
- No token in logs (capturing logger over a full sync).
- Webhook handler rejects unsigned, wrongly signed, and replayed requests.
- Cross-user reads return zero rows.

### CI gates

Typecheck, lint, unit, property, RLS, a11y, `gitleaks`, `npm audit`. Nightly adds the
Plaid sandbox integration suite.

### Time

The domain layer never calls `Date.now()`. A clock is injected. This is non-negotiable
and it is the single decision that makes the date logic testable.

---

## 20. MVP milestones

**M0, foundation.** Next.js + TS scaffold, Supabase project, auth, full schema and RLS
with the policy test suite, CI pipeline, logging and redaction, secrets handling.
Exit: a signed-in user sees an empty dashboard and the RLS suite is green.

**M1, connect and ingest.** Link token, exchange, token vault, `/transactions/sync`,
webhook with verification, sandbox custom user fixtures, raw transaction list in a debug
view. Exit: sandbox transactions land in Postgres and the token never appears anywhere it
should not.

**M2, benefit engine.** Author the rule set from current Amex terms (human review
required), period generation, matching, state machine, the main benefit dashboard. Start
with a subset of benefits that produce clean matchable credits rather than all of them.
Exit: benefits show `ready` / `purchase_detected` / `likely_eligible` correctly against
the fixture corpus.

**M3, reconciliation and confidence.** Credit classification, matching, partial
consumption, refund and reversal handling, confidence scoring, the "why do you think
this?" explanation UI. Exit: zero false `confirmed` across the fixture corpus.

**M4, reminders and connection health.** Digest email, scheduling, dedupe, mute, health
states, degradation of confidence when blind, reconnect flow. Exit: a stale connection
visibly and correctly suppresses both confidence and email.

**M5, privacy operations.** Disconnect, delete, retention job, export. Exit: a full
delete leaves nothing behind, verified by query.

**M6, accessibility and polish.** Full a11y pass, plain-language copy rewrite, the
moderated session with a user over 70, fixes from it. Exit: axe clean, and a real person
completes connect-to-understand without help.

**Post-MVP.** AI advisory layer over the sanitized DTO, Plaid production access (which
requires a company profile and a security review, so start that paperwork during M4 if
production is the goal), additional card products, push notifications.

---

## DECISIONS REQUIRED BEFORE CODING

1. **Encryption key custody.** App-layer envelope encryption with the KEK in Vercel env,
   or Supabase Vault? I recommend app-layer, because it keeps a database compromise and a
   platform-env compromise as two separate events rather than one.

2. **Card anniversary date.** Some benefits reset on the cardmember year, and Plaid does
   not expose the card open date. Do we ask the user for their anniversary month once
   (month only, no day, for minimization), or treat everything as calendar-based in V1
   and accept that anniversary-based benefits will be wrong?

3. **Which benefits ship in M2.** I want to start with the ones that produce clean,
   matchable statement credits and skip the messy ones (anything requiring an airline
   selection, or where only certain incidental charges qualify). Give me the list you
   want, or approve "clean ones first, messy ones in M3."

4. **Current benefit terms.** Someone has to sit with the live Amex Platinum terms page
   and author the rule set: cadences, amounts, enrollment requirements, covered
   merchants. I am not going to guess these from memory. Who does this, and when?

5. **Manual "I used this" attestation.** Do we let users mark a benefit used by hand? I
   say yes, stored as attestation evidence and visibly labeled self-reported, capped at
   `likely` confidence. It is the pressure-release valve for every matching failure.

6. **Enrollment tracking.** Plaid cannot see whether someone enrolled in a gated benefit.
   V1 plan is a manual checkbox plus a deep link to amex.com. Acceptable, or do you want
   to attempt inference from credit behavior (slower, and wrong sometimes)?

7. **Deletion grace period.** Immediate hard delete (my recommendation) or a 30-day
   recoverable window? The 30-day version is friendlier and contradicts the promise.

8. **Auth method.** Magic link or email plus password? Magic link is more secure and has
   no password to forget, but it makes people switch to their email app mid-flow, which
   is a real usability cost for the 70+ audience. I lean magic link with very clear
   in-app instructions, but this is a genuine trade-off.

9. **Email provider.** Resend, Postmark, or Supabase's built-in? Postmark has the best
   transactional deliverability; Resend has the nicer developer experience. Also: which
   sending domain?

10. **Retention windows.** Confirm 13 months for transactions, 90 days for raw
    descriptors, 30 days for logs. Longer transaction retention makes year-over-year
    retrospectives better and makes the privacy story worse.

11. **Period timezone.** Fix all benefit periods to America/New_York (matching how Amex
    posts), or use the user's local timezone? Fixed ET is more correct; user-local is
    less surprising. I lean fixed ET with the boundary shown explicitly in the UI.

12. **Credit lag window.** One global 90-day settling window, or per-benefit
    `max_lag_days` in the rules? Per-benefit is more accurate and more work to author.

13. **AI layer in V1 or deferred?** I recommend deferring it to post-MVP. The sanitized
    DTO boundary gets designed in M0 either way, so nothing is lost by waiting, and
    shipping the honest deterministic engine first is the harder and more valuable part.

14. **Production Plaid timeline.** Sandbox-only is fine for building, but production
    access requires a company profile, a security questionnaire, and review time. Is real
    production a goal, and if so should the application start during M4?

15. **Legal review.** Using the American Express name, describing their benefits, and the
    "not affiliated" disclaimer. Do you want counsel to look at this before anything is
    publicly reachable?
