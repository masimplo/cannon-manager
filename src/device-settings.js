// Printer settings that Canon otherwise only exposes through the (broken) Remote UI:
// quiet mode, auto power on/off, ink drying wait, paper gap. Read with GetConfiguration and
// written with SetConfiguration (servicetype device) inside StartJob/EndJob on one CHMP session.
// Verified on the G5040 (fw 1.060) with a no-op write (drylevel 3 → 3) and read-back; the shape
// matches fixma-pixma and OpenIJ. Alignment values and ink detection are never written.

import { ChmpSession } from './chmp.js';

const NS = 'xmlns:ivec="http://www.canon.com/ns/cmd/2008/07/common/"';

export const SETTINGS = {
  quietMode: { label: 'Quiet mode' },
  autoPowerOn: { label: 'Auto power on' },
  autoPowerOff: { label: 'Auto power off' },
  dryLevel: { label: 'Ink drying wait time' },
  paperGap: { label: 'Prevent paper abrasion' },
};

function xml(operation, body) {
  return `<?xml version="1.0" encoding="utf-8"?><cmd ${NS}><ivec:contents><ivec:operation>${operation}</ivec:operation><ivec:param_set servicetype="device">${body}</ivec:param_set></ivec:contents></cmd>`;
}

const tag = (x, name) => new RegExp(`<ivec:${name}>([^<]*)</ivec:${name}>`).exec(x)?.[1] ?? null;
const block = (x, name) => new RegExp(`<ivec:${name}>([\\s\\S]*?)</ivec:${name}>`).exec(x)?.[1] ?? '';
const list = (s) => (s ? s.split(',').map((v) => v.trim()).filter(Boolean) : []);

export function parseConfiguration(x) {
  const off = block(x, 'autopoweroff');
  const quiet = block(x, 'silentmode');
  return {
    autoPowerOn: tag(x, 'autopoweron'),
    autoPowerOff: { mode: tag(off, 'mode'), time: Number(tag(off, 'time')) },
    quietMode: { mode: tag(quiet, 'mode'), start: tag(quiet, 'starttime'), end: tag(quiet, 'endtime') },
    paperGap: tag(x, 'papergap'),
    dryLevel: Number(tag(x, 'drylevel')),
    inkDetect: tag(x, 'ink_detect'),
  };
}

export function parseCapability(x) {
  const off = block(x, 'autopoweroff');
  return {
    autoPowerOn: list(tag(x, 'autopoweron')),
    autoPowerOff: { mode: list(tag(off, 'mode')), time: list(tag(off, 'time')).map(Number) },
    quietMode: { mode: list(tag(block(x, 'silentmode'), 'mode')) },
    paperGap: list(tag(x, 'papergap')),
    dryLevel: list(tag(x, 'drylevel')).map(Number),
  };
}

function check(ok, what) {
  if (!ok) throw Object.assign(new Error(`${what} is not supported by this printer`), { status: 400 });
}

const HHMM = /^([01]\d|2[0-3])[0-5]\d$/;

/** The XML element for one setting, validated against what the printer says it accepts. */
export function settingXml(key, value, cap) {
  switch (key) {
    case 'autoPowerOn':
      check(cap.autoPowerOn.includes(value), `Auto power on "${value}"`);
      return `<ivec:autopoweron>${value}</ivec:autopoweron>`;
    case 'autoPowerOff': {
      check(cap.autoPowerOff.mode.includes(value?.mode), `Auto power off "${value?.mode}"`);
      if (value.mode === 'OFF') return '<ivec:autopoweroff><ivec:mode>OFF</ivec:mode></ivec:autopoweroff>';
      const time = Number(value.time);
      check(cap.autoPowerOff.time.includes(time), `Auto power off after ${value.time} minutes`);
      return `<ivec:autopoweroff><ivec:mode>${value.mode}</ivec:mode><ivec:time>${time}</ivec:time></ivec:autopoweroff>`;
    }
    case 'quietMode': {
      check(cap.quietMode.mode.includes(value?.mode), `Quiet mode "${value?.mode}"`);
      if (value.mode !== 'time') return `<ivec:silentmode><ivec:mode>${value.mode}</ivec:mode></ivec:silentmode>`;
      if (!HHMM.test(value.start ?? '') || !HHMM.test(value.end ?? '')) {
        throw Object.assign(new Error('Quiet mode times must be HHMM, e.g. 2100 and 0700'), { status: 400 });
      }
      return `<ivec:silentmode><ivec:mode>time</ivec:mode><ivec:starttime>${value.start}</ivec:starttime><ivec:endtime>${value.end}</ivec:endtime></ivec:silentmode>`;
    }
    case 'paperGap':
      check(cap.paperGap.includes(value), `Paper gap "${value}"`);
      return `<ivec:papergap>${value}</ivec:papergap>`;
    case 'dryLevel':
      check(cap.dryLevel.includes(Number(value)), `Drying level ${value}`);
      return `<ivec:drylevel>${Number(value)}</ivec:drylevel>`;
    default:
      throw Object.assign(new Error(`"${key}" cannot be changed from this app`), { status: 400 });
  }
}

const field = (x, name) => tag(x, name) ?? '';
function expectOk(replyXml, step) {
  if (field(replyXml, 'response') !== 'OK') {
    const detail = field(replyXml, 'response_detail') || 'no reason given';
    throw Object.assign(new Error(`Printer refused ${step}: ${detail}`), { detail, status: 502 });
  }
}

function clock(now) {
  const d = now();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Write one setting on an open session. The job is always ended once it has started. */
export async function applySetting(session, key, value, cap, { now = () => new Date() } = {}) {
  try {
    const element = settingXml(key, value, cap);
    const jobId = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    const job = `<ivec:jobID>${jobId}</ivec:jobID>`;
    expectOk(await session.command(xml('StartJob', `${job}<ivec:bidi>1</ivec:bidi>`)), 'to start the settings change');
    let error = null;
    try {
      expectOk(await session.command(xml('SetConfiguration', `${job}<ivec:datetime>${clock(now)}</ivec:datetime>${element}`)), `the ${SETTINGS[key].label.toLowerCase()} change`);
    } catch (e) {
      error = e;
    }
    const end = await session.command(xml('EndJob', job));
    if (error) throw error;
    expectOk(end, 'to finish the settings change');
  } finally {
    session.close();
  }
}

async function query(host, operation) {
  const s = await new ChmpSession(host).open();
  try {
    return await s.command(xml(operation, ''));
  } finally {
    s.close();
  }
}

export async function getSettings(host) {
  const [config, capability] = await Promise.all([query(host, 'GetConfiguration'), query(host, 'GetCapability')]);
  return { settings: parseConfiguration(config), capability: parseCapability(capability) };
}

/** Write a setting, then read the settings back to confirm the printer kept it. */
export async function setSetting(host, key, value) {
  const { settings: before, capability } = await getSettings(host);
  await applySetting(await new ChmpSession(host).open(), key, value, capability);
  const { settings: after } = await getSettings(host);
  return { key, before: before[key], after: after[key], settings: after };
}
