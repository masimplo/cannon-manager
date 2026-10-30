// Network and service checks. Each check returns { id, title, result: pass|warn|fail|info, detail, ms }.

import net from 'node:net';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchPrinterHttp, parseRemoteUiModel } from './canon.js';
import { getAttributes } from './printer.js';

const run = promisify(execFile);

function tcpCheck(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    const done = (ok, err) => {
      sock.destroy();
      resolve({ ok, ms: Date.now() - started, error: err?.message });
    };
    sock.setTimeout(timeoutMs, () => done(false, new Error('timed out')));
    sock.on('connect', () => done(true));
    sock.on('error', (e) => done(false, e));
  });
}

function tlsCheck(host, port = 443, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = tls.connect({ host, port, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = sock.getPeerCertificate();
      resolve({ ok: true, ms: Date.now() - started, protocol: sock.getProtocol(), cert, authorized: sock.authorized, authError: sock.authorizationError });
      sock.end();
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ ok: false, error: 'timed out' });
    });
    sock.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

async function timed(fn) {
  const started = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  }
}

export async function runDiagnostics(host) {
  const checks = [];
  const add = (c) => checks.push(c);

  const ports = [
    [80, 'Web server (Remote UI, HTTP)', true],
    [443, 'Web server (Remote UI, HTTPS)', false],
    [631, 'IPP / AirPrint', true],
    [9100, 'Raw printing (used for maintenance commands)', true],
  ];
  const portResults = await Promise.all(ports.map(([p]) => tcpCheck(host, p)));
  ports.forEach(([port, title, required], i) => {
    const r = portResults[i];
    add({
      id: `port-${port}`,
      title: `Port ${port}: ${title}`,
      result: r.ok ? 'pass' : required ? 'fail' : 'warn',
      detail: r.ok ? `Open, connected in ${r.ms} ms` : `Not reachable (${r.error ?? 'refused'})`,
      ms: r.ms,
    });
  });

  if (portResults.every((r) => !r.ok)) {
    add({ id: 'reachable', title: 'Printer reachable', result: 'fail', detail: `Nothing answers at ${host}. Check that the printer is on, on the same network, and that its IP has not changed (print the network settings page from the printer).` });
    return { host, checks, ranAt: new Date().toISOString() };
  }

  const ipp = await timed(() => getAttributes(host));
  if (ipp.error) {
    add({ id: 'ipp', title: 'IPP printer attributes', result: 'fail', detail: ipp.error.message, ms: ipp.ms });
  } else {
    const a = ipp.value;
    add({ id: 'ipp', title: 'IPP printer attributes', result: 'pass', detail: `${Object.keys(a).length} attributes in ${ipp.ms} ms. ${a['printer-make-and-model']}, firmware ${a['printer-firmware-string-version']}`, ms: ipp.ms });
    const clock = a['printer-current-time'];
    if (clock && clock.startsWith('1970')) {
      add({ id: 'clock', title: 'Printer clock', result: 'info', detail: `The printer's clock is not set (it reports ${clock}). This is normal for PIXMA models without a time source; job timestamps from the printer will be wrong.` });
    }
    const up = a['printer-up-time'];
    if (typeof up === 'number') {
      add({ id: 'uptime', title: 'Printer up time', result: 'info', detail: `${Math.floor(up / 3600)} h ${Math.floor((up % 3600) / 60)} min since power on${up < 600 ? '. Recently powered on: G-series printers often run an automatic cleaning after power on, during which they refuse jobs.' : ''}` });
    }
    if (a['printer-is-accepting-jobs'] === false) {
      add({ id: 'accepting', title: 'Accepting jobs', result: a['printer-state'] === 4 ? 'warn' : 'fail', detail: `The printer reports it is not accepting jobs (state reasons: ${[].concat(a['printer-state-reasons']).join(', ')}). ${a['printer-state'] === 4 ? 'It is busy; this usually clears when the current task ends.' : 'It is not busy, so something is blocking it; check the printer panel.'}` });
    } else {
      add({ id: 'accepting', title: 'Accepting jobs', result: 'pass', detail: 'Yes' });
    }
  }

  // Remote UI: the page itself and every script/stylesheet it loads.
  const index = await timed(() => fetchPrinterHttp(host, '/index.html'));
  if (index.error || index.value.status !== 200) {
    add({ id: 'rui-index', title: 'Remote UI page', result: 'fail', detail: index.error?.message ?? `HTTP ${index.value.status}`, ms: index.ms });
  } else {
    const html = index.value.body.toString('utf8');
    const assets = [...html.matchAll(/(?:src|href)="(rui\/[^"]+|JS_MDL\/[^"]+|LANG\/[^"]+)"/g)].map((m) => `/${m[1]}`);
    const results = await Promise.all(assets.map((p) => timed(() => fetchPrinterHttp(host, p))));
    const broken = assets.filter((p, i) => results[i].error || results[i].value.status !== 200);
    add({
      id: 'rui-index',
      title: 'Remote UI page and assets',
      result: broken.length ? 'fail' : 'pass',
      detail: broken.length ? `Broken: ${broken.join(', ')}` : `index.html and all ${assets.length} scripts/stylesheets load (${index.ms} ms for the page)`,
      ms: index.ms,
    });
    const modelIdx = assets.findIndex((p) => p.startsWith('/JS_MDL/model.js'));
    if (modelIdx >= 0 && !results[modelIdx].error) {
      const model = parseRemoteUiModel(results[modelIdx].value.body.toString('utf8'));
      add({ id: 'rui-state', title: 'Remote UI status', result: model.busyState === '0' ? 'pass' : model.busyState === '3' || model.busyState === '4' ? 'fail' : 'info', detail: `${model.busyStateText} (code ${model.busyState}, message ${model.errorMessageId}). Admin password ${model.vars.g_password_enable ? 'is enabled' : 'is not set'}; connection ${model.vars.g_network_mode ?? 'unknown'}.` });
      if (model.busyState === '8') {
        add({ id: 'rui-tls', title: 'Remote UI TLS', result: 'warn', detail: 'The printer is still generating its TLS certificate. The Remote UI shows a "Preparing SSL/TLS" message until it finishes; wait a few minutes and reload.' });
      }
    }
  }

  const t = await tlsCheck(host);
  if (!t.ok) {
    add({ id: 'https', title: 'HTTPS certificate', result: 'warn', detail: `TLS failed: ${t.error}` });
  } else {
    const san = t.cert.subjectaltname ?? '';
    const ipMatches = san.includes(`IP Address:${host}`) || t.cert.subject?.CN === host;
    const notAfter = new Date(t.cert.valid_to);
    const expired = notAfter < new Date();
    add({
      id: 'https',
      title: 'HTTPS certificate',
      result: expired || !ipMatches ? 'warn' : 'pass',
      detail: [
        `${t.protocol}, self-signed by ${t.cert.issuer?.CN ?? 'unknown'}, valid ${t.cert.valid_from} to ${t.cert.valid_to}.`,
        ipMatches ? `Issued for ${host}.` : `Issued for ${san || t.cert.subject?.CN}, not for ${host}: browsers will show a name mismatch. The IP probably changed since the certificate was made; regenerate it from the printer or reserve the IP in your router.`,
        expired ? 'The certificate has expired.' : '',
        'Browsers warn on self-signed certificates; use http:// or accept the warning once.',
      ].filter(Boolean).join(' '),
      ms: t.ms,
    });
  }

  // macOS side: is there a print queue for this printer, and is it paused or holding jobs?
  try {
    const { stdout: devices } = await run('/usr/bin/lpstat', ['-v']);
    const { stdout: printers } = await run('/usr/bin/lpstat', ['-p']).catch(() => ({ stdout: '' }));
    const lines = devices.split('\n').filter((l) => /canon|g5000|g5040/i.test(l) || l.includes(host));
    if (!lines.length) {
      add({ id: 'mac-queue', title: 'macOS print queue', result: 'info', detail: 'No macOS print queue points at this printer. Add it in System Settings > Printers & Scanners (choose the AirPrint driver).' });
    } else {
      const queueNames = lines.map((l) => /device for ([^:]+):/.exec(l)?.[1]).filter(Boolean);
      const states = queueNames.map((q) => printers.split('\n').find((l) => l.startsWith(`printer ${q} `)) ?? `printer ${q}: state unknown`);
      const disabled = states.filter((s) => /disabled/.test(s));
      const { stdout: pending } = await run('/usr/bin/lpstat', ['-o', ...queueNames]).catch(() => ({ stdout: '' }));
      const pendingCount = pending.trim() ? pending.trim().split('\n').length : 0;
      add({
        id: 'mac-queue',
        title: 'macOS print queue',
        result: disabled.length ? 'fail' : pendingCount ? 'warn' : 'pass',
        detail: `${states.join('; ')}.${disabled.length ? ' The queue is paused: resume it in Printers & Scanners or run `cupsenable <queue>`.' : ''}${pendingCount ? ` ${pendingCount} job(s) waiting on this Mac.` : ' No jobs waiting on this Mac.'}`,
      });
    }
  } catch (e) {
    add({ id: 'mac-queue', title: 'macOS print queue', result: 'info', detail: `Could not read CUPS state: ${e.message}` });
  }

  return { host, checks, ranAt: new Date().toISOString() };
}
