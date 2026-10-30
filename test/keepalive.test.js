import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeActivity, decideKeepAlive } from '../src/keepalive.js';

const DAY = 24 * 3600 * 1000;
const t0 = new Date(2026, 9, 1, 12).getTime(); // a Thursday noon
const ready = {
  reachable: true, state: 'idle', acceptingJobs: true, supportCode: null, issues: [], maintenanceRunning: false,
  cassettePaper: true, totalSheets: 5846,
};
const prefs = { enabled: true, days: 7, windowStart: 9, windowEnd: 21 };

test('any sheet fed, from any device, counts as activity; so does maintenance', () => {
  let s = observeActivity({}, ready, t0);
  assert.equal(s.lastActivityAt, t0, 'first observation starts the clock');
  s = observeActivity(s, ready, t0 + DAY);
  assert.equal(s.lastActivityAt, t0, 'same counter: no activity');
  s = observeActivity(s, { ...ready, totalSheets: 5847 }, t0 + 2 * DAY);
  assert.equal(s.lastActivityAt, t0 + 2 * DAY);
  s = observeActivity(s, { ...ready, totalSheets: 5847, maintenanceRunning: true }, t0 + 3 * DAY);
  assert.equal(s.lastActivityAt, t0 + 3 * DAY, 'a cleaning wets the nozzles too');
  s = observeActivity(s, { reachable: false }, t0 + 4 * DAY);
  assert.equal(s.lastActivityAt, t0 + 3 * DAY, 'unreachable polls change nothing');
});

test('runs after 7 idle days, inside the daytime window, when the printer is ready', () => {
  const state = { lastActivityAt: t0, lastSheets: 5846 };
  assert.equal(decideKeepAlive({ now: t0 + 6.9 * DAY, state, status: ready, prefs }).run, false);
  const d = decideKeepAlive({ now: t0 + 7 * DAY + 3600e3, state, status: ready, prefs });
  assert.equal(d.run, true, d.reason);
});

test('waits for the daytime window', () => {
  const state = { lastActivityAt: t0 };
  const night = new Date(2026, 9, 8, 23).getTime();
  const d = decideKeepAlive({ now: night, state, status: ready, prefs });
  assert.equal(d.run, false);
  assert.match(d.reason, /09:00/);
});

test('never more than once per interval, even if nothing else printed', () => {
  const state = { lastActivityAt: t0, lastRunAt: t0 + 7 * DAY };
  assert.equal(decideKeepAlive({ now: t0 + 10 * DAY, state, status: ready, prefs }).run, false);
  assert.equal(decideKeepAlive({ now: t0 + 14.1 * DAY, state, status: ready, prefs }).run, true);
});

test('skips with a reason when the printer is not ready for it', () => {
  const state = { lastActivityAt: t0 };
  const now = t0 + 8 * DAY;
  const cases = [
    [{ ...ready, reachable: false }, /not reachable/i],
    [{ ...ready, state: 'processing' }, /busy/i],
    [{ ...ready, maintenanceRunning: true }, /busy/i],
    [{ ...ready, supportCode: '1300' }, /1300/],
    [{ ...ready, issues: [{ severity: 'error', text: 'Out of paper' }] }, /Out of paper/],
    [{ ...ready, cassettePaper: false }, /cassette/i],
    [{ ...ready, acceptingJobs: false }, /not accepting/i],
  ];
  for (const [status, reason] of cases) {
    const d = decideKeepAlive({ now, state, status, prefs });
    assert.equal(d.run, false, JSON.stringify(status));
    assert.match(d.reason, reason);
  }
});

test('switched off means never', () => {
  const d = decideKeepAlive({ now: t0 + 30 * DAY, state: { lastActivityAt: t0 }, status: ready, prefs: { ...prefs, enabled: false } });
  assert.equal(d.run, false);
});

test('when the printer turns itself off and will not wake for jobs, the skip says how to fix it', () => {
  const d = decideKeepAlive({ now: t0 + 8 * DAY, state: { lastActivityAt: t0 }, status: { ...ready, reachable: false, autoPowerOn: 'OFF' }, prefs });
  assert.equal(d.run, false);
  assert.match(d.reason, /Auto power on/);
});
