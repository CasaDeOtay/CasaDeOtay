# Season Engine

The seven behaviors from [The Sports Mom Issue](../index.html), run as a
background service instead of a conversation. Claude does the work silently and
returns one structured payload per turn; your interface renders it.

| File | What it is |
| --- | --- |
| `instructions.md` | The Project's custom instructions. Fill in the SEASON PROFILE, paste, done. |
| `payload.schema.json` | JSON Schema (draft 2020-12) for the payload. The contract. |
| `examples/*.json` | Four real turns: a revised schedule photo, a Sunday check-in, a coach note, an 8pm emergency. |
| `parse-payload.mjs` | Dependency-free extractor + validator, with a self-test. `node parse-payload.mjs`. |

## The handoff

You said this wasn't decided yet, so here's the proposal, and why.

**Every reply is exactly one fenced ` ```json ` block and nothing else.** Your
interface takes the *last* fenced block in the reply and parses it. That's the
whole protocol.

Why this and not something cleverer:

- It works today, through whatever surface you're already using — the Projects
  UI, a shared conversation, a copy-paste. Nothing to stand up first.
- Taking the *last* block means a stray sentence or a quoted example can't
  shadow the real payload. Drift degrades into a parse error you can see, not
  silently wrong data.
- It survives a move to the API later. When you're ready, the same envelope
  becomes a tool schema or a structured-output response and the shape doesn't
  change — only the transport does.

Two alternatives, if they suit you better:

- **Calendar as the source of truth.** With Google Calendar connected, Claude
  writes events itself and your interface reads Google, not the payload. Simpler
  for schedule, useless for the other six jobs — alerts, lists, and drills have
  nowhere to live.
- **API with structured outputs.** Strictest option, and the right end state if
  the interface becomes a real product. Costs you a backend and an auth story,
  which the fenced-block version doesn't.

## Wiring it up

1. Fill in the SEASON PROFILE at the top of `instructions.md` — the interview in
   the Project writes most of it for you.
2. Paste the whole file into the Project's custom instructions, over the
   interview prompt.
3. Connect Google Calendar so events land on a real calendar. Gmail is optional
   and only ever produces drafts.
4. Point your interface at `extractPayload()` in `parse-payload.mjs`, or
   reimplement it — it's forty lines.

## What the interface can rely on

These hold on every turn, and `parse-payload.mjs` fails loudly when they don't:

- **All fifteen top-level keys are always present.** Empty array means nothing
  happened this turn. A missing key means the engine drifted — treat it as an
  error, not as empty.
- **IDs are minted once and never change.** A game that moves keeps its
  `event_id` and reports `change: "moved"` with `previous_start`. You update a
  row; you never dedupe.
- **`fires_on` is when she should see it**, not when the thing happens. Snack
  duty for the 12th fires on the 10th. Render off `fires_on`, sort by it.
- **Low confidence never becomes data.** Anything unreadable off a photo comes
  back `confidence: "low"`, `calendar_action: "none"`, and a `needs_input` entry
  naming what it blocks. Hold those rows until she answers.
- **`answers[].body` is the only field written for a human.** It's markdown.
  Everything else is for you.

## The limits, enforced

The page promises three things the engine can't do. They're checked in
`validatePayload()` so a drifting model can't quietly cross them:

- `lists[].ordered` is always `false` — it builds the list, you place the order.
- `drafts[].channel` is always `"email"`, never the team chat.
- `drafts[].requires_approval` is always `true`, and `sent` stays `false` until
  she approves that specific draft.

## Versioning

`schema_version` is `"1.0"`. Additive changes (a new optional field, a new
`alerts.kind`) keep the version. Anything that would break a parser — a renamed
key, a removed field, a changed meaning — bumps it, and `parse-payload.mjs`
rejects a version it doesn't know rather than guessing.
