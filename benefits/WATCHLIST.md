# Watchlist

Open questions blocking `terms_verified` status, and dated changes to re-check.
Reviewed on every monitoring run.

## 1. CLEAR Plus credit amount — BLOCKING

$209 or $219? The CLEAR+ membership price went to $219 on 2026-07-01 and Amex reportedly
matched it, but 2026 guides still print $209. Ten dollars sounds trivial and is not: if
we say covered and it is not, the user pays the gap and learns the app lies.

`clear_plus.yaml` is disabled until someone reads the Amex terms page.

## 2. Equinox credit cadence — BLOCKING for reminders

Reported as "up to $300 each calendar year." Unclear whether it disburses as one annual
allowance or as $25 monthly. This changes the reminder schedule completely: an annual
benefit gets nudges at 60/30/7 days out, a monthly one gets nudged twelve times a year.
Currently encoded as `calendar_year`.

## 3. Uber Cash is not a statement credit — ARCHITECTURAL

Uber Cash loads a balance onto the Uber account rather than crediting a card purchase.
The reconciliation engine in `docs/amex-benefits-plan.md` section 6 assumes every benefit
resolves as a negative transaction on the card. This one does not, and a ride paid
entirely from Uber Cash may produce no card transaction at all.

Consequences the plan does not currently handle:

- Absence of a charge is not evidence of non-use for this benefit.
- We cannot see the Uber Cash balance. Plaid does not have it.
- Confidence for this benefit should top out at `possible` from card data alone.

Proposed handling: a `balance_style: true` flag on the credit config that routes the
benefit to a different state machine, one that says "we cannot verify this automatically,
check your Uber app" instead of showing a progress bar. Needs a decision.

## 4. Merchant-name matching is weak for three benefits

Resy, the hotel credit, and the airline fee credit all post under a third party's name
(the restaurant, the property, the airline) rather than under the benefit brand. Purchase
matching for these will be category-level at best, so they depend almost entirely on
reconciling the statement credit after the fact. Expect them to sit at `possible` until
the credit posts, and write the UI copy accordingly.

## 5. Schema addition needed: per-period allowance overrides

Uber Cash is $15/month except December, which is $35. The `benefit_periods` model in the
plan assumes a fixed `allowance_cents` per cadence. Added `allowance_overrides` to the
rule format; the plan's section 9 needs a matching amendment.

## 6. Dated items to re-check

- 2026-10-01: Lufthansa Lounge access ends. Confirm it happened.
- 2027-01-01: calendar-year benefits reset. Confirm amounts did not change with them.
- Quarterly boundaries: Resy and lululemon reset. Historically Amex has adjusted
  quarterly amounts at these boundaries without an announcement.
