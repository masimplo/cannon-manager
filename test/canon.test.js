import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMaintenanceJob, MAINTENANCE, parseRemoteUiModel } from '../src/canon.js';

const START_JOB =
  '<?xml version="1.0" encoding="utf-8" ?><cmd xmlns:ivec="http://www.canon.com/ns/cmd/2008/07/common/"><ivec:contents><ivec:operation>StartJob</ivec:operation><ivec:param_set servicetype="print"><ivec:jobID>00000001</ivec:jobID><ivec:bidi>0</ivec:bidi></ivec:param_set></ivec:contents></cmd>';
const END_JOB =
  '<?xml version="1.0" encoding="utf-8" ?><cmd xmlns:ivec="http://www.canon.com/ns/cmd/2008/07/common/"><ivec:contents><ivec:operation>EndJob</ivec:operation><ivec:param_set servicetype="print"><ivec:jobID>00000001</ivec:jobID></ivec:param_set></ivec:contents></cmd>';

test('nozzle check job: IVEC StartJob, BJL block with the PPD command, IVEC EndJob', () => {
  const job = buildMaintenanceJob(MAINTENANCE['nozzle-check'].command);
  const s = job.toString('latin1');

  assert.ok(s.startsWith(START_JOB), 'starts with the IVEC StartJob envelope');
  assert.ok(s.endsWith(END_JOB), 'ends with the IVEC EndJob envelope');
  // ESC [ K 02 00 00 1F is the BJL entry sequence used by Canon's cmdtocanonij2 and Gutenprint.
  const bjl = Buffer.concat([
    Buffer.from([0x1b, 0x5b, 0x4b, 0x02, 0x00, 0x00, 0x1f]),
    Buffer.from('BJLSTART\nControlMode=Common\n@TestPrint=NozzleCheck\nBJLEND\n', 'latin1'),
  ]);
  assert.notEqual(job.indexOf(bjl), -1, 'contains the exact BJL control block');
});

test('maintenance commands match the strings in Canon G-series PPDs', () => {
  assert.equal(MAINTENANCE['nozzle-check'].command, '@TestPrint=NozzleCheck');
  assert.equal(MAINTENANCE.cleaning.command, '@Cleaning=1ALL');
  assert.equal(MAINTENANCE['auto-align'].command, '@TestPrint=Regi_Auto1');
});

test('refuses raw commands that could break out of the BJL block', () => {
  assert.throws(() => buildMaintenanceJob('@Cleaning=1ALL\nBJLEND'), /single line/i);
  assert.throws(() => buildMaintenanceJob(''), /empty/i);
  assert.throws(() => buildMaintenanceJob('@Cleaning=ÿ'), /ASCII/i);
});

test('reads status and settings from the Remote UI model.js', () => {
  const model = parseRemoteUiModel(`var g_Administrator = 0;
var inkCOL = ['InkBlk',  'InkCia', 'InkMaz', 'InkYel'];
var g_err_msg_id = 'HTTP_ERR_DISP_IDLE';
var g_bst_st = '5';
var g_network_mode='LAN_IF_WIRED';
var g_password_enable=1;
var g_firm_up_date=0;`);

  assert.equal(model.busyState, '5');
  assert.equal(model.busyStateText, 'Cleaning in progress');
  assert.equal(model.errorMessageId, 'HTTP_ERR_DISP_IDLE');
  assert.equal(model.vars.g_network_mode, 'LAN_IF_WIRED');
  assert.equal(model.vars.g_password_enable, 1);
});

test('unknown Remote UI busy state is reported, not hidden', () => {
  const model = parseRemoteUiModel("var g_bst_st = '42';");
  assert.equal(model.busyStateText, 'Unknown state (42)');
});
