/**
 * Reference extractor for Season Engine payloads.
 *
 * The engine answers with exactly one fenced `json` block and nothing else.
 * This pulls it out and checks the envelope's shape, so the interface never
 * renders a half-parsed turn. No dependencies — drop it anywhere.
 *
 *   import { extractPayload } from './parse-payload.mjs'
 *   const payload = extractPayload(reply)   // throws PayloadError on anything odd
 *
 * Run it directly to check the bundled examples: node parse-payload.mjs
 */

export const SCHEMA_VERSION = '1.0';

/** Top-level keys the engine promises on every turn. */
export const REQUIRED_KEYS = [
  'schema_version', 'season_id', 'as_of', 'input_kind', 'profile_updates',
  'events', 'alerts', 'digest', 'digest_stats', 'lists', 'plans', 'drills',
  'drafts', 'answers', 'needs_input',
];

/** Keys that are always arrays — empty means "nothing this turn", never absent. */
export const ARRAY_KEYS = [
  'profile_updates', 'events', 'alerts', 'digest', 'lists', 'plans', 'drills',
  'drafts', 'answers', 'needs_input',
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
  for (const key of REQUIRED_KEYS) {
    if (!(key in payload)) problems.push(`missing key: ${key}`);
  }
  for (const key of ARRAY_KEYS) {
    if (key in payload && !Array.isArray(payload[key])) {
      problems.push(`${key} must be an array (got ${typeof payload[key]})`);
    }
  }
  if (payload.schema_version !== SCHEMA_VERSION) {
    problems.push(`schema_version is ${JSON.stringify(payload.schema_version)}, expected "${SCHEMA_VERSION}"`);
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

  if (problems.length) {
    throw new PayloadError(`Payload failed validation:\n  - ${problems.join('\n  - ')}`);
  }
  return payload;
}

/** Everything that wants her attention today, newest lead time first. */
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
  let failed = 0;

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const payload = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    try {
      validatePayload(payload);
      const wrapped = `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
      const round = extractPayload(wrapped);
      if (JSON.stringify(round) !== JSON.stringify(payload)) throw new Error('round-trip mismatch');
      console.log(`ok    ${file}  (${dueToday(payload).length} alert(s) due on ${payload.as_of})`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${file}\n${err.message}`);
    }
  }

  // Contract violations must be caught, not passed through.
  const bad = [
    ['no fence', 'Sure! Here is your week: the game moved to 9am.'],
    ['truncated json', '```json\n{"schema_version": "1.0", "events": [\n```'],
    ['missing keys', '```json\n{"schema_version":"1.0","season_id":"x","as_of":"2026-09-06","input_kind":"checkin"}\n```'],
    ['bought something', '```json\n' + JSON.stringify({
      schema_version: '1.0', season_id: 'x', as_of: '2026-09-06', input_kind: 'checkin',
      profile_updates: [], events: [], alerts: [], digest: [], digest_stats: null,
      lists: [{ list_id: 'l', purpose: 'p', constraints: [], items: [], ready_to_order: true, ordered: true }],
      plans: [], drills: [], drafts: [], answers: [], needs_input: [],
    }) + '\n```'],
  ];
  for (const [name, reply] of bad) {
    try {
      extractPayload(reply);
      failed++;
      console.error(`FAIL  rejects ${name}: it did not throw`);
    } catch (err) {
      if (err instanceof PayloadError) console.log(`ok    rejects ${name}`);
      else { failed++; console.error(`FAIL  rejects ${name}: threw ${err.name}`); }
    }
  }

  // Prose around the block still parses, and the last block wins.
  const messy = 'Heads up:\n```json\n{"stale": true}\n```\nand the real one:\n```json\n'
    + readFileSync(join(dir, 'emergency-question.json'), 'utf8') + '\n```';
  try {
    const p = extractPayload(messy);
    if (p.input_kind !== 'question') throw new Error('picked the wrong block');
    console.log('ok    last fenced block wins');
  } catch (err) {
    failed++;
    console.error(`FAIL  last fenced block wins: ${err.message}`);
  }

  console.log(failed ? `\n${failed} failure(s)` : '\nall green');
  process.exit(failed ? 1 : 0);
}
