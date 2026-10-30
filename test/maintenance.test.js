import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAINTENANCE, maintenanceCommand, runMaintenanceJob, parseMaintenanceStatus } from '../src/maintenance.js';

const reply = (op, response = 'OK', detail = '') =>
  `<?xml version="1.0" encoding="utf-8" ?><cmd><ivec:contents><ivec:operation>${op}Response</ivec:operation><ivec:param_set servicetype="maintenance"><ivec:response>${response}</ivec:response><ivec:response_detail>${detail}</ivec:response_detail><ivec:jobID>00000002</ivec:jobID></ivec:param_set></ivec:contents></cmd>`;

function fakeSession(responses = {}) {
  const sent = [];
  return {
    sent,
    closed: false,
    async command(xml) {
      const op = /<ivec:operation>(\w+)<\/ivec:operation>/.exec(xml)[1];
      sent.push(xml);
      return responses[op] ?? reply(op);
    },
    close() {
      this.closed = true;
    },
  };
}

const ops = (s) => s.sent.map((x) => /<ivec:operation>(\w+)/.exec(x)[1]);

test('nozzle check: StartJob, TestPrint nozzle_check from the cassette on plain A4, EndJob, all on one session', async () => {
  const s = fakeSession();
  const r = await runMaintenanceJob(s, 'nozzle-check');

  assert.deepEqual(ops(s), ['StartJob', 'TestPrint', 'EndJob']);
  const testPrint = s.sent[1];
  assert.match(testPrint, /servicetype="maintenance"/);
  assert.match(testPrint, /<ivec:type>nozzle_check<\/ivec:type>/);
  assert.match(testPrint, /<ivec:inputbin>inputbin_p2<\/ivec:inputbin>/);
  assert.match(testPrint, /<ivec:papersize>iso_a4_210x297mm<\/ivec:papersize>/);
  assert.match(testPrint, /<ivec:papertype>stationery<\/ivec:papertype>/);
  assert.ok(s.sent.every((x) => x.includes('<ivec:jobID>00000002</ivec:jobID>')), 'every command carries the same job id');
  assert.equal(r.accepted, true);
  assert.equal(s.closed, true);
});

test('cleaning and deep cleaning send the Cleaning operation for all ink groups', () => {
  assert.match(maintenanceCommand('cleaning', '00000002'), /<ivec:operation>Cleaning<\/ivec:operation>.*<ivec:type>regular<\/ivec:type><ivec:inkgroup>all<\/ivec:inkgroup>/);
  assert.match(maintenanceCommand('deep-cleaning', '00000002'), /<ivec:operation>Cleaning<\/ivec:operation>.*<ivec:type>deep<\/ivec:type><ivec:inkgroup>all<\/ivec:inkgroup>/);
  assert.match(maintenanceCommand('auto-align', '00000002'), /<ivec:type>auto_registration<\/ivec:type>/);
  assert.match(maintenanceCommand('align-check', '00000002'), /<ivec:type>regi_check<\/ivec:type>/);
});

test('Letter paper can be chosen for test prints; anything else is rejected', () => {
  assert.match(maintenanceCommand('nozzle-check', '00000002', { paper: 'letter' }), /na_letter_8\.5x11in/);
  assert.throws(() => maintenanceCommand('nozzle-check', '00000002', { paper: 'a3' }), /paper/i);
});

test('a refused operation is reported with the printer reason and the job is still ended', async () => {
  const s = fakeSession({ TestPrint: reply('TestPrint', 'NG', 'DeivceUseOtherJob') });
  await assert.rejects(runMaintenanceJob(s, 'nozzle-check'), /refused.*DeivceUseOtherJob/i);
  assert.deepEqual(ops(s), ['StartJob', 'TestPrint', 'EndJob']);
  assert.equal(s.closed, true);
});

test('if StartJob is refused nothing else is sent', async () => {
  const s = fakeSession({ StartJob: reply('StartJob', 'NG', 'Suspended') });
  await assert.rejects(runMaintenanceJob(s, 'cleaning'), /Suspended/);
  assert.deepEqual(ops(s), ['StartJob']);
});

test('unknown actions are rejected before anything is sent', async () => {
  const s = fakeSession();
  await assert.rejects(runMaintenanceJob(s, 'choke'), /unknown/i);
  assert.deepEqual(s.sent, []);
  assert.ok(!('choke' in MAINTENANCE), 'system flush is not offered');
});

test('maintenance status: running job vs. nothing running', () => {
  const running = '<ivec:response>OK</ivec:response><ivec:jobinfo jobID="00000002"><ivec:maintenance_operation>Cleaning</ivec:maintenance_operation><ivec:type>regular</ivec:type><ivec:jobprogress>processing</ivec:jobprogress></ivec:jobinfo>';
  assert.deepEqual(parseMaintenanceStatus(running), { running: true, operation: 'Cleaning', type: 'regular', progress: 'processing' });
  assert.deepEqual(parseMaintenanceStatus('<ivec:response>OK</ivec:response><ivec:jobinfo/>'), { running: false });
});
