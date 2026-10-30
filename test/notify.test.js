import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notifier, statusEvents, appleScriptString } from '../src/notify.js';

const at = (h, m = 0) => () => new Date(2026, 9, 30, h, m);
const ok = { reachable: true, supportCode: null, inks: [{ name: 'Cyan', status: 'ok', level: 30 }], issues: [] };

function notifier(opts = {}) {
  const sent = [];
  const n = new Notifier({ send: async (title, message) => (sent.push({ title, message }), 0), now: at(12), ...opts });
  return { n, sent };
}

test('a new support code notifies once, and again only after it cleared and came back', async () => {
  const { n, sent } = notifier();
  const err = { ...ok, supportCode: '1300', supportLabel: 'Paper jam' };
  for (const e of statusEvents(ok, err)) await n.handle(e);
  for (const e of statusEvents(err, err)) await n.handle(e);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /1300.*Paper jam/);
  for (const e of statusEvents(err, ok)) await n.handle(e);
  for (const e of statusEvents(ok, err)) await n.handle(e);
  assert.equal(sent.length, 2);
});

test('ink becoming low or empty notifies; staying low does not', () => {
  const low = { ...ok, inks: [{ name: 'Cyan', status: 'low', level: 12 }] };
  const empty = { ...ok, inks: [{ name: 'Cyan', status: 'empty', level: 0 }] };
  const notes = (evs) => evs.filter((e) => !e.clear);
  assert.deepEqual(notes(statusEvents(ok, low)).map((e) => [e.category, e.key]), [['ink', 'ink-low:Cyan']]);
  assert.deepEqual(statusEvents(low, low), []);
  assert.deepEqual(notes(statusEvents(low, empty)).map((e) => e.key), ['ink-empty:Cyan']);
  // A refill clears the condition, so the next time it runs low it notifies again.
  assert.deepEqual(statusEvents(empty, ok), [{ clear: 'ink-empty:Cyan' }]);
});

test('offline notifies only after two unreachable polls in a row, then "back online" once', () => {
  const off = { reachable: false };
  assert.deepEqual(statusEvents(ok, off, { unreachableStreak: 1 }), []);
  assert.deepEqual(statusEvents(off, off, { unreachableStreak: 2 }).filter((e) => !e.clear).map((e) => e.key), ['offline']);
  assert.deepEqual(statusEvents(off, ok, { unreachableStreak: 0, wasOfflineNotified: true }).filter((e) => !e.clear).map((e) => e.key), ['online']);
  assert.deepEqual(statusEvents(off, ok, { unreachableStreak: 0, wasOfflineNotified: false }), []);
});

test('categories can be switched off, and everything can be muted', async () => {
  const { n, sent } = notifier({ prefs: { categories: { ink: false } } });
  await n.handle({ category: 'ink', key: 'ink-low:Cyan', title: 't', message: 'm' });
  assert.equal(sent.length, 0);
  await n.handle({ category: 'error', key: 'code:1300', title: 't', message: 'm' });
  assert.equal(sent.length, 1);
  n.prefs.mute = true;
  await n.handle({ category: 'error', key: 'code:5100', title: 't', message: 'm' });
  assert.equal(sent.length, 1);
});

test('quiet hours hold back routine notifications but not errors', async () => {
  const { n, sent } = notifier({ now: at(23, 30), prefs: { quietStart: 21, quietEnd: 9 } });
  await n.handle({ category: 'job', key: 'job:1', title: 't', message: 'done' });
  await n.handle({ category: 'error', key: 'code:1300', title: 't', message: 'jam' });
  assert.deepEqual(sent.map((s) => s.message), ['jam']);
});

test('every send is logged with its result, including failures', async () => {
  const log = [];
  const n = new Notifier({ send: async () => 1, now: at(12), log: (e) => log.push(e) });
  await n.handle({ category: 'error', key: 'code:1', title: 't', message: 'm' });
  assert.equal(log.length, 1);
  assert.equal(log[0].exitCode, 1);
});

test('text is escaped for AppleScript so quotes and backslashes cannot break the command', () => {
  assert.equal(appleScriptString('Say "hi" \\ bye'), '"Say \\"hi\\" \\\\ bye"');
});
