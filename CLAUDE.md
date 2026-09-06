# CLAUDE.md

## What this repo is

Two unrelated things share this repo. Check the branch before assuming.

- `main`: a neon arcade multiplication practice game (`index.html`). Unrelated to the below.
- `claude/amex-benefits-plan-prh523`: a fintech web app that helps Amex Platinum
  cardholders avoid wasting card benefits. This is the active project.

## Status

Architecture plan is written and **awaiting approval**. No application code exists yet
and none should be written until the user approves. The plan is `docs/amex-benefits-plan.md`
and it ends with 15 open decisions that are still open.

The benefit rule set in `benefits/` is authored and live, because rule maintenance was
approved separately as an ongoing job.

## V1 scope, locked

One individual user, one U.S. Consumer Amex Platinum card, Plaid Sandbox only.
Next.js + TypeScript, Supabase, Vercel. Anything beyond that is out of scope.

## Hard rules

These are product requirements, not preferences. Do not relax them without being asked.

**Never collect or store:** full card number, CVV, Amex username or password, SSN, home
or billing address. The control that enforces this is product scope: request only the
Plaid `transactions` product, never `identity`, `auth`, or `liabilities`. Those fields
then never arrive.

**Plaid access tokens** stay server-side, encrypted at rest, and never appear in browser
JavaScript, in logs, or in anything sent to an AI model. One module decrypts them
(`lib/server/plaid/token-vault.ts`). The AI layer's input type has no token field and no
raw transaction descriptors, which makes this a compile-time guarantee rather than a
convention.

**Never claim a benefit was used because a purchase was detected.** Purchase-only
evidence caps at `likely_eligible`. Only a posted, reconciled statement credit reaches
`credit_confirmed`. There is a test asserting this and it does not get deleted.

**Status is derived, never set.** Store evidence, compute status with a pure function.
Refunds, clawbacks, Plaid `removed` events, and stale connections all collapse into one
recompute path. Do not add a mutable status column.

**When the Plaid connection is stale, degrade confidence.** "No purchase detected" and
"we cannot see your account" render identically and mean opposite things. Unhealthy item
freezes upward confidence promotion and suppresses reminders.

## Lifecycle and confidence vocabulary

States: `not_configured` to `ready` to `purchase_detected` to `likely_eligible` to
`credit_pending` to `credit_confirmed`. Plus `expired_unused`. Backwards transitions are
supported and tested, not error cases.

Confidence: `confirmed`, `likely`, `possible`, `unknown`.

## Benefit rules

Source of truth is git, in `benefits/`. The database is a cache seeded by migration.

- Never edit a released rule in place. Bump `version`, set `effective_to` on the old one,
  append a dated `CHANGELOG.md` entry with sources.
- Every rule carries a `verification` level. Only `terms_verified` may ship to a real
  user. Everything currently in the repo is `secondary_verified` at best, because
  americanexpress.com is blocked by this environment's network egress and all amounts
  came from reporting. A human with browser access owes a terms-verification pass.
- When sources conflict on a number, set `verification: conflicting` and
  `status: disabled`. Do not pick one. A disabled benefit saying "we are checking on
  this" is correct; a confidently wrong dollar amount is the failure mode this whole
  product exists to avoid.
- Retired benefits stay as tombstones with `effective_to` set. Deleting them breaks the
  recompute of historical periods.

A routine (`trig_01CxsuoU8HnyxaHtKguX1PDo`) re-checks the rules on the 1st and 15th at
9am ET, pushes drift to this branch, and reports only when something changed.

## Known gaps, unresolved

Tracked in `benefits/WATCHLIST.md`. The two that affect architecture:

1. **Uber Cash is not a statement credit.** It loads a balance onto the Uber account, so
   a qualifying ride may produce no card transaction at all. The reconciliation design in
   plan section 6 assumes every benefit resolves as a negative transaction on the card.
   Absence of a charge is not evidence of non-use here. Needs a separate state machine.
2. **Per-period allowance overrides.** Uber Cash is $15/month except December at $35. The
   period model assumes a fixed allowance per cadence. The rule format has
   `allowance_overrides`; plan section 9 has not been amended to match.

Resy, the hotel credit, and the airline fee credit all post under a third party's name
rather than the benefit brand, so purchase matching is category-level at best. Expect
them to sit at `possible` until a credit posts.

## Accessibility floor

Primary audience is 70+. These are minimums, not targets.

- 18px body text minimum, nothing below 16px anywhere including footers. Layout survives
  200% zoom with no horizontal scroll.
- 7:1 contrast for body text. 4.5:1 for everything else including placeholders and
  disabled states.
- 48x48px touch targets. No icon-only buttons, no hover-only affordances.
- Nothing disappears on a timer. No toasts, no auto-advancing anything.
- Plain language: "You have $15 left to spend on rides this month, and it expires
  September 30." Dates written out, currency in full, no jargon.
- No dark patterns. Disconnect and delete are as easy to find as connect.

The design reference the user shared (pastel card dashboard) is good for layout and bad
for contrast and type size. Take the structure, rebuild the palette.

## Working conventions

- Money is integer cents. No floats anywhere in the schema or the domain layer.
- The domain layer (`lib/domain`) is pure: no I/O, no network, and never calls
  `Date.now()`. Inject a clock. Most bugs in this system are date bugs and they are only
  findable if dates are a value you can pass in.
- Develop on `claude/amex-benefits-plan-prh523`. Do not open a PR unless asked.
