# Benefit change log

Dated record of observed changes to the Amex Platinum benefit set. Every entry needs a
source. Entries are appended, never edited.

## 2026-09-06 — initial research pass

First authored rule set for `amex_platinum_consumer_us`. All rules are
`secondary_verified`, not terms-verified: americanexpress.com was unreachable from the
build environment (network egress block), so everything below comes from reporting.

Changes captured in this pass, most recent first:

**2026-10-01 (upcoming, 25 days out): Lufthansa Lounge access ends.** Platinum will no
longer grant Lufthansa Lounge access, including on same-day Lufthansa travel. Not a
statement credit so it does not affect matching, but it belongs in the benefit catalog
once the app shows non-credit perks.
Source: reporting summarized via TravelUpdate's 2026 changes tracker.

**2026-07-01: Saks Fifth Avenue credit retired.** Last usable day was 2026-06-30. The
first-half 2026 credit was the final one; the second-half period never opened. Encoded
as `saks.yaml` version 2 with `status: retired`.
Sources: nerdwallet.com/travel/news/amex-platinum-saks-credit,
thriftytraveler.com/news/credit-card/amex-platinum-drops-saks-credit/

**2026-07-01: CLEAR Plus membership price rose to $219.** Amex reportedly raised the
matching credit on the same date. The credit amount is in conflict across sources
($209 vs $219), so `clear_plus.yaml` ships disabled.
Sources: upgradedpoints.com/news/clear-plus-membership-price-increase-july-2026/,
thepointsguy.com/news/american-express-increases-clear-plus-credit

**2025-09-18: the refresh.** Annual fee $695 to $895. Added Resy ($100/quarter),
lululemon ($75/quarter), Oura ($200/year), Uber One ($120/year), and restructured the
hotel credit to $300 semi-annual. Digital entertainment moved to $25/month.
Sources: cnbc.com/select/amex-platinum-card-2025-changes/,
kiplinger.com/personal-finance/credit-cards/amex-platinum-card-refresh-worth-it
