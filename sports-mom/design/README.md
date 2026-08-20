# Season app — screen mockups

Four phone screens (390×844) showing what the app does with a Season Engine
payload. Every line of content on them comes from `../engine/examples/`, so the
mockups and the contract can't drift apart silently.

| Artboard | Screen | Payload behind it |
| --- | --- | --- |
| `Main.dc.html` | Sunday check-in | `sunday-checkin.json` — alerts, digest 43→3, Tuesday's plan |
| `NeedsYou.dc.html` | Needs you | `schedule-photo.json` — the parked unreadable 9/19 row and its question |
| `Snack.dc.html` | Snack duty | `sunday-checkin.json` — the list, its constraints, and the no-buying limit |
| `Change.dc.html` | Mid-season change | `midseason-change.json` — what it changed itself vs. what it asked |

`canvas.json` lays the four out in a row.

Visual vocabulary is lifted from `../index.html`: Big Shoulders Display,
Newsreader, DM Mono, the newsprint palette (`#F2F3ED` / `#151814`), `#DFF25E`
highlighter, `#BF3B1E` for anything that needs her, square corners, 1px rules.

These are static mockups — no working controls.

Published canvas: https://claude.ai/code/artifact/4f02af77-2fea-4f94-857e-003a60d9171d
