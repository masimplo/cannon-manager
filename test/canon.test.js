import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteUiModel } from '../src/canon.js';

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
