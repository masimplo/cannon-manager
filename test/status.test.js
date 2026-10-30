import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeMessage, groupAttrs } from '../src/ipp.js';
import { summarize } from '../src/status.js';

const fixtureAttrs = groupAttrs(
  decodeMessage(readFileSync(new URL('./fixtures/get-printer-attributes.bin', import.meta.url))),
  'printer',
);

test('real busy printer: reports cleaning, not-accepting and spool-full as reasons, not as a fault', () => {
  const s = summarize(fixtureAttrs, { busyState: '5', busyStateText: 'Cleaning in progress' });

  assert.equal(s.state, 'processing');
  assert.equal(s.health, 'busy');
  assert.equal(s.headline, 'Cleaning in progress');
  assert.equal(s.acceptingJobs, false);
  assert.deepEqual(
    s.inks.map((i) => [i.name, i.level, i.status]),
    [['Black (PGBK)', 80, 'ok'], ['Cyan', 50, 'ok'], ['Magenta', 50, 'ok'], ['Yellow', 60, 'ok']],
  );
  assert.ok(s.issues.some((i) => /spool area full/i.test(i.text)));
  assert.ok(s.issues.some((i) => /not accepting jobs/i.test(i.text)));
  assert.equal(s.firmware, '1.060');
});

test('ink at or below the low mark is flagged; 0 is empty and blocks printing', () => {
  const s = summarize({ ...fixtureAttrs, 'printer-state': 3, 'printer-state-reasons': 'none', 'printer-is-accepting-jobs': true, 'marker-levels': [15, 16, 0, 60] }, null);

  assert.deepEqual(s.inks.map((i) => i.status), ['low', 'ok', 'empty', 'ok']);
  assert.equal(s.health, 'error');
  assert.ok(s.issues.some((i) => i.severity === 'error' && /Magenta/.test(i.text)));
  assert.ok(s.issues.some((i) => i.severity === 'warning' && /Black/.test(i.text)));
});

test('idle with no reasons and healthy ink is healthy', () => {
  const s = summarize({ ...fixtureAttrs, 'printer-state': 3, 'printer-state-reasons': 'none', 'printer-is-accepting-jobs': true, 'printer-alert-description': 'Non-alert' }, null);
  assert.equal(s.health, 'ok');
  assert.equal(s.headline, 'Ready to print');
  assert.deepEqual(s.issues.filter((i) => i.severity !== 'info'), []);
});

test('stopped printer with error reasons is an error with readable reasons', () => {
  const s = summarize({ ...fixtureAttrs, 'printer-state': 5, 'printer-state-reasons': ['media-empty-error', 'media-jam-warning'], 'printer-is-accepting-jobs': true }, null);
  assert.equal(s.health, 'error');
  assert.ok(s.issues.some((i) => i.severity === 'error' && /out of paper/i.test(i.text)));
  assert.ok(s.issues.some((i) => i.severity === 'warning' && /paper jam/i.test(i.text)));
});

test('maintenance is blocked while the printer is busy or stopped, allowed when ready', async () => {
  const { maintenanceBlockedReason } = await import('../src/status.js');
  const idle = { ...fixtureAttrs, 'printer-state': 3, 'printer-state-reasons': 'none', 'printer-is-accepting-jobs': true };

  assert.match(maintenanceBlockedReason(summarize(fixtureAttrs, { busyState: '5', busyStateText: 'Cleaning in progress' })), /Cleaning in progress/);
  assert.match(maintenanceBlockedReason(summarize({ ...idle, 'printer-state': 5 }, null)), /stopped/i);
  // IPP says idle but the Remote UI still reports a test print running: trust the busier signal.
  assert.match(maintenanceBlockedReason(summarize(idle, { busyState: '6', busyStateText: 'Test printing in progress' })), /Test printing/);
  assert.equal(maintenanceBlockedReason(summarize(idle, { busyState: '0', busyStateText: 'Ready to print' })), null);
  assert.equal(maintenanceBlockedReason(summarize(idle, null)), null);
});

test('a running maintenance job shows as busy with its name and blocks further maintenance', async () => {
  const { maintenanceBlockedReason } = await import('../src/status.js');
  const idle = { ...fixtureAttrs, 'printer-state': 3, 'printer-state-reasons': 'none', 'printer-is-accepting-jobs': true };
  const s = summarize(idle, { busyState: '0', busyStateText: 'Ready to print' }, { running: true, operation: 'Cleaning', type: 'deep', progress: 'processing' });
  assert.equal(s.health, 'busy');
  assert.equal(s.headline, 'Deep cleaning in progress');
  assert.match(maintenanceBlockedReason(s), /Deep cleaning in progress/);
});

test('maintenance started from the printer panel gets a readable name', () => {
  const idle = { ...fixtureAttrs, 'printer-state': 4, 'printer-state-reasons': 'none' };
  const headline = (operation, type = '') => summarize(idle, null, { running: true, operation, type, progress: 'processing' }).headline;
  // Reported by the G5040 on 2026-10-30 during a cleaning started from its panel.
  assert.equal(headline('RollerCleaning'), 'Roller cleaning in progress');
  assert.equal(headline('Cleaning', 'choke'), 'Ink flush in progress');
  assert.equal(headline('Cleaning', 'regular'), 'Cleaning in progress');
  // Unknown operations are still shown, split into words, never hidden.
  assert.equal(headline('BottomPlateCleaning'), 'Bottom plate cleaning in progress');
});
