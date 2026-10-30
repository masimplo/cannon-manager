import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseConfiguration, parseCapability, settingXml, applySetting, SETTINGS } from '../src/device-settings.js';

// Real GetConfiguration / GetCapability (servicetype device) replies from the G5040, 2026-10-30.
const CONFIG = readFileSync(new URL('./fixtures/chmp-config-device.xml', import.meta.url), 'utf8');
const CAPABILITY = readFileSync(new URL('./fixtures/chmp-capability-device.xml', import.meta.url), 'utf8');

const reply = (op, response = 'OK', detail = '') =>
  `<cmd><ivec:contents><ivec:operation>${op}Response</ivec:operation><ivec:param_set servicetype="device"><ivec:response>${response}</ivec:response><ivec:response_detail>${detail}</ivec:response_detail><ivec:jobID>00000003</ivec:jobID></ivec:param_set></ivec:contents></cmd>`;

function fakeSession(responses = {}) {
  return {
    sent: [],
    closed: false,
    async command(xml) {
      const op = /<ivec:operation>(\w+)<\/ivec:operation>/.exec(xml)[1];
      this.sent.push(xml);
      return responses[op] ?? reply(op);
    },
    close() {
      this.closed = true;
    },
  };
}
const ops = (s) => s.sent.map((x) => /<ivec:operation>(\w+)/.exec(x)[1]);
const cap = parseCapability(CAPABILITY);
const NOW = () => new Date(2026, 9, 30, 11, 5, 9);

test('reads the printer\'s current settings', () => {
  assert.deepEqual(parseConfiguration(CONFIG), {
    autoPowerOn: 'OFF',
    autoPowerOff: { mode: 'ON', time: 240 },
    quietMode: { mode: 'OFF', start: '2100', end: '0700' },
    paperGap: 'auto',
    dryLevel: 3,
    inkDetect: 'ON',
  });
});

test('reads which values the printer accepts', () => {
  assert.deepEqual(cap, {
    autoPowerOn: ['ON', 'OFF'],
    autoPowerOff: { mode: ['ON', 'OFF'], time: [15, 30, 60, 120, 240] },
    quietMode: { mode: ['ON', 'OFF', 'time'] },
    paperGap: ['auto', 'wide'],
    dryLevel: [1, 2, 3, 4, 5],
  });
});

test('builds the XML for each writable setting', () => {
  assert.equal(settingXml('autoPowerOn', 'ON', cap), '<ivec:autopoweron>ON</ivec:autopoweron>');
  assert.equal(settingXml('autoPowerOff', { mode: 'ON', time: 60 }, cap), '<ivec:autopoweroff><ivec:mode>ON</ivec:mode><ivec:time>60</ivec:time></ivec:autopoweroff>');
  assert.equal(settingXml('autoPowerOff', { mode: 'OFF' }, cap), '<ivec:autopoweroff><ivec:mode>OFF</ivec:mode></ivec:autopoweroff>');
  assert.equal(settingXml('quietMode', { mode: 'ON' }, cap), '<ivec:silentmode><ivec:mode>ON</ivec:mode></ivec:silentmode>');
  assert.equal(settingXml('quietMode', { mode: 'time', start: '2200', end: '0630' }, cap), '<ivec:silentmode><ivec:mode>time</ivec:mode><ivec:starttime>2200</ivec:starttime><ivec:endtime>0630</ivec:endtime></ivec:silentmode>');
  assert.equal(settingXml('paperGap', 'wide', cap), '<ivec:papergap>wide</ivec:papergap>');
  assert.equal(settingXml('dryLevel', 5, cap), '<ivec:drylevel>5</ivec:drylevel>');
});

test('refuses values the printer does not list, and settings that must never be written', () => {
  assert.throws(() => settingXml('dryLevel', 6, cap), /not supported/i);
  assert.throws(() => settingXml('autoPowerOff', { mode: 'ON', time: 45 }, cap), /not supported/i);
  assert.throws(() => settingXml('paperGap', 'narrow', cap), /not supported/i);
  assert.throws(() => settingXml('quietMode', { mode: 'time', start: '25:00', end: '0700' }, cap), /time/i);
  assert.throws(() => settingXml('inkDetect', 'OFF', cap), /cannot be changed/i);
  assert.throws(() => settingXml('alignment', {}, cap), /cannot be changed/i);
  assert.deepEqual(Object.keys(SETTINGS).sort(), ['autoPowerOff', 'autoPowerOn', 'dryLevel', 'paperGap', 'quietMode']);
});

test('a write is StartJob, SetConfiguration with the clock and one setting, EndJob, on one session', async () => {
  const s = fakeSession();
  await applySetting(s, 'autoPowerOn', 'ON', cap, { now: NOW });
  assert.deepEqual(ops(s), ['StartJob', 'SetConfiguration', 'EndJob']);
  assert.match(s.sent[0], /servicetype="device".*<ivec:bidi>1<\/ivec:bidi>/);
  assert.match(s.sent[1], /<ivec:jobID>(\d{8})<\/ivec:jobID><ivec:datetime>20261030110509<\/ivec:datetime><ivec:autopoweron>ON<\/ivec:autopoweron>/);
  const ids = s.sent.map((x) => /<ivec:jobID>(\d+)/.exec(x)[1]);
  assert.equal(new Set(ids).size, 1, 'same job id throughout');
  assert.equal(s.closed, true);
});

test('a refused write reports the printer\'s reason and still ends the job', async () => {
  const s = fakeSession({ SetConfiguration: reply('SetConfiguration', 'NG', 'NotSupportOperation') });
  await assert.rejects(applySetting(s, 'dryLevel', 4, cap, { now: NOW }), /NotSupportOperation/);
  assert.deepEqual(ops(s), ['StartJob', 'SetConfiguration', 'EndJob']);
});

test('an invalid value is rejected before anything is sent', async () => {
  const s = fakeSession();
  await assert.rejects(applySetting(s, 'dryLevel', 9, cap, { now: NOW }), /not supported/i);
  assert.deepEqual(s.sent, []);
});
