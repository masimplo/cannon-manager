// The status the printer's own Remote UI publishes in JS_MDL/model.js, and plain HTTP
// fetches from its built-in web server.

import http from 'node:http';

// From the Remote UI's own top.js (dispPrintInfo) and LANG/messID.js (English strings).
const BUSY_STATES = {
  0: 'Ready to print',
  1: 'The printer is executing another task.',
  2: 'The printer is in operation.',
  3: 'An error has occurred.',
  4: 'Check the printer',
  5: 'Cleaning in progress',
  6: 'Test printing in progress',
  // 7 maps to MES0604, which this firmware's English string table does not define.
  8: 'Preparing SSL/TLS. Please wait a while and try loading again.',
};

/** Parse the `var g_x = ...;` assignments in the Remote UI's model.js. */
export function parseRemoteUiModel(source) {
  const vars = {};
  const re = /var\s+(g_[A-Za-z0-9_]+)\s*=\s*('([^']*)'|(-?\d+))\s*;/g;
  for (const m of source.matchAll(re)) {
    vars[m[1]] = m[3] !== undefined ? m[3] : Number(m[4]);
  }
  const busyState = vars.g_bst_st !== undefined ? String(vars.g_bst_st) : null;
  return {
    vars,
    busyState,
    busyStateText: busyState === null ? null : (BUSY_STATES[busyState] ?? `Unknown state (${busyState})`),
    errorMessageId: vars.g_err_msg_id ?? null,
  };
}

/** Fetch a path from the printer's built-in web server. */
export function fetchPrinterHttp(host, path, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.get({ host, port: 80, path, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ms: Date.now() - started }));
    });
    req.on('timeout', () => req.destroy(new Error(`HTTP ${path} timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
  });
}

export async function getRemoteUiStatus(host) {
  const res = await fetchPrinterHttp(host, '/JS_MDL/model.js');
  if (res.status !== 200) throw new Error(`Remote UI model.js returned HTTP ${res.status}`);
  return parseRemoteUiModel(res.body.toString('utf8'));
}
