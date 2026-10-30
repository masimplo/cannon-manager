// High-level printer operations used by the HTTP API.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ippRequest, groupAttrs, decodeMessage, STATUS, OP } from './ipp.js';
import http from 'node:http';
import { getRemoteUiStatus } from './canon.js';
import { getMaintenanceStatus } from './maintenance.js';
import { summarize } from './status.js';
import { getChmpStatus } from './chmp.js';

const run = promisify(execFile);

export async function getAttributes(host, which = ['all']) {
  const res = await ippRequest({ host }, OP.GET_PRINTER_ATTRIBUTES, [['requested-attributes', 'keyword', which]]);
  return groupAttrs(res, 'printer');
}

export async function getStatus(host) {
  const [attrs, remoteUi, chmp] = await Promise.all([
    getAttributes(host),
    getRemoteUiStatus(host).catch((e) => ({ error: e.message })),
    getChmpStatus(host).catch((e) => ({ error: e.message })),
  ]);
  const maintenance = await getMaintenanceStatus(host).catch(() => null);
  const summary = summarize(attrs, remoteUi.error ? null : remoteUi, maintenance);
  // Every signal the printer exposes, logged on change, so operations that don't move the
  // headline (an ink flush started from the panel did not, on 2026-10-30) still leave a trace.
  summary.raw = {
    ippState: attrs['printer-state'],
    ippReasons: [].concat(attrs['printer-state-reasons'] ?? []),
    remoteUiCode: remoteUi.error ? null : remoteUi.busyState,
    chmpStatus: chmp.error ? null : chmp.print.status,
    chmpStatusDetail: chmp.error ? null : chmp.print.statusDetail,
    supportCode: chmp.error ? null : chmp.print.supportCode,
    chmpJob: chmp.error ? null : chmp.print.jobInfo,
    maintenance: maintenance?.running ? maintenance : null,
    totalSheets: chmp.error ? null : chmp.device.totalSheets,
  };
  if (!chmp.error) {
    summary.trays = chmp.print.trays;
    summary.supportCode = chmp.print.supportCode;
    summary.sheetsFed = chmp.device.sheetsFed;
    summary.totalSheets = chmp.device.totalSheets;
    summary.headReplacements = chmp.device.headReplacements;
    if (chmp.print.supportCode) {
      summary.issues.unshift({ severity: 'error', text: `Printer support code ${chmp.print.supportCode}${chmp.print.statusDetail ? ` (${chmp.print.statusDetail})` : ''}. Look this code up in Canon's online manual for the G5000 series.`, code: 'support-code' });
      summary.health = 'error';
    }
  }
  return { summary, remoteUiError: remoteUi.error ?? null, chmpError: chmp.error ?? null, attrs };
}

const JOB_STATES = { 3: 'pending', 4: 'held', 5: 'processing', 6: 'stopped', 7: 'canceled', 8: 'aborted', 9: 'completed' };

export async function getJobs(host) {
  const attrs = ['job-id', 'job-name', 'job-state', 'job-state-reasons', 'job-originating-user-name', 'time-at-creation', 'time-at-completed', 'job-impressions-completed', 'job-printer-up-time'];
  const fetch = async (which) => {
    const res = await ippRequest({ host }, OP.GET_JOBS, [
      ['requesting-user-name', 'name', 'g5040-manager'],
      ['which-jobs', 'keyword', which],
      ['requested-attributes', 'keyword', attrs],
    ]);
    return res.groups.filter((g) => g.tag === 'job').map((g) => ({ ...g.attrs, state: JOB_STATES[g.attrs['job-state']] ?? g.attrs['job-state'] }));
  };
  const [active, completed] = await Promise.all([fetch('not-completed'), fetch('completed').catch(() => [])]);
  return { active, completed };
}

export async function cancelJob(host, jobId) {
  const res = await ippRequest({ host }, OP.CANCEL_JOB, [['job-id', 'integer', jobId], ['requesting-user-name', 'name', 'g5040-manager']]);
  return { status: res.status };
}

export async function identify(host) {
  const res = await ippRequest({ host }, OP.IDENTIFY_PRINTER, [['identify-actions', 'keyword', 'flash']]);
  return { status: res.status };
}

/** Print a JPEG with standard IPP job attributes. Other image types are converted with macOS sips first. */
export async function printJpeg(host, jpeg, opts = {}) {
  const jobAttrs = [];
  if (opts.copies) jobAttrs.push(['copies', 'integer', Number(opts.copies)]);
  if (opts.media) jobAttrs.push(['media', 'keyword', opts.media]);
  if (opts.sides) jobAttrs.push(['sides', 'keyword', opts.sides]);
  if (opts.colorMode) jobAttrs.push(['print-color-mode', 'keyword', opts.colorMode]);
  if (opts.quality) jobAttrs.push(['print-quality', 'enum', Number(opts.quality)]);
  const res = await ippRequest({ host, timeoutMs: 60000 }, OP.PRINT_JOB, [
    ['requesting-user-name', 'name', 'g5040-manager'],
    ['job-name', 'name', opts.jobName ?? 'G5040 Manager'],
    ['document-format', 'mimeMediaType', 'image/jpeg'],
  ], jobAttrs, jpeg);
  const job = groupAttrs(res, 'job');
  const unsupported = groupAttrs(res, 'unsupported');
  return { status: res.status, ok: res.statusCode < 0x0100, jobId: job['job-id'], jobState: JOB_STATES[job['job-state']], unsupported };
}

export async function toJpeg(inputPath, outputPath) {
  await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', inputPath, '--out', outputPath]);
  return outputPath;
}

/** Find Canon printers advertised over Bonjour (macOS dns-sd). Returns [{ name, host, port, txt }]. */
export async function discover(timeoutMs = 3000) {
  const browse = await collect(['-B', '_ipp._tcp', 'local.'], timeoutMs);
  const names = [...new Set([...browse.matchAll(/\s+Add\s+\d+\s+\d+\s+local\.\s+_ipp\._tcp\.\s+(.+)$/gm)].map((m) => m[1].trim()))];
  const found = [];
  for (const name of names) {
    const lookup = await collect(['-L', name, '_ipp._tcp', 'local.'], 2000);
    const m = /can be reached at (\S+?)\.?:(\d+)/.exec(lookup);
    if (!m) continue;
    const hostname = m[1];
    const ip = await resolveHost(hostname);
    found.push({ name, hostname, host: ip ?? hostname, port: Number(m[2]), canon: /canon/i.test(name + lookup), txt: lookup.split('\n').find((l) => l.includes('txtvers'))?.trim() ?? '' });
  }
  return found;
}

function collect(args, ms) {
  return new Promise((resolve) => {
    let out = '';
    const child = execFile('/usr/bin/dns-sd', args);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(out));
    setTimeout(() => {
      child.kill();
      resolve(out);
    }, ms);
  });
}

async function resolveHost(hostname) {
  try {
    const { stdout } = await run('/usr/bin/dscacheutil', ['-q', 'host', '-a', 'name', hostname]);
    return /ip_address:\s*(\S+)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** macOS CUPS queues that point at this printer, with their enabled state and waiting jobs. */
export async function getMacQueues(host) {
  const { stdout: devices } = await run('/usr/bin/lpstat', ['-v']).catch(() => ({ stdout: '' }));
  const names = devices.split('\n').filter((l) => /canon|g5000|g5040/i.test(l) || l.includes(host)).map((l) => /device for ([^:]+):/.exec(l)?.[1]).filter(Boolean);
  const { stdout: printers } = await run('/usr/bin/lpstat', ['-p', ...names]).catch(() => ({ stdout: '' }));
  return Promise.all(names.map(async (name) => {
    const line = printers.split('\n').find((l) => l.startsWith(`printer ${name} `)) ?? '';
    const { stdout: jobs } = await run('/usr/bin/lpstat', ['-o', name]).catch(() => ({ stdout: '' }));
    return { name, enabled: !/disabled/.test(line), state: line.replace(`printer ${name} `, '').trim(), jobs: jobs.trim() ? jobs.trim().split('\n').map((j) => j.trim()) : [] };
  }));
}

export async function resumeMacQueue(name) {
  const queues = await getMacQueues('');
  if (!queues.some((q) => q.name === name)) throw Object.assign(new Error(`No macOS queue named ${name}`), { status: 404 });
  await run('/usr/sbin/cupsenable', [name]);
  await run('/usr/sbin/cupsaccept', [name]).catch(() => {});
  return (await getMacQueues('')).find((q) => q.name === name);
}

/** POST a complete, already-encoded IPP request (e.g. a replayed captured job) to the printer. */
export function postRawPrintJob(host, body, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: 631, path: '/ipp/print', method: 'POST', headers: { 'Content-Type': 'application/ipp', 'Content-Length': body.length }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const msg = decodeMessage(Buffer.concat(chunks));
          const job = groupAttrs(msg, 'job');
          resolve({ status: STATUS[msg.statusCode] ?? `0x${msg.statusCode.toString(16)}`, ok: msg.statusCode < 0x0100, jobId: job['job-id'] });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`IPP request timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}
