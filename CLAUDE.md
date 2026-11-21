# Casa de Otay

Coffee business owned by Daniel and LaTanya, two shops in Millenia, Chula Vista. Business docs live in `business-basics/`. Read `business-basics/README.md` first.

## Vendor price updates

When the user adds a vendor price PDF to `business-basics/vendor-pricing/` or mentions new vendor pricing:
1. Read the PDF and match each line item to rows in `business-basics/data/ingredients.csv` (vendor column).
2. Update pack_price, pack_size and last_updated. Add new rows for new items.
3. Run `python3 business-basics/tools/cost_calc.py`.
4. Report old vs new price for each changed item, which drinks changed cost, and any drink over 25% cost.
5. Commit with a message naming the vendor and month.

## Rules

- This repo is public. Never commit passwords, logins, phone numbers or personal emails. Those stay in Google Drive.
- Square is the source of truth for menu prices and sales. Google Drive holds recipes, cost sheets, vendor contacts and the ordering schedule.
- Write in plain language. The owners teach this material to other small business owners.
