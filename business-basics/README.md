# Casa de Otay Business Basics

How we run Casa de Otay, written down so the team (and Claude) can use it. Later this becomes the base for teaching other small business owners.

| File | What's in it |
|---|---|
| 01-about-us.md | Who we are, locations, hours, team, customers, competition |
| 02-menu-and-pricing.md | Menu items and prices |
| 03-vendors.md | Every vendor, what we buy, how and when we order |
| 04-cost-breakdown.md | Cost per drink (generated, don't edit by hand) |
| data/ingredients.csv | Every ingredient's pack price and size. Update this when prices change |
| data/recipes.csv | What goes into each drink |
| data/menu_prices.csv | What we charge |
| vendor-pricing/ | Drop vendor price sheet PDFs here |
| tools/cost_calc.py | Rebuilds 04-cost-breakdown.md from the data files |

## When a vendor sends new pricing

1. Save the PDF in `vendor-pricing/` named like `challenge-dairy-2026-11.pdf`.
2. Tell Claude: "New pricing from Challenge Dairy, it's in vendor-pricing."
3. Claude updates `data/ingredients.csv`, runs `python3 tools/cost_calc.py`, and tells you which drinks changed and whether any went over 25% cost.

## Never put in this repo

This repo is public on GitHub. Keep passwords, logins, phone numbers and personal emails in Google Drive only.
