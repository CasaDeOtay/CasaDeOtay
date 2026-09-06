# Benefit rules

Source of truth for Amex benefit definitions. Git is authoritative; the database is a
cache seeded by migration. See `docs/amex-benefits-plan.md` section 17.

## Verification levels

Every rule carries `verification` with one of:

- `terms_verified` — checked against the issuer's own terms page or card member
  agreement. This is the only level allowed to ship to a real user.
- `secondary_verified` — two or more independent reporting sources agree. Good enough
  to build and test against. Not good enough to tell someone their money is safe.
- `conflicting` — sources disagree. The rule is disabled for matching until resolved.
- `stale` — `terms_verified_on` is more than 180 days old.

**Every rule in this directory is currently `secondary_verified` at best.** The research
pass on 2026-09-06 could not reach americanexpress.com (blocked by network egress), so
all amounts and cadences come from reporting rather than from Amex. Someone with browser
access has to do a terms-verification pass before this app tells a human being anything.

## Changing a rule

Never edit a released rule in place. Bump `version`, set `effective_to` on the old one,
and add a `CHANGELOG.md` entry with the date and source. Closed benefit periods keep the
rule version they were computed under.

## Retired benefits

Retired benefits stay in this directory with `effective_to` set and `status: retired`.
Deleting them would break the recompute of historical periods, and the retrospective
("you used this last year, it no longer exists") is a thing worth showing.
