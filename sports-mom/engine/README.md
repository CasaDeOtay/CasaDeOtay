# Season Engine

The seven behaviors from [The Sports Mom Issue](../index.html), run as a
background service instead of a conversation. Claude does the work silently and
returns one structured payload per turn; your app renders it.

Seasons change mid-flight — a later practice, a new coach, a kid who moves up a
division. So this is a **loop, not a feed**: your app sends the season state in,
the engine sends changes back, and your app saves the new revision. She never
re-pastes anything.

| File | What it is |
| --- | --- |
| `instructions.md` | The Project's custom instructions. Paste once. |
| `state.schema.json` | App → engine. The season state sent at the top of every turn. |
| `payload.schema.json` | Engine → app. The envelope returned by every turn. |
| `examples/inbound-state.json` | A real state block, mid-season, with an answered question waiting. |
| `examples/*.json` | Six turns: revised schedule photo, Sunday check-in, coach note, mid-season division move, confirming a held event, 8pm emergency. |
| `parse-payload.mjs` | Dependency-free extractor, validator, and state folder, with a self-test. `node parse-payload.mjs`. |

## The loop

You said the handoff wasn't decided yet, so here's the proposal.

**Inbound.** Your app opens each turn with a `<season_state>` block: the current
profile, open questions (with her answer, if she's given one), a compact index
of events already emitted, and what she just sent. The engine reads that instead
of trusting its own memory of the conversation.

**Outbound.** The reply is **exactly one fenced ` ```json ` block and nothing
else**. Your app takes the *last* fenced block and parses it. That's the whole
protocol.

Why this and not something cleverer:

- It works today, through whatever surface you're already using. Nothing to
  stand up first.
- Taking the *last* block means a stray sentence can't shadow the real payload.
  Drift degrades into a parse error you can see, not silently wrong data.
- Passing state in beats relying on conversation memory. A long season outruns a
  context window; a state block doesn't.
- It survives a move to the API later. The same envelope becomes a tool schema
  or a structured output and the shape doesn't change — only the transport.

Two alternatives, if they suit you better:

- **Calendar as the source of truth.** Claude writes events itself and your app
  reads Google. Simpler for schedule, useless for the other six jobs — alerts,
  lists, and drills have nowhere to live.
- **API with structured outputs.** Strictest option, and the right end state if
  this becomes a product. Costs you a backend and an auth story.

## Mid-season changes

The engine is allowed to change the season profile. Not everything is its call.

**It changes on its own** (`applied: true`, `authority: "engine"`) when someone
stated a fact and the change is reversible — practice times, fields, opponents,
coach name, roster size, season dates, or a constraint someone *added*. It
writes the new profile, bumps `state_revision`, records where the fact came from
in `source`, and re-emits anything the change invalidated with `supersedes` set
so you can retire the stale row.

**It proposes** (`applied: false`, `authority: "parent"`, plus a `needs_input`
entry) when the change spends something of hers: a trade between two of her
constraints, money, a bigger commitment, deleting events she planned around — or
**removing a food or safety constraint**, which never happens on its own no
matter who said it. Proposed values stay out of `profile` until she answers.

When she answers, the engine applies it, lists the `question_id` in
`resolved_questions`, and releases whatever it was blocking.

**With no state block** — she's typing straight into the Project — the engine
sets `state_revision: null` and returns every change as a proposal. It won't
claim to have saved something when there's nowhere to save it.

`applyPayload(state, payload)` does the folding for you: new profile, questions
retired and added, event index updated. A payload whose revision doesn't follow
your state throws a conflict rather than overwriting a turn you missed.

## The holding area

A creased schedule photo produces a row nobody can read. Guessing puts a wrong
game on her calendar; dropping it means she finds out on a Saturday morning.
Neither is acceptable, so it goes in `unconfirmed_events` — visible, obviously
unconfirmed, and never written to the calendar.

The engine emits it `confidence: "low"`, `calendar_action: "none"`, with a
`needs_input` entry whose `blocks` names the `event_id`. `applyPayload` parks it
with the question attached and stamps `first_seen` / `last_seen`, so a re-sent
photo refreshes the row instead of stacking another copy.

It leaves only when the engine re-emits the **same `event_id`** at high
confidence: with a real time once she clarifies, or `change: "canceled"` if it
was never a thing — which tombstones it so the next photo of the same crease
doesn't park it all over again.

`pendingConfirmations(state)` gives you the render-ready list: each held event
with its question text. A row where `stuck: true` is one whose question was
answered or retired without the event ever coming back — rare, but it means the
loop dropped a stitch, so surface it and ask again rather than leaving it to rot.

## Wiring it up

1. Paste `instructions.md` into the Project's custom instructions, over the
   interview prompt. The profile stays in your app, not in that text.
2. Seed the first state from what the interview produced — `state.schema.json`
   is the shape.
3. Connect Google Calendar so events land on a real calendar. Gmail is optional
   and only ever produces drafts.
4. On each turn: send `<season_state>` + her input, then
   `applyPayload(state, extractPayload(reply))` and save the result.
5. Render `pendingConfirmations(state)` somewhere she'll see it — that list is
   the only place an unreadable schedule row exists.

## What the app can rely on

These hold on every turn, and `parse-payload.mjs` fails loudly when they don't:

- **All eighteen top-level keys are always present.** Empty array means nothing
  happened this turn. A missing key means the engine drifted — an error, not
  empty.
- **IDs are minted once and never change.** A game that moves keeps its
  `event_id` and reports `change: "moved"` with `previous_start`. You update a
  row; you never dedupe.
- **`state_revision` only moves forward, one step at a time**, and only when the
  profile actually changed.
- **`fires_on` is when she should see it**, not when the thing happens. Snack
  duty for the 12th fires on the 10th. Render off `fires_on`, sort by it.
- **Low confidence never becomes data, and never disappears either.** See the
  holding area below.
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

Current version is `"1.1"`, which added the state loop. `"1.0"` — payload only,
no profile, no revisions — still validates, and `applyPayload` refuses it rather
than pretending it carries state.

Additive changes (a new optional field, a new `alerts.kind`) keep the version.
Anything that would break a parser bumps it, and the client rejects a version it
doesn't know rather than guessing at a field whose meaning may have moved.
