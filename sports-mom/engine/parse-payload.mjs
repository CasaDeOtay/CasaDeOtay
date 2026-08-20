/**
 * Reference client for Season Engine payloads.
 *
 * The engine answers with exactly one fenced `json` block and nothing else.
 * This pulls it out, checks the envelope, and folds it into the season state
 * your app persists — so a mid-season change lands in your store instead of
 * being retyped into the Project's instructions.
 *
 *   import { extractPayload, applyPayload } from './parse-payload.mjs'
 *   const payload = extractPayload(reply)        // throws PayloadError on anything odd
 *   const next    = applyPayload(state, payload) // the state to save
 *   pendingConfirmations(next)                   // what it couldn't read, held for her
 *
 * No dependencies. Run it directly to check the bundled examples:
 *   node parse-payload.mjs
 */

export const SCHEMA_VERSION = '1.1';
export const SUPPORTED_VERSIONS = ['1.0', '1.1'];

/** Top-level keys the engine promises on every turn, per version. */
const KEYS_1_0 = [
  'schema_version', 'season_id', 'as_of', 'input_kind', 'profile_updates',
  'events', 'alerts', 'digest', 'digest_stats', 'lists', 'plans', 'drills',
  'drafts', 'answers', 'needs_input',
];
const KEYS_1_1 = [...KEYS_1_0, 'state_revision', 'profile', 'resolved_questions'];
export const REQUIRED_KEYS = { '1.0': KEYS_1_0, '1.1': KEYS_1_1 };

/** Keys that are always arrays — empty means "nothing this turn", never absent. */
export const ARRAY_KEYS = [
  'profile_updates', 'events', 'alerts', 'digest', 'lists', 'plans', 'drills',
  'drafts', 'answers', 'needs_input', 'resolved_questions',
];

export const INPUT_KINDS = [
  'schedule_photo', 'group_chat', 'checkin', 'question', 'coach_note',
  'profile_change', 'other',
];

export class PayloadError extends Error {
  constructor(message, { reply, cause } = {}) {
    super(message);
    this.name = 'PayloadError';
    this.reply = reply;
    if (cause) this.cause = cause;
  }
}

const FENCE = /```json\s*\n([\s\S]*?)\n?```/gi;

/**
 * Pull the payload out of a model reply.
 * Takes the LAST fenced json block, so stray prose or an earlier example in the
 * turn can't shadow the real one.
 */
export function extractPayload(reply, { validate = true } = {}) {
  if (typeof reply !== 'string' || reply.trim() === '') {
    throw new PayloadError('Empty reply — nothing to parse.', { reply });
  }

  const blocks = [...reply.matchAll(FENCE)].map((m) => m[1]);
  if (blocks.length === 0) {
    throw new PayloadError(
      'No fenced json block in the reply. The engine drifted off contract, or the turn errored out.',
      { reply },
    );
  }

  const raw = blocks[blocks.length - 1];
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (cause) {
    throw new PayloadError(`Payload is not valid JSON: ${cause.message}`, { reply, cause });
  }

  if (validate) validatePayload(payload);
  return payload;
}

/** Structural check of the envelope. Throws PayloadError listing every problem. */
export function validatePayload(payload) {
  const problems = [];

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PayloadError('Payload is not an object.');
  }

  const version = payload.schema_version;
  if (!SUPPORTED_VERSIONS.includes(version)) {
    // Refuse rather than guess: a version we don't know may have moved a field's meaning.
    throw new PayloadError(
      `Unknown schema_version ${JSON.stringify(version)}. This client speaks ${SUPPORTED_VERSIONS.join(', ')}.`,
    );
  }

  for (const key of REQUIRED_KEYS[version]) {
    if (!(key in payload)) problems.push(`missing key: ${key}`);
  }
  for (const key of ARRAY_KEYS) {
    if (key in payload && !Array.isArray(payload[key])) {
      problems.push(`${key} must be an array (got ${typeof payload[key]})`);
    }
  }
  if (!INPUT_KINDS.includes(payload.input_kind)) {
    problems.push(`input_kind ${JSON.stringify(payload.input_kind)} is not one of ${INPUT_KINDS.join(', ')}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.as_of ?? '')) {
    problems.push(`as_of must be YYYY-MM-DD (got ${JSON.stringify(payload.as_of)})`);
  }

  // The promises made to her, enforced on the way in rather than trusted.
  for (const list of payload.lists ?? []) {
    if (list.ordered !== false) problems.push(`list ${list.list_id}: ordered must be false — the engine never buys.`);
  }
  for (const draft of payload.drafts ?? []) {
    if (draft.requires_approval !== true) problems.push(`draft ${draft.draft_id}: requires_approval must be true.`);
    if (draft.channel !== 'email') problems.push(`draft ${draft.draft_id}: channel must be "email".`);
  }
  const stats = payload.digest_stats;
  if (stats && stats.surfaced + stats.dropped !== stats.messages) {
    problems.push(`digest_stats: ${stats.surfaced} + ${stats.dropped} !== ${stats.messages}`);
  }
  for (const key of ['events', 'alerts', 'lists', 'plans', 'drills']) {
    for (const item of payload[key] ?? []) {
      const id = item.event_id ?? item.alert_id ?? item.list_id ?? item.plan_id ?? item.drill_id;
      if (item.supersedes && item.supersedes === id) problems.push(`${key}: ${id} supersedes itself.`);
    }
  }

  if (version === '1.1') problems.push(...checkStateRules(payload));

  if (problems.length) {
    throw new PayloadError(`Payload failed validation:\n  - ${problems.join('\n  - ')}`);
  }
  return payload;
}

/** The rules that let the engine change the season on its own without running away with it. */
function checkStateRules(payload) {
  const problems = [];
  const updates = payload.profile_updates ?? [];
  const applied = updates.filter((u) => u.applied === true);
  const proposed = updates.filter((u) => u.applied === false);
  const offline = payload.state_revision === null;

  for (const u of updates) {
    if (typeof u.applied !== 'boolean') problems.push(`profile_update ${u.field}: applied must be a boolean.`);
    if (!['engine', 'parent'].includes(u.authority)) {
      problems.push(`profile_update ${u.field}: authority must be "engine" or "parent".`);
    }
    // A fact it was allowed to apply but didn't only makes sense with nowhere to write.
    if (u.authority === 'engine' && u.applied === false && !offline) {
      problems.push(`profile_update ${u.field}: engine-authority change left unapplied with a live state_revision.`);
    }
    // Safety constraints come off only when she says so.
    if (u.field === 'constraints' && u.applied && u.authority === 'engine'
        && Array.isArray(u.previous) && Array.isArray(u.value)
        && u.previous.some((c) => !u.value.includes(c))) {
      problems.push('profile_update constraints: the engine may add constraints, never drop one.');
    }
  }

  if (applied.length && offline) {
    problems.push('profile changes were applied but state_revision is null — there is nowhere to persist them.');
  }
  if (applied.length && (payload.profile === null || payload.profile === undefined)) {
    problems.push('profile changes were applied but profile is null — the app has nothing to save.');
  }
  if (!applied.length && payload.profile) {
    problems.push('profile was returned without any applied profile_updates.');
  }
  if (proposed.length && !(payload.needs_input ?? []).length) {
    problems.push('a profile change was proposed with no needs_input entry to decide it.');
  }
  return problems;
}

/**
 * Fold a payload into the state your app persists.
 * Returns the next season state; does not mutate the one you passed in.
 */
export function applyPayload(state, payload) {
  validatePayload(payload);
  if (payload.schema_version === '1.0') {
    throw new PayloadError('applyPayload needs a 1.1 payload — 1.0 carries no state.');
  }
  if (state.profile?.season_id && payload.season_id !== state.profile.season_id) {
    throw new PayloadError(`Payload is for season ${payload.season_id}, state holds ${state.profile.season_id}.`);
  }
  if (payload.state_revision !== null
      && ![state.state_revision, state.state_revision + 1].includes(payload.state_revision)) {
    throw new PayloadError(
      `Revision conflict: state is at ${state.state_revision}, payload claims ${payload.state_revision}. `
      + 'Another turn wrote in between — re-send the current state.',
    );
  }

  const resolved = new Set(payload.resolved_questions ?? []);
  const openQuestions = (state.open_questions ?? [])
    .filter((q) => !resolved.has(q.question_id) && q.answer === null)
    .concat((payload.needs_input ?? []).map((q) => ({
      question_id: q.question_id,
      question: q.question,
      answer: null,
      blocks: q.blocks ?? [],
    })));

  const events = new Map((state.known_events ?? []).map((e) => [e.event_id, { ...e }]));
  const unconfirmed = new Map((state.unconfirmed_events ?? []).map((e) => [e.event_id, { ...e }]));

  for (const e of payload.events ?? []) {
    if (e.confidence === 'low') {
      // A guess never becomes a plan — but it never vanishes either. Park it where
      // she can see it, next to the question that clears it.
      const held = unconfirmed.get(e.event_id);
      unconfirmed.set(e.event_id, {
        event_id: e.event_id,
        proposed_start: e.start,
        title: e.title ?? held?.title ?? null,
        type: e.type ?? held?.type,
        source: e.source ?? held?.source ?? null,
        question_id: questionBlocking(payload, e.event_id) ?? held?.question_id ?? null,
        first_seen: held?.first_seen ?? payload.as_of,
        last_seen: payload.as_of,
      });
      continue;
    }
    unconfirmed.delete(e.event_id);                    // confirmed, or dismissed as a tombstone
    const existing = events.get(e.event_id) ?? { event_id: e.event_id };
    events.set(e.event_id, {
      ...existing,
      type: e.type ?? existing.type,
      start: e.start,
      canceled: e.change === 'canceled',
      calendar_event_id: e.calendar_event_id ?? existing.calendar_event_id ?? null,
    });
  }

  // A parked event whose question got answered without a re-emit would sit there
  // forever; drop the dangling link so the app can re-ask instead.
  for (const held of unconfirmed.values()) {
    if (held.question_id && resolved.has(held.question_id)) held.question_id = null;
  }

  return {
    schema_version: SCHEMA_VERSION,
    state_revision: payload.state_revision ?? state.state_revision,
    as_of: payload.as_of,
    profile: payload.profile ?? state.profile,
    open_questions: openQuestions,
    known_events: [...events.values()],
    unconfirmed_events: [...unconfirmed.values()],
  };
}

/** The needs_input entry holding a given id back, if there is one. */
function questionBlocking(payload, id) {
  return (payload.needs_input ?? []).find((q) => (q.blocks ?? []).includes(id))?.question_id ?? null;
}

/**
 * Everything parked waiting on her, ready to render: each held event paired with
 * the question that clears it. `question` is null when the engine asked nothing
 * or she already answered without a re-emit — surface those, they're stuck.
 */
export function pendingConfirmations(state) {
  const asked = new Map((state.open_questions ?? []).map((q) => [q.question_id, q]));
  return (state.unconfirmed_events ?? []).map((e) => ({
    ...e,
    question: asked.get(e.question_id)?.question ?? null,
    stuck: !asked.has(e.question_id),
  }));
}

/** Everything that wants her attention today. */
export function dueToday(payload, today = payload.as_of) {
  return (payload.alerts ?? []).filter((a) => a.fires_on <= today);
}

/* ---------- self-test ---------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, 'examples');
  const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  let failed = 0;
  const check = (name, fn) => {
    try { fn(); console.log(`ok    ${name}`); }
    catch (err) { failed++; console.error(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`); }
  };

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'inbound-state.json')) {
    check(`${file}`, () => {
      const payload = read(file);
      validatePayload(payload);
      const wrapped = '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
      if (JSON.stringify(extractPayload(wrapped)) !== JSON.stringify(payload)) throw new Error('round-trip mismatch');
    });
  }

  // The two-way loop: app state in, payload folded back over it.
  check('mid-season change folds into state', () => {
    const before = read('inbound-state.json');
    const after = applyPayload(before, read('midseason-change.json'));
    const eq = (label, got, want) => { if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
    eq('revision', after.state_revision, 16);
    eq('division', after.profile.division, 'U12');
    eq('coach', after.profile.coach.name, 'Tomas Reyes');
    eq('tight nights', after.profile.tight_nights.map((n) => n.night).join(','), 'monday,thursday');
    eq('answered question retired', after.open_questions.some((q) => q.question_id === 'q-2026-09-16-tuesday-window'), false);
    eq('new questions carried', after.open_questions.length, 2);
    eq('tuesday practice canceled', after.known_events.find((e) => e.event_id === 'practice-2026-09-15-tuesday').canceled, true);
    eq('new practices indexed', after.known_events.length, 4);
    eq('nothing parked', after.unconfirmed_events.length, 0);
  });

  // An unreadable row is held where she can see it, not dropped.
  check('a low-confidence event parks instead of disappearing', () => {
    const before = {
      schema_version: '1.1', state_revision: 11, as_of: '2026-09-06',
      profile: { season_id: 'marcus-fall-soccer', kid: 'Marcus', timezone: 'America/Los_Angeles' },
      open_questions: [], known_events: [], unconfirmed_events: [],
    };
    const after = applyPayload(before, read('schedule-photo.json'));
    const eq = (label, got, want) => { if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };
    eq('confident events indexed', after.known_events.length, 2);
    eq('the guess stayed out of the index', after.known_events.some((e) => e.event_id === 'game-2026-09-19-tbd'), false);
    eq('the guess is parked', after.unconfirmed_events.length, 1);
    const held = after.unconfirmed_events[0];
    eq('parked with its best read', held.proposed_start, '2026-09-19T09:00:00');
    eq('parked with its question', held.question_id, 'q-2026-09-06-sept19');
    eq('first seen', held.first_seen, '2026-09-06');

    const pending = pendingConfirmations(after);
    eq('renderable', pending[0].question.startsWith('The 9/19 row is creased'), true);
    eq('not stuck', pending[0].stuck, false);

    // Re-reading the same unclear row refreshes it rather than stacking a copy.
    const again = applyPayload(after, { ...read('schedule-photo.json'), as_of: '2026-09-07' });
    eq('no duplicate', again.unconfirmed_events.length, 1);
    eq('last seen moves', again.unconfirmed_events[0].last_seen, '2026-09-07');
    eq('first seen holds', again.unconfirmed_events[0].first_seen, '2026-09-06');

    // Her answer releases it into the real calendar.
    const confirmed = applyPayload(after, read('confirm-parked-event.json'));
    eq('holding area cleared', confirmed.unconfirmed_events.length, 0);
    eq('now a real event', confirmed.known_events.find((e) => e.event_id === 'game-2026-09-19-tbd').start, '2026-09-19T11:00:00');
    eq('question retired', confirmed.open_questions.length, 0);
  });

  check('a parked event she answered without a re-emit reads as stuck', () => {
    const before = {
      schema_version: '1.1', state_revision: 11, as_of: '2026-09-06',
      profile: { season_id: 'marcus-fall-soccer', kid: 'Marcus', timezone: 'America/Los_Angeles' },
      open_questions: [], known_events: [], unconfirmed_events: [],
    };
    const parked = applyPayload(before, read('schedule-photo.json'));
    // Question resolved, but the event never came back at high confidence.
    const orphaned = applyPayload(parked, {
      ...read('schedule-photo.json'), as_of: '2026-09-08', events: [],
      alerts: [], needs_input: [], resolved_questions: ['q-2026-09-06-sept19'],
    });
    if (orphaned.unconfirmed_events.length !== 1) throw new Error('the held row vanished');
    const [pending] = pendingConfirmations(orphaned);
    if (pending.question_id !== null || pending.stuck !== true) {
      throw new Error('a dangling held row should surface as stuck, not sit there silently');
    }
  });

  check('stale revision is a conflict, not a silent overwrite', () => {
    const before = { ...read('inbound-state.json'), state_revision: 22 };
    try { applyPayload(before, read('midseason-change.json')); }
    catch (err) { if (err instanceof PayloadError && /Revision conflict/.test(err.message)) return; throw err; }
    throw new Error('it did not throw');
  });

  // Contract violations must be caught, not passed through.
  const base = () => ({
    schema_version: '1.1', season_id: 'marcus-fall-soccer', state_revision: 3, as_of: '2026-09-06',
    input_kind: 'checkin', profile: null, profile_updates: [], events: [], alerts: [], digest: [],
    digest_stats: null, lists: [], plans: [], drills: [], drafts: [], answers: [], needs_input: [],
    resolved_questions: [],
  });
  const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```';
  const bad = [
    ['no fence', 'Sure! Here is your week: the game moved to 9am.'],
    ['truncated json', '```json\n{"schema_version": "1.1", "events": [\n```'],
    ['unknown version', fence({ ...base(), schema_version: '2.0' })],
    ['missing keys', '```json\n{"schema_version":"1.1","season_id":"x","as_of":"2026-09-06","input_kind":"checkin"}\n```'],
    ['bought something', fence({ ...base(), lists: [{ list_id: 'l', purpose: 'p', constraints: [], items: [], ready_to_order: true, ordered: true }] })],
    ['applied change with no profile', fence({ ...base(), profile_updates: [{ field: 'division', value: 'U12', reason: 'r', applied: true, authority: 'parent' }] })],
    ['proposal with nothing to decide it', fence({ ...base(), profile_updates: [{ field: 'division', value: 'U12', reason: 'r', applied: false, authority: 'parent' }] })],
    ['dropped a safety constraint', fence({
      ...base(), profile: { season_id: 'marcus-fall-soccer', kid: 'Marcus', timezone: 'America/Los_Angeles' },
      profile_updates: [{ field: 'constraints', value: ['no dairy (Marcus)'], previous: ['no dairy (Marcus)', 'nut-free field policy'], reason: 'r', applied: true, authority: 'engine' }],
    })],
    ['applied change with nowhere to write', fence({
      ...base(), state_revision: null, profile: { season_id: 'marcus-fall-soccer', kid: 'Marcus', timezone: 'America/Los_Angeles' },
      profile_updates: [{ field: 'division', value: 'U12', reason: 'r', applied: true, authority: 'parent' }],
    })],
  ];
  for (const [name, reply] of bad) {
    check(`rejects ${name}`, () => {
      try { extractPayload(reply); } catch (err) {
        if (err instanceof PayloadError) return;
        throw new Error(`threw ${err.name} instead of PayloadError`);
      }
      throw new Error('it did not throw');
    });
  }

  check('last fenced block wins', () => {
    const messy = 'Heads up:\n```json\n{"stale": true}\n```\nand the real one:\n'
      + '```json\n' + readFileSync(join(dir, 'emergency-question.json'), 'utf8') + '\n```';
    if (extractPayload(messy).input_kind !== 'question') throw new Error('picked the wrong block');
  });

  check('1.0 payloads still parse, but carry no state', () => {
    const legacy = { ...base(), schema_version: '1.0' };
    delete legacy.state_revision; delete legacy.profile; delete legacy.resolved_questions;
    validatePayload(legacy);
    try { applyPayload(read('inbound-state.json'), legacy); }
    catch (err) { if (/carries no state/.test(err.message)) return; throw err; }
    throw new Error('applyPayload accepted a 1.0 payload');
  });

  console.log(failed ? `\n${failed} failure(s)` : '\nall green');
  process.exit(failed ? 1 : 0);
}
