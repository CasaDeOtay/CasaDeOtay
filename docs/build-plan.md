# Build plan

Companion to `docs/amex-benefits-plan.md`. That document says what to build. This one
says in what order, what each step depends on, and how you know it is done.

Sizes are rough, for one experienced developer. S is under a day, M is one to three
days, L is a week or more.

## The ordering principle

Build the domain layer first, against fixtures, before touching Plaid or Supabase.

The instinct is to build the Plaid connection first because a screen full of real
transactions feels like progress. Resist it. If you build the integration first you will
shape the domain model around Plaid's response shape, and Plaid's response shape is not
your product. You end up with a benefit engine that thinks in `plaid_transaction_id` and
cannot be tested without a network call.

The domain layer is pure, has no dependencies, and encodes every rule that matters. It
can be finished and fully tested in week one with nothing else existing. Everything
after that is plumbing that feeds it.

---

## Phase S: spikes, before committing to anything

Three unknowns could invalidate parts of the design. They are cheap to test and
expensive to discover late.

### S1. Can Plaid Sandbox represent a statement credit? (S, do this first)

The entire reconciliation engine assumes we can produce negative-amount transactions
with controllable descriptors in sandbox. If the custom user JSON cannot express that,
we cannot test reconciliation against Plaid at all and need a different fixture strategy
(a fake Plaid layer that replays recorded payloads).

Test: build a custom sandbox user with a purchase, a matching negative statement credit
with a chosen descriptor, and a merchant refund. Run `/transactions/sync`. Confirm all
three arrive with the amounts, signs, and descriptor text intact.

This is the highest-risk hour in the project. Do it before writing anything else.

### S2. Uber Cash modeling (S)

Covered in `benefits/WATCHLIST.md` item 3. Uber Cash loads a balance rather than
crediting a purchase, so a qualifying ride may produce no card transaction. Decide
whether it gets a separate state machine or gets excluded from V1. Right now the engine
would report it as unused when it may be fully used, which is the exact failure this
product exists to prevent.

### S3. Does a real Amex feed carry usable credit descriptors? (blocked)

We control descriptors in sandbox. We do not know what Amex actually sends through Plaid
in production. This cannot be tested without production access and it is the largest
unknown in the whole design: if real statement credits arrive with an opaque descriptor,
reconciliation degrades to amount-and-date matching only.

Not a blocker for V1, but it is the reason to start the Plaid production application
early (decision 14) rather than at the end.

---

## Phase 0: foundation (M)

| Unit | Deliverable |
|---|---|
| 0.1 | Next.js + TypeScript, `strict: true`, `noUncheckedIndexedAccess: true` |
| 0.2 | Vitest, fast-check, coverage thresholds on `lib/domain` |
| 0.3 | ESLint with `no-restricted-imports` boundaries: nothing outside `lib/server` may import from it, and `lib/domain` may import nothing with I/O |
| 0.4 | Structured logger with redaction allowlist |
| 0.5 | CI: typecheck, lint, test, gitleaks, `npm audit` |

Exit: CI green on an app that does nothing. Boundary violations fail the build, proven
with a deliberately bad import in a throwaway commit.

Gated by: nothing. Start today.

---

## Phase 1: the domain layer (L)

Pure TypeScript. No network, no database, no `Date.now()`. This phase is the product.

### 1.1 Core types (S)

Branded `Cents`, `LocalDate`, `Instant`. A `Clock` interface injected everywhere. Money
is integer cents throughout, and the branding stops a raw `number` from ever being
passed where cents are expected.

### 1.2 The keystone signature (S)

Define this before writing any of the functions it composes. Everything else is shaped
to fit it.

```ts
type RecomputeInput = {
  period: {
    start: LocalDate
    end: LocalDate            // exclusive
    settlesThrough: LocalDate
    allowanceCents: Cents
    rule: BenefitRule
  }
  enrollment: EnrollmentState
  connectionHealth: ItemHealth
  evidence: readonly EvidenceRecord[]
  now: Instant
}

type RecomputeOutput = {
  status: BenefitStatus
  confidence: ConfidenceLevel
  consumedCents: Cents
  links: readonly ReconciliationLink[]
  explanation: readonly ExplanationLine[]
}

function recompute(input: RecomputeInput): RecomputeOutput
```

`explanation` being an output of the pure function, rather than something the UI
assembles later, is the load-bearing detail. It means the same code that decides the
status also produces the sentence justifying it, so the two cannot drift. That is what
makes "never claim a benefit is used" enforceable rather than aspirational. A UI that
composes its own explanation will eventually say something the engine did not conclude.

### 1.3 Period generation (M)

`(cadence, anchor, timezone, asOf) -> Period`. Handles the six cadences plus
`allowance_overrides` for the Uber Cash December case.

Tests: year boundaries, leap day, DST transitions, a benefit retired mid-year (the Saks
case, where `effective_to` stops period creation without voiding the period already
open), quarterly boundaries, and a cardmember year anchored to a month.

Gated by: decision 11 (period timezone) and decision 2 (anniversary handling). Build
with ET and calendar-only as defaults; both are one-line changes if the answers differ.

### 1.4 Merchant normalization (M)

Uppercase, strip punctuation, collapse whitespace, strip store numbers, strip aggregator
prefixes, strip trailing city and state tokens.

Needs a corpus of real descriptor shapes to test against. Collect these from the sandbox
fixtures and from any real statements someone is willing to share, redacted.

### 1.5 The fixture corpus (M, and it never really ends)

Hand-authored transaction sets with expected outcomes, one per benefit plus one per edge
case. Write this **before** the matcher, not after. It is the specification, and writing
it first is what stops the matcher from being tested against its own assumptions.

Minimum set at this phase:

- A clean purchase and matching credit for each active benefit
- Partial consumption (purchase under the allowance)
- Over-cap (purchase above the allowance, credit capped)
- Multiple small purchases, one combined credit
- A merchant refund that must not read as a statement credit
- A credit reversal after a confirmed credit
- Pending to posted with a changed amount
- A `removed` transaction that invalidates evidence
- A late credit inside the settling window, and one outside it
- An unenrolled benefit where a purchase produces no credit
- An ambiguous transaction that is a candidate for two benefits
- A stale connection where confidence must not promote

### 1.6 Matching (M)

Candidate generation and the exclusive-group handling. Gate, normalize, generate,
predicate. Emits candidates with feature vectors, decides nothing on its own.

### 1.7 Scoring (M)

The weighted feature model from plan section 7, plus the five hard override rules.
Stores the feature vector alongside every score.

### 1.8 Reconciliation (L)

The hardest unit. Credit versus refund versus payment classification first, then exact,
tolerance, and bounded subset-sum matching, with deterministic tie-breaks.

### 1.9 State machine (M)

Evidence set to status. Backwards transitions are first-class. Generates the explanation
lines.

### 1.10 Recompute orchestrator (S)

Composes the above into the keystone signature.

**Phase exit:** the entire fixture corpus passes, and these property tests hold for
arbitrary generated inputs:

- `consumedCents <= allowanceCents`, always
- `recompute(recompute(x)) == recompute(x)`
- Shuffling the evidence array does not change the output
- Purchase-only evidence never yields `credit_confirmed`, for any input
- Applying a refund then recomputing equals recomputing without the refunded purchase
- An unhealthy connection never increases confidence versus a healthy one

Gated by: decisions 11 and 2 for unit 1.3, decision 5 (manual attestation) for 1.9.
Nothing else. Roughly the first two to three weeks of work needs two answers.

---

## Phase 2: rule loading (S)

Zod schema for the YAML format, a loader, and validation in CI so a malformed or
internally inconsistent rule fails the build. Checksum and release manifest per plan
section 17.

Rules with `verification: conflicting` or `status: disabled` load but are excluded from
matching, which is how `clear_plus.yaml` behaves today.

Exit: `benefits/` parses, a deliberately broken rule fails CI, and a disabled rule is
provably skipped by the matcher.

---

## Phase 3: persistence (M)

### 3.1 Migrations

The full schema from plan section 2. Every table, every index, every enum.

### 3.2 RLS policies

Deny by default, per the table in plan section 14. `plaid_item_secrets` gets zero
policies and all grants revoked.

### 3.3 The RLS test suite

Runs as user A, user B, and anon, asserting exactly what each can see across every table.
A table added without a corresponding test case fails CI. Untested RLS is not RLS.

Exit: suite green, and adding a new table without a policy test breaks the build.

Gated by: nothing.

---

## Phase 4: Plaid integration (L)

### 4.1 Token vault (M)

Envelope encryption, key versioning, the single decryption module.

Gated by: **decision 1** (key custody). This is the one decision that hard-blocks a whole
phase.

### 4.2 Plaid client wrapper (S)

Takes an item id, resolves the token internally, returns responses. No caller ever holds
a token.

### 4.3 Link token and exchange routes (M)

Plus the account picker, filtered server-side to credit accounts.

### 4.4 Sync engine (L)

Cursor loop with pagination, upsert on `plaid_transaction_id`, `removed` soft-delete,
pending supersession, the field allowlist mapper, and the sign-convention assertion.

The cursor advances only after the batch it describes is committed.

### 4.5 Webhook handler (M)

JWT verification against the key endpoint, `iat` window check, body hash comparison.
Reject before parsing. Then `SYNC_UPDATES_AVAILABLE` triggers a sync.

### 4.6 Sandbox fixtures (M)

Custom user JSON encoding the phase 1.5 corpus, so the same cases run through the real
Plaid path.

**Phase exit:** sandbox transactions land in Postgres correctly, and the security tests
pass: no token in the client bundle, no token in captured logs, webhook rejects unsigned
and replayed requests.

---

## Phase 5: wiring (M)

Ingest triggers recompute for affected periods. The rollover job opens and closes
periods. Both idempotent.

Exit: the sandbox fixture corpus produces the same benefit states end to end that the
pure domain tests produce in isolation. If these disagree, the plumbing is wrong, and you
will know exactly where because the domain layer is already proven.

---

## Phase 6: interface (L)

### 6.1 Auth (S)
Gated by decision 8.

### 6.2 Connect flow (M)
Including the backfill progress state and the "having trouble?" fallback path.

### 6.3 Benefit dashboard (L)
The main screen. Progress against allowance, confidence stated in words, time remaining.

### 6.4 Explanation view (M)
Renders `RecomputeOutput.explanation`. Never composes its own reasoning.

### 6.5 Disambiguation (M)
One-tap resolution when a transaction is a candidate for two benefits.

### 6.6 Enrollment and settings (M)
Manual enrollment checkboxes with deep links, per-benefit mute, timezone, airline
selection for the airline credit.

Gated by: decisions 5, 6, 8.

---

## Phase 7: reminders and health (M)

Digest email with dedupe keys, quiet hours, suppression rules. Connection health states,
the degradation of confidence when blind, the reconnect flow.

Gated by: decision 9 (email provider).

---

## Phase 8: privacy operations (M)

Disconnect, delete, retention job, export. The retention job runs behind a dry-run
assertion in staging first, because it is the job most likely to delete something it
should not.

Gated by: decisions 7 and 10.

---

## Phase 9: accessibility and launch readiness (M)

Full axe pass on every route, plain-language copy rewrite, the moderated session with a
user over 70, and the fixes that session produces. Budget real time for the fixes; that
session always finds something.

Gated by: decision 15 (legal review) for public launch, not for the work itself.

---

## What blocks what

Only two decisions block the first two to three weeks:

- **Decision 11**, period timezone. Needed for unit 1.3.
- **Decision 2**, card anniversary handling. Also unit 1.3.

Decision 1 (key custody) blocks phase 4 and nothing before it, so it is needed in roughly
week four.

Everything else is needed later than that, and three of the original fifteen are already
resolved: decision 3 (which benefits) and decision 4 (current terms) were answered by the
research pass in `benefits/`, and decision 12 (credit lag window) resolved as per-benefit
`max_lag_days`, which is already encoded in the rule files.

Two new decisions came out of that research and are open:

- **Uber Cash handling.** Separate state machine, or cut from V1?
- **Terms verification owner.** Every rule is `secondary_verified`. Someone with browser
  access has to confirm against Amex before this reaches a user.

## PR sizing

One work unit per pull request. If a unit produces a diff you cannot review in twenty
minutes, split it. The reconciliation unit (1.8) is the likely exception and it is worth
splitting into classification and matching as two PRs.

## What I would not do

Do not build a debug UI over raw transactions "just to see the data" and then keep it.
Plan section 12 rules out an admin view over user transactions, and a debug screen is
that view wearing a different name. Use tests and the database directly during
development.

Do not start the AI layer until phase 6 is done. The deterministic engine is the product
and it is the harder half. An advisory layer over a correct engine is a week; an advisory
layer over an engine you do not trust is a liability.
